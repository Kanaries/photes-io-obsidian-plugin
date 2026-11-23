import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { normalizePath, Plugin, requestUrl, TFolder } from "obsidian";
import { OBSIDIAN_CALLBACK_ACTION, PixnoAuthorization } from "./authorization";
import { createPixnoReadClient, notebookMarkdown, pixnoOrigin, PixnoError } from "./service";
import { PixnoSettingsTab } from "./settings";

const IMPORT_FOLDER = "Pixno Imports";

export default class PixnoPlugin extends Plugin {
	private client = createPixnoReadClient((options) => requestUrl({ ...options, throw: false }));
	private authorization!: PixnoAuthorization;
	private authTab!: PixnoSettingsTab;
	private settingsWrite = Promise.resolve();
	private pendingRotations = new Set<string>();
	readonly integrationsUrl = `${pixnoOrigin()}/account/integrations`;

	async onload() {
		const previous = await this.loadData();
		// Keep environment-specific sessions isolated in the same test vault.
		const origin = pixnoOrigin();
		const originKey = bytesToHex(sha256(origin).subarray(0, 16));
		const secretId = `pixno-refresh-${originKey}`;
		if (Array.isArray(previous?.pendingRotations)) {
			this.pendingRotations = new Set(previous.pendingRotations.filter((key: unknown): key is string =>
				typeof key === "string" && /^[a-f0-9]{32}$/.test(key)));
		}
		this.authorization = new PixnoAuthorization(this.client, {
			readSecret: () => this.app.secretStorage.getSecret(secretId),
			writeSecret: value => this.app.secretStorage.setSecret(secretId, value),
			writeRotationPending: value => {
				if (value) this.pendingRotations.add(originKey);
				else this.pendingRotations.delete(originKey);
				return this.writeSettings();
			},
		}, this.pendingRotations.has(originKey), origin);

		if (previous && typeof previous === "object" && ("accessToken" in previous || "autoSync" in previous)) {
			await this.writeSettings();
		}
		this.authTab = new PixnoSettingsTab(this.app, this);
		this.addSettingTab(this.authTab);
		this.registerObsidianProtocolHandler(OBSIDIAN_CALLBACK_ACTION, async params => {
			const signal = this.authorization.signal;
			try {
				if (await this.authorization.completeLogin(params)) this.authTab.authorizationChanged("Connected to Pixno.");
			} catch (error) {
				if (signal.aborted) return;
				this.authTab.authorizationChanged(error instanceof PixnoError && error.status === 409
					? "Revoke an existing Obsidian session in Pixno Integrations before connecting."
					: "Pixno login could not be completed. Start a new login.");
			}
		});
		if (this.authorization.hasSession && !this.authorization.needsLogin) {
			const signal = this.authorization.signal;
			void this.authorization.access().then(
				() => { if (!signal.aborted) this.authTab.authorizationChanged("Connected to Pixno."); },
				() => { if (!signal.aborted) this.authTab.authorizationChanged("Could not restore the Pixno session."); },
			);
		}
	}

	private writeSettings() {
		const pendingRotations = [...this.pendingRotations];
		const stored = this.settingsWrite.then(() => this.saveData({ version: 3, pendingRotations }));
		this.settingsWrite = stored.catch(() => {});
		return stored;
	}

	onunload() { this.authorization?.stop(); }

	get waiting() { return this.authorization.waiting; }
	get hasSession() { return this.authorization.hasSession; }
	get needsLogin() { return this.authorization.needsLogin; }

	beginLogin() {
		window.open(this.authorization.beginLogin(), "_blank", "noopener,noreferrer");
	}

	logout() { return this.authorization.logout(); }

	private async read<T>(operation: (key: string, signal: AbortSignal) => Promise<T>) {
		const signal = this.authorization.signal;
		const key = await this.authorization.access();
		if (signal.aborted) throw new PixnoError(401);
		try {
			return await operation(key, signal);
		} catch (error) {
			if (!(error instanceof PixnoError) || error.status !== 401 || signal.aborted) throw error;
			this.authorization.invalidateAccess(key);
			const newKey = await this.authorization.access();
			if (signal.aborted) throw new PixnoError(401);
			return operation(newKey, signal);
		}
	}

	async listNotebooks() {
		return this.read((key, signal) => this.client.list(key, signal));
	}

	async importNotebook(id: number) {
		const signal = this.authorization.signal;
		const data = await this.read((key, current) => this.client.download(key, id, current));
		if (signal.aborted) throw new PixnoError(401);

		const vault = this.app.vault;
		const path = normalizePath(`${IMPORT_FOLDER}/notebook-${id}.md`);
		if (vault.getAbstractFileByPath(path)) throw new PixnoError(409);
		const folder = vault.getAbstractFileByPath(IMPORT_FOLDER);
		if (folder && !(folder instanceof TFolder)) throw new PixnoError(409);
		if (!folder) await vault.createFolder(IMPORT_FOLDER);
		if (signal.aborted) throw new PixnoError(401);
		if (vault.getAbstractFileByPath(path)) throw new PixnoError(409);
		await vault.create(path, notebookMarkdown(data));
		return path;
	}
}
