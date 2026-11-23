import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { normalizePath, Plugin, requestUrl, TFolder, Notice } from "obsidian";
import { OBSIDIAN_CALLBACK_ACTION, PixnoAuthorization } from "./authorization";
import { createPixnoReadClient, notebookMarkdown, pixnoOrigin, PixnoError } from "./service";
import { PixnoSettingsTab } from "./settings";

import { imageExtension, prepareUpload } from "./images";

const IMPORT_FOLDER = "Pixno Imports";

export default class PixnoPlugin extends Plugin {
	private client = createPixnoReadClient(async options => {
        const response = await requestUrl({ ...options, throw: false });
        let json: unknown;
        try { json = response.json; } catch { json = null; }
        return { status: response.status, json, arrayBuffer: response.arrayBuffer };
    });
    private importing = false;
    private generating = false;
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
        this.addRibbonIcon("camera", "Generate Pixno note from image", () => this.pickImage());
        this.addCommand({ id: "generate-image-note", name: "Generate note from image", callback: () => this.pickImage() });
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
        if (this.importing) throw new PixnoError(409);
        this.importing = true;
        try { return await this.importWithImages(id); }
        finally { this.importing = false; }
    }

    private async ensureFolder(path: string) {
        const entry = this.app.vault.getAbstractFileByPath(path);
        if (entry && !(entry instanceof TFolder)) throw new PixnoError(409);
        if (!entry) await this.app.vault.createFolder(path);
    }

    pickImage() {
        if (this.generating) return;
        if (!this.hasSession || this.needsLogin) { new Notice("Log in to Pixno in plugin settings first."); return; }
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg,image/webp,image/gif";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file || this.generating) return;
            this.generating = true;
            const activeFile = this.app.workspace.getActiveFile();
            const target = activeFile?.extension === "md" ? activeFile : null;
            const notice = new Notice("Generating image note with GPT-5.4 mini. Uses Pixno AI credits (minimum 4).", 0);
            try {
                const upload = await prepareUpload(file);
                const signal = this.authorization.signal;
                const key = await this.authorization.access();
                // A paid request is never replayed automatically, even after uncertain completion.
                const result = await this.client.generate(key, upload.bytes, upload.contentType, signal);
                if (signal.aborted) throw new PixnoError(401);
                await this.ensureFolder(IMPORT_FOLDER);
                if (signal.aborted) throw new PixnoError(401);
                const suffix = `${result.notebookId}-${Date.now()}`;
                const asset = `${IMPORT_FOLDER}/image-${suffix}.${imageExtension(upload.bytes)}`;
                await this.app.vault.createBinary(asset, upload.bytes);
                if (signal.aborted) throw new PixnoError(401);
                const addition = `![[${asset}]]\n\n${result.content}\n`;
                if (target) {
                    await this.app.vault.process(target, text => {
                        if (signal.aborted) throw new PixnoError(401);
                        return `${text}\n\n${addition}`;
                    });
                } else {
                    const note = await this.app.vault.create(`${IMPORT_FOLDER}/image-note-${suffix}.md`, addition);
                    await this.app.workspace.getLeaf(false).openFile(note);
                }
                new Notice("Image note saved in Obsidian and Pixno.");
            } catch (error) {
                new Notice(error instanceof PixnoError && error.code === "image_permission_required"
                    ? "Image generation needs permission. Log out and log in again to approve it."
                    : error instanceof PixnoError && error.status === 402 ? "Not enough Pixno AI credits."
                    : error instanceof PixnoError && error.status === 415 ? "Choose a PNG, JPEG, WebP or GIF image."
                    : error instanceof PixnoError && error.status === 413 ? "Image is too large. Choose a smaller image."
                    : "Could not confirm generation or local save. Check Pixno notebooks before trying again.");
            } finally { notice.hide(); this.generating = false; }
        };
        input.click();
    }

    private async importWithImages(id: number) {
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
		const imageLinks: string[] = [];
        const assets: { path: string; bytes: ArrayBuffer }[] = [];
        let totalBytes = 0;
        if (data.imageNoteIds.length > 50) throw new PixnoError(413);
        const assetFolder = `${IMPORT_FOLDER}/notebook-${id}-images-${crypto.randomUUID()}`;
        // Complete downloads before writing any attachments or Markdown.
        for (const noteId of data.imageNoteIds) {
            const bytes = await this.read((key, current) => this.client.image(key, noteId, current));
            if (signal.aborted) throw new PixnoError(401);
            totalBytes += bytes.byteLength;
            if (totalBytes > 50 * 1024 * 1024) throw new PixnoError(413);
            const asset = `${assetFolder}/note-${noteId}.${imageExtension(bytes)}`;
            assets.push({ path: asset, bytes });
            imageLinks.push(`![[${asset}]]`);
        }
        const created: { file: import("obsidian").TFile; digest: string }[] = [];
        try {
            if (assets.length) await this.ensureFolder(assetFolder);
            for (const asset of assets) {
                if (signal.aborted) throw new PixnoError(401);
                const file = await vault.createBinary(asset.path, asset.bytes);
                created.push({ file, digest: bytesToHex(sha256(new Uint8Array(asset.bytes))) });
            }
            if (signal.aborted) throw new PixnoError(401);
            await vault.create(path, notebookMarkdown(data) + (imageLinks.length ? "\n## Source images\n\n" + imageLinks.join("\n\n") + "\n" : ""));
        } catch (error) {
            for (const { file, digest } of created) {
                try {
                    const current = await vault.readBinary(file);
                    if (bytesToHex(sha256(new Uint8Array(current))) === digest) await vault.delete(file);
                } catch { /* Preserve files whose contents cannot be confirmed. */ }
            }
            throw error;
        }
		return path;
	}
}
