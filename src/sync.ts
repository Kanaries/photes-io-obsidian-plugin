import { App } from "obsidian";
import {
	downloadAssets,
	getNote,
	getNotebookDownloadURL,
	getSupabaseToken,
	startSync,
} from "./service";
import { createClient } from "@supabase/supabase-js";
import type PhotesIOPlugin from "./main";
import { DEFAULT_SYNC_PATH } from "./const";

const SUPABASE_URL = "https://psdgfelmelrmwkbhjlza.supabase.co";
const SUPABASE_KEY =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzZGdmZWxtZWxybXdrYmhqbHphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTYxOTkyOTEsImV4cCI6MjAzMTc3NTI5MX0.K3t0969cHOgxd9KMl7kE-bRf1wIVAcZgxbUO6-1taz4";

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
}> {
	const token = await getSupabaseToken(accessKey);
	const client = createClient(SUPABASE_URL, SUPABASE_KEY);
	client.realtime.setAuth(token);
	const reportSync = async (syncTimestamp: number) => {
		plugin.settings.lastSyncedTime = Date.now();
		plugin.settings.syncTimestamp = syncTimestamp;
		await plugin.saveSettings();
	};
	const channel = client
		.channel("plugin")
		.on(
			"postgres_changes",
			{ schema: "public", event: "*", table: "notebooks" },
			(payload) => {
				const item = payload.new as INotebook;
				switch (payload.eventType) {
					case "INSERT":
						// Do nothing because notebook is empty.
						break;
					case "UPDATE": {
						if (item.deleted_at) {
							// remove the notebook
							break;
						}
						if (item.note_orders) {
							const download = downloadAssets(
								app,
								accessKey,
								plugin.settings.syncPath || DEFAULT_SYNC_PATH
							);
							download({
								url: getNotebookDownloadURL(item.id),
								dest: `${
									plugin.settings.syncPath ||
									DEFAULT_SYNC_PATH
								}/${item.title}-${item.id}.md`,
							}).then(() => {
								reportSync(new Date(item.updated_at).getTime());
							});
						}
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
						// should be handled by notebook
						break;
					}
				}
			}
		)
		.subscribe((e) => {
			if (e === "SUBSCRIBED" && plugin.settings.syncTimestamp) {
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
					plugin.settings.syncTimestamp = syncTimestamp;
					return plugin.saveSettings();
				});
			}
		});

	return {
		stop: () => {
			channel.unsubscribe();
		},
	};
}
