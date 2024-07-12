import { App, TFile, normalizePath, requestUrl } from "obsidian";
import {
	downloadAssets,
	getNotebookDownloadURL,
	getSupabaseToken,
	removeNotebook,
	startSync,
} from "./service";
import { createClient } from "@supabase/supabase-js";
import type PhotesIOPlugin from "./main";
import { DEFAULT_SYNC_PATH } from "./const";
import { createQueuedProcessor, noteToMarkdown } from "./helpers";
import { jwtDecode } from "jwt-decode";

const SUPABASE_URL = "https://psdgfelmelrmwkbhjlza.supabase.co";
const SUPABASE_KEY =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzZGdmZWxtZWxybXdrYmhqbHphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTYxOTkyOTEsImV4cCI6MjAzMTc3NTI5MX0.K3t0969cHOgxd9KMl7kE-bRf1wIVAcZgxbUO6-1taz4";
const client = createClient(SUPABASE_URL, SUPABASE_KEY);

interface INotebook {
	content: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	id: number;
	note_orders: number[] | null;
	title: string;
	source: string | null;
}

interface INote {
	content: string | null;
	created_at: string;
	generated_at: string;
	id: number;
	image: { path: string; name: string };
	notebook_id: number;
	source: string | null;
}

export async function listenSync(
	accessKey: string,
	app: App,
	plugin: PhotesIOPlugin
): Promise<{
	stop: () => void;
	startRefetch: () => void;
	getLastStatus: () =>
		| "SUBSCRIBED"
		| "TIMED_OUT"
		| "CLOSED"
		| "CHANNEL_ERROR";
}> {
	const token = await getSupabaseToken(accessKey);
	const decoded = jwtDecode(token);
	const user_id = decoded.sub;

	client.realtime.setAuth(token);
	const reportSync = async (syncTimestamp: number) => {
		plugin.settings.lastSyncedTime = Date.now();
		plugin.settings.syncTimestamp = syncTimestamp;
		await plugin.saveSettings();
	};
	const startRefetch = () => {
		startSync(
			accessKey,
			app,
			plugin.settings.syncPath || DEFAULT_SYNC_PATH,
			(x) => {
				plugin.showSyncStatus(x);
				plugin.tab.syncingInfo = x;
				plugin.tab.display();
			},
			plugin.settings.syncTimestamp
		).then(({ syncTimestamp }) => {
			plugin.settings.lastSyncedTime = Date.now();
			plugin.settings.syncTimestamp = syncTimestamp;
			plugin.tab.syncingInfo = "";
			plugin.showSyncStatus("");
			plugin.tab.display();
			return plugin.saveSettings();
		});
	};

	const updateNotebook = createQueuedProcessor(
		async ({
			notebook_id,
			title = "!",
			updated_at = Date.now(),
		}: {
			notebook_id: number;
			title?: string;
			updated_at?: string | number;
		}) => {
			const download = downloadAssets(
				app,
				accessKey,
				plugin.settings.syncPath || DEFAULT_SYNC_PATH
			);
			download({
				url: getNotebookDownloadURL(notebook_id),
				dest: `${
					plugin.settings.syncPath || DEFAULT_SYNC_PATH
				}/${title}-${notebook_id}.md`,
				needAuth: true,
			}).then(() => {
				reportSync(new Date(updated_at).getTime());
			});
		},
		(x) => x.notebook_id
	);

	const realtimeNoteMap: Record<
		string,
		{
			notebook_id: number;
			image_name: string;
			image_path: string;
			template?: string;
			file?: TFile;
		}
	> = {};

	const updateNotebookRealtime = createQueuedProcessor(
		async (data: { content: string; note_id: number }) => {
			if (realtimeNoteMap[data.note_id]) {
				const item = realtimeNoteMap[data.note_id];
				const ending = `-${item.notebook_id}.md`;
				const file =
					item.file ??
					(() => {
						const fileA = app.vault
							.getFolderByPath(
								normalizePath(
									plugin.settings.syncPath ||
										DEFAULT_SYNC_PATH
								)
							)
							?.children.find((x) => x.name.endsWith(ending));
						if (fileA) {
							const file = app.vault.getFileByPath(fileA.path)!;
							item.file = file;
							return file;
						}
						return null;
					})();
				if (!file) {
					return;
				}
				if (!item.template) {
					try {
						const resp = await requestUrl({
							url: getNotebookDownloadURL(
								item.notebook_id,
								data.note_id
							),
							headers: {
								"access-key": accessKey,
							},
						});
						item.template = resp.text;
					} catch (e) {
						console.error(e);
					}
				}
				if (item.template) {
					const content = item.template.replace(
						`<!-- place-holder-note-${data.note_id} -->`,
						noteToMarkdown({
							content: data.content,
							image_name: item.image_name,
							image_path: item.image_path,
						})
					);
					await app.vault.modify(file, content);
				}
			}
		},
		(x) => x.note_id
	);

	let lastStatus: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR" =
		"CLOSED";

	const channel = client
		.channel(user_id || "plugin")
		.on(
			"broadcast",
			{
				event: "note-content",
			},
			async ({ payload }) => {
				const data = payload as {
					content: string;
					note_id: number;
					notebook_id: number;
					version: number;
					end?: boolean;
				};
				updateNotebookRealtime(data);
			}
		)
		.on(
			"postgres_changes",
			{ schema: "public", event: "*", table: "notebooks" },
			(payload) => {
				const item = payload.new as INotebook;
				if (item.source?.toLowerCase() === "obsidian") {
					return;
				}
				switch (payload.eventType) {
					case "INSERT":
					case "UPDATE": {
						if (item.deleted_at) {
							removeNotebook(
								app,
								plugin.settings.syncPath || DEFAULT_SYNC_PATH,
								item.id
							);
							break;
						}
						updateNotebook({
							notebook_id: item.id,
							title: item.title,
							updated_at: item.updated_at,
						});
						break;
					}
				}
			}
		)
		.on(
			"postgres_changes",
			{
				event: "*",
				schema: "public",
				table: "notes",
			},
			async (payload) => {
				const item = payload.new as INote;
				if (item.source?.toLowerCase() === "obsidian") {
					return;
				}
				switch (payload.eventType) {
					case "INSERT": {
						if (item.image) {
							const { path } = item.image;
							const imageURL = client.storage
								.from("images")
								.getPublicUrl(path);
							const filename = path.split("/").at(-1);
							const filePath = `${
								plugin.settings.syncPath || DEFAULT_SYNC_PATH
							}/images/${filename}`;
							const download = downloadAssets(
								app,
								accessKey,
								plugin.settings.syncPath || DEFAULT_SYNC_PATH
							);
							await download({
								url: imageURL.data.publicUrl,
								dest: filePath,
							});
							realtimeNoteMap[item.id] = {
								image_name: item.image.name,
								image_path: `./images/${filename}`,
								notebook_id: item.notebook_id,
							};
							updateNotebookRealtime({
								content: "",
								note_id: item.id,
							});
						}
						break;
					}
					case "UPDATE": {
						updateNotebook({
							notebook_id: item.notebook_id,
							updated_at: item.generated_at,
						});
						break;
					}
				}
			}
		)
		.subscribe((e) => {
			console.debug("photesio: channel status", e);
			lastStatus = e;
			if (e === "SUBSCRIBED" && plugin.settings.syncTimestamp) {
				startRefetch();
			}
		});

	return {
		stop: () => {
			channel.unsubscribe();
		},
		startRefetch,
		getLastStatus: () => lastStatus,
	};
}
