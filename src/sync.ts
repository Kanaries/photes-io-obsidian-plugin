import { App } from "obsidian";
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
import { createQueuedProcessor } from "./helpers";

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
}

interface INote {
	content: string | null;
	created_at: string;
	generated_at: string;
	id: number;
	image: { path: string; name: string };
	notebook_id: number;
}

export async function listenSync(
	accessKey: string,
	app: App,
	plugin: PhotesIOPlugin
): Promise<{
	stop: () => void;
	startRefetch: () => void;
}> {
	const token = await getSupabaseToken(accessKey);
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

	const channel = client
		.channel("plugin")
		.on(
			"postgres_changes",
			{ schema: "public", event: "*", table: "notebooks" },
			(payload) => {
				const item = payload.new as INotebook;
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
						}
						// note is being created, so don't need to download the content
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
			if (e === "SUBSCRIBED" && plugin.settings.syncTimestamp) {
				startRefetch();
			}
		});

	return {
		stop: () => {
			channel.unsubscribe();
		},
		startRefetch,
	};
}
