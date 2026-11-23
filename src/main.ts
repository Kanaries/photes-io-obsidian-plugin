import { normalizePath, Plugin, requestUrl, TFolder } from "obsidian";
import { createPixnoReadClient, isAccessKey, notebookMarkdown, pixnoOrigin, PixnoError } from "./service";
import { PixnoSettingsTab } from "./settings";

const IMPORT_FOLDER = "Pixno Imports";

export default class PixnoPlugin extends Plugin {
	private key = "";
	private expiresAt = 0;
	private client = createPixnoReadClient((options) => requestUrl({ ...options, throw: false }));
	private authorization = new AbortController();
	readonly integrationsUrl = `${pixnoOrigin()}/account/integrations`;

	async onload() {
		const previous = await this.loadData();
		// The old release stored a permanent credential and automatic sign-in settings.
		if (previous && typeof previous === "object" && ("accessToken" in previous || "autoSync" in previous)) {
			await this.saveData({ v2: true });
		}
		this.addSettingTab(new PixnoSettingsTab(this.app, this));
	}

	onunload() {
		this.disconnect();
	}

	get expiry() {
		return this.expiresAt;
	}

	async connect(rawKey: string) {
		const key = rawKey.trim();
		this.disconnect();
		if (!isAccessKey(key)) throw new PixnoError(401);
		const signal = this.authorization.signal;
		const expiresAt = await this.client.info(key, signal);
		if (signal.aborted) throw new PixnoError(401);
		this.key = key;
		this.expiresAt = expiresAt;
	}

	disconnect() {
		this.authorization.abort();
		this.authorization = new AbortController();
		this.key = "";
		this.expiresAt = 0;
	}

	private requireKey() {
		if (!this.key || Date.now() >= this.expiresAt) {
			this.disconnect();
			throw new PixnoError(401);
		}
		return this.key;
	}

	async listNotebooks() {
		const key = this.requireKey();
		return this.client.list(key, this.authorization.signal);
	}

	async importNotebook(id: number) {
		const key = this.requireKey();
		const signal = this.authorization.signal;
		const data = await this.client.download(key, id, signal);
		if (signal.aborted) throw new PixnoError(401);
		this.requireKey();

		const vault = this.app.vault;
		const path = normalizePath(`${IMPORT_FOLDER}/notebook-${id}.md`);
		if (vault.getAbstractFileByPath(path)) throw new PixnoError(409);
		const folder = vault.getAbstractFileByPath(IMPORT_FOLDER);
		if (folder && !(folder instanceof TFolder)) throw new PixnoError(409);
		if (!folder) await vault.createFolder(IMPORT_FOLDER);
		if (signal.aborted) throw new PixnoError(401);
		await vault.create(path, notebookMarkdown(data));
		return path;
	}
}
