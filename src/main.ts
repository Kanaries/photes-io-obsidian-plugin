import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { normalizePath, Plugin, requestUrl, TFolder, Notice, TFile, MarkdownView, Menu, setIcon } from "obsidian";
import { OBSIDIAN_CALLBACK_ACTION, PixnoAuthorization } from "./authorization";
import { createPixnoReadClient, notebookMarkdown, pixnoOrigin, PixnoError } from "./service";
import { PixnoSettingsTab } from "./settings";

import { imageExtension, prepareUpload } from "./images";
import { imageActionExtension, imageEmbeds, captureAnchor, insertAtAnchor, type ImageEmbed, type ImageAnchor } from "./image-actions";
import { defaults, vaultFolder, digest, replaceSyncedContent, type Preferences, type SyncRecord } from "./sync-state";
import { MobileUploadModal } from "./mobile";
import type { EditorView } from "@codemirror/view";



export default class PixnoPlugin extends Plugin {
	private client = createPixnoReadClient(async options => {
        const response = await requestUrl({ ...options, throw: false });
        let json: unknown;
        try { json = response.json; } catch { json = null; }
        return { status: response.status, json, arrayBuffer: response.arrayBuffer };
    });
    preferences: Preferences = { ...defaults };
    private syncRecords: Record<string, SyncRecord> = {};
    private syncing = false;
    private syncOffset = 0;
    private mobileModal?: MobileUploadModal;
    private pendingMobileLogins = new Map<number, { hash: string; until: number; modal: MobileUploadModal }>();
    private mobileSyncing = false;
    private stopped = false;
    private mobileOffset = 0;
    private mobileFailures = new Set<number>();
    private originKey = "";
    private importing = false;
    private generating = false;
	private authorization!: PixnoAuthorization;
	private authTab!: PixnoSettingsTab;
	private settingsWrite = Promise.resolve();
	private pendingRotations = new Set<string>();
	readonly integrationsUrl = `${pixnoOrigin()}/account/integrations`;

	async onload() {
        this.stopped = false;
		const previous = await this.loadData();
		// Keep environment-specific sessions isolated in the same test vault.
		const origin = pixnoOrigin();
		const originKey = bytesToHex(sha256(origin).subarray(0, 16));
        this.originKey = originKey;
        if (previous?.preferences || previous?.imagePath || previous?.syncPath) {
            const storedPreferences = previous.preferences ?? previous;
            this.preferences.autoSync = previous.preferences?.autoSync === true;
            for (const field of ["imagePath", "syncPath"] as const) {
                try { this.preferences[field] = vaultFolder(storedPreferences[field]); } catch { /* Use safe defaults. */ }
            }
        }
        if (previous?.syncOrigin === originKey && previous?.syncRecords && typeof previous.syncRecords === "object") {
            for (const [id, value] of Object.entries(previous.syncRecords)) {
                const record = value as SyncRecord;
                if (!/^[1-9]\d*$/.test(id) || !record || typeof record.path !== "string" || !/^[a-f0-9]{64}$/.test(record.digest) || typeof record.revision !== "string") continue;
                try { vaultFolder(record.path); } catch { continue; }
                if (record.block !== undefined && record.block !== id) continue;
                this.syncRecords[id] = record;
            }
        }
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
        this.addRibbonIcon("camera", "Generate Pixno note from image", event => { const menu = new Menu();
            menu.addItem(item => item.setTitle("Choose image").setIcon("image").onClick(() => this.pickImage()));
            menu.addItem(item => item.setTitle("Upload from phone").setIcon("qr-code").onClick(() => { void this.uploadFromPhone(); }));
            menu.showAtMouseEvent(event);
        });
        this.addCommand({ id: "generate-image-note", name: "Generate note from image", callback: () => this.pickImage() });
        this.addCommand({ id: "sync-notes", name: "Sync notes", callback: () => { void this.syncNotes(true); } });
        this.addCommand({ id: "upload-image-from-mobile", name: "Upload image from mobile", callback: () => { void this.uploadFromPhone(); } });
        this.registerInterval(window.setInterval(() => { void this.syncMobileNotes(); }, 10_000));
        this.registerInterval(window.setInterval(() => { if (this.preferences.autoSync) void this.syncNotes(); }, 60_000));
        this.registerEditorExtension(imageActionExtension((view, image) => this.generateEditorImage(view, image)));
        this.registerMarkdownPostProcessor((element, context) => {
            const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
            if (!(file instanceof TFile)) return;
            for (const img of Array.from(element.querySelectorAll("img"))) {
                const section = context.getSectionInfo(img);
                if (!section) continue;
                const candidates = imageEmbeds(section.text).filter(image => {
                    const line = section.text.slice(0, image.from).split("\n").length - 1;
                    return line >= section.lineStart && line <= section.lineEnd;
                });
                const source = img.closest(".internal-embed")?.getAttribute("src") ?? img.getAttribute("src");
                const matches = candidates.filter(image => image.source === source || image.markup.includes(source ?? "\0"));
                const image = matches.length === 1 ? matches[0] : candidates.length === 1 ? candidates[0] : null;
                if (!image) continue;
                const button = document.createElement("button");
                button.className = "photes-button"; button.title = "Generate note from this image";
                button.setAttribute("aria-label", button.title); setIcon(button, "sparkles");
                button.addEventListener("click", () => { void this.generateEmbeddedImage(file, image, captureAnchor(section.text, image.to)); });
                img.insertAdjacentElement("afterend", button);
                img.addEventListener("contextmenu", event => {
                    event.preventDefault();
                    const menu = new Menu();
                    menu.addItem(item => item.setTitle("Generate note").setIcon("sparkles").setDisabled(this.generating)
                        .onClick(() => { void this.generateEmbeddedImage(file, image, captureAnchor(section.text, image.to)); }));
                    menu.showAtMouseEvent(event);
                });
            }
        });
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
            if (!(view instanceof MarkdownView) || !view.file) return;
            const text = editor.getValue();
            const offset = editor.posToOffset(editor.getCursor());
            const line = editor.getCursor().line;
            const image = imageEmbeds(text).find(image => (offset >= image.from && offset <= image.to)
                || text.slice(0, image.from).split("\n").length - 1 === line);
            if (!image) return;
            const file = view.file;
            menu.addItem(item => item.setTitle("Generate note from image").setIcon("sparkles").setDisabled(this.generating)
                .onClick(() => { void this.generateEmbeddedImage(file, image, captureAnchor(text, image.to)); }));
        }));
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
		const snapshot = { version: 4, pendingRotations, preferences: { ...this.preferences }, syncOrigin: this.originKey, syncRecords: { ...this.syncRecords } };
		const stored = this.settingsWrite.then(() => this.saveData(snapshot));
		this.settingsWrite = stored.catch(() => {});
		return stored;
	}

	onunload() { this.stopped = true; this.pendingMobileLogins.clear(); this.mobileModal?.close(); this.authorization?.stop(); }

	get waiting() { return this.authorization.waiting; }
	get hasSession() { return this.authorization.hasSession; }
	get needsLogin() { return this.authorization.needsLogin; }

	beginLogin() {
		this.pendingMobileLogins.clear();
        this.mobileModal?.close();
        this.preferences.autoSync = false;
        this.syncRecords = {};
        window.open(this.authorization.beginLogin(), "_blank", "noopener,noreferrer");
	}

	async logout() {
        this.mobileModal?.close();
        this.pendingMobileLogins.clear();
        this.mobileModal?.close();
        this.preferences.autoSync = false;
        this.syncRecords = {};
        try { await this.authorization.logout(); } finally { await this.writeSettings(); }
    }

    async savePreferences(change: Partial<Preferences>) {
        const next = { ...this.preferences, ...change };
        next.imagePath = vaultFolder(next.imagePath);
        next.syncPath = vaultFolder(next.syncPath);
        this.preferences = next;
        await this.writeSettings();
        if (next.autoSync) void this.syncNotes();
    }

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
        if (!entry) {
            const parent = path.split("/").slice(0, -1).join("/");
            if (parent) await this.ensureFolder(parent);
            await this.app.vault.createFolder(path);
        }
    }

    private generationError(error: unknown) {
        return error instanceof PixnoError && error.code === "image_permission_required"
            ? "Image generation needs permission. Log out and log in again to approve it."
            : error instanceof PixnoError && error.status === 402 ? "Not enough Pixno AI credits."
            : error instanceof PixnoError && error.status === 415 ? "Choose a PNG, JPEG, WebP or GIF image."
            : error instanceof PixnoError && error.status === 413 ? "Image is too large. Choose a smaller image."
            : "Could not confirm generation or insert it at the original image. Check Pixno notebooks before trying again.";
    }

    private async generateAt(prepare: () => Promise<{ upload: Awaited<ReturnType<typeof prepareUpload>>; target: TFile; anchor: ImageAnchor }>) {
        if (this.generating) return;
        if (!this.hasSession || this.needsLogin) { new Notice("Log in to Pixno in plugin settings first."); return; }
        this.generating = true;
        const signal = this.authorization.signal;
        const notice = new Notice("Generating… Uses Pixno AI credits.", 0);
        try {
            const { upload, target, anchor } = await prepare();
            if (signal.aborted) throw new PixnoError(401);
            const key = await this.authorization.access();
            // Never replay a potentially billable request automatically.
            const result = await this.client.generate(key, upload.bytes, upload.contentType, signal);
            if (signal.aborted) throw new PixnoError(401);
            await this.app.vault.process(target, text => {
                if (signal.aborted) throw new PixnoError(401);
                return insertAtAnchor(text, anchor, `\n\n${result.content}\n`);
            });
            new Notice("Note generated.");
        } catch (error) { new Notice(this.generationError(error)); }
        finally { notice.hide(); this.generating = false; }
    }

    private async generateEditorImage(view: EditorView, image: ImageEmbed) {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!active?.file || (active.editor as unknown as { cm: EditorView }).cm !== view) return;
        try { await this.generateEmbeddedImage(active.file, image, captureAnchor(view.state.doc.toString(), image.to)); }
        catch { new Notice("The image position changed. Select the image again."); }
    }

    private async generateEmbeddedImage(target: TFile, image: ImageEmbed, anchor: ImageAnchor) {
        return this.generateAt(async () => {
            let bytes: ArrayBuffer;
            const local = this.app.metadataCache.getFirstLinkpathDest(image.source.split("#")[0], target.path);
            if (local) bytes = await this.app.vault.readBinary(local);
            else {
                const url = new URL(image.source);
                if (url.protocol !== "https:" || url.username || url.password) throw new PixnoError(415);
                const response = await requestUrl({ url: url.href, throw: false });
                if (response.status !== 200) throw new PixnoError(502);
                bytes = response.arrayBuffer;
            }
            if (bytes.byteLength > 20 * 1024 * 1024) throw new PixnoError(413);
            const extension = imageExtension(bytes);
            const file = new File([bytes], `image.${extension}`, { type: extension === "jpg" ? "image/jpeg" : `image/${extension}` });
            return { upload: await prepareUpload(file), target, anchor };
        });
    }

    pickImage() {
        if (this.generating) return;
        if (!this.hasSession || this.needsLogin) { new Notice("Log in to Pixno in plugin settings first."); return; }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) { new Notice("Open a Markdown note before adding an image."); return; }
        const target = view.file;
        const cursor = captureAnchor(view.editor.getValue(), view.editor.posToOffset(view.editor.getCursor()));
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg,image/webp,image/gif";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            void this.generateAt(async () => {
                const upload = await prepareUpload(file);
                await this.ensureFolder(this.preferences.imagePath);
                const asset = `${this.preferences.imagePath}/image-${crypto.randomUUID()}.${imageExtension(upload.bytes)}`;
                await this.app.vault.createBinary(asset, upload.bytes);
                const embed = `\n![[${asset}]]`;
                let anchor: ImageAnchor | undefined;
                await this.app.vault.process(target, text => {
                    const next = insertAtAnchor(text, cursor, embed);
                    anchor = captureAnchor(next, next.indexOf(embed) + embed.length);
                    return next;
                });
                return { upload, target, anchor: anchor! };
            });
        };
        input.click();
    }

    private async importWithImages(id: number, record?: SyncRecord, revision = "") {
		const signal = this.authorization.signal;
		const data = await this.read((key, current) => this.client.download(key, id, current));
		if (signal.aborted) throw new PixnoError(401);

		const vault = this.app.vault;
		const path = record?.path ?? normalizePath(`${this.preferences.syncPath}/notebook-${id}.md`);
		if (!record && vault.getAbstractFileByPath(path)) throw new PixnoError(409);
		await this.ensureFolder(this.preferences.syncPath);
		if (signal.aborted) throw new PixnoError(401);
		if (!record && vault.getAbstractFileByPath(path)) throw new PixnoError(409);
		const imageLinks = new Map<number, string>();
        const assets: { path: string; bytes: ArrayBuffer }[] = [];
        let totalBytes = 0;
        if (data.imageNoteIds.length > 50) throw new PixnoError(413);
        const assetFolder = `${this.preferences.imagePath}/notebook-${id}-images`;
        // Complete downloads before writing any attachments or Markdown.
        for (const noteId of data.imageNoteIds) {
            const bytes = await this.read((key, current) => this.client.image(key, noteId, current));
            if (signal.aborted) throw new PixnoError(401);
            totalBytes += bytes.byteLength;
            if (totalBytes > 50 * 1024 * 1024) throw new PixnoError(413);
            const asset = `${assetFolder}/note-${noteId}-${bytesToHex(sha256(new Uint8Array(bytes)))}.${imageExtension(bytes)}`;
            assets.push({ path: asset, bytes });
            imageLinks.set(noteId, asset);
        }
        let markdownWritten = false;
        const created: { file: import("obsidian").TFile; digest: string }[] = [];
        try {
            if (assets.length) await this.ensureFolder(assetFolder);
            for (const asset of assets) {
                if (signal.aborted) throw new PixnoError(401);
                const expected = bytesToHex(sha256(new Uint8Array(asset.bytes)));
                const existing = vault.getAbstractFileByPath(asset.path);
                if (existing) {
                    if (!(existing instanceof TFile) || bytesToHex(sha256(new Uint8Array(await vault.readBinary(existing)))) !== expected) throw new PixnoError(409);
                } else {
                    const file = await vault.createBinary(asset.path, asset.bytes);
                    created.push({ file, digest: expected });
                }
            }
            if (signal.aborted) throw new PixnoError(401);
            const markdown = notebookMarkdown(data, imageLinks);
            if (record) {
                const file = vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile)) throw new PixnoError(409);
                await vault.process(file, text => {
                    if (signal.aborted) throw new PixnoError(401);
                    return replaceSyncedContent(text, record, markdown);
                });
            } else await vault.create(path, markdown);
            markdownWritten = true;
            if (signal.aborted) throw new PixnoError(401);
            this.syncRecords[String(id)] = { path, digest: digest(markdown), revision, ...(record?.block ? { block: record.block } : {}) };
            await this.writeSettings();
            if (record?.block && record.digest !== digest(markdown) && data.notes.some(note => note.trim())) {
                new Notice("Photos and notes received from your phone.");
            }
        } catch (error) {
            for (const { file, digest } of markdownWritten ? [] : created) {
                try {
                    const current = await vault.readBinary(file);
                    if (bytesToHex(sha256(new Uint8Array(current))) === digest) await vault.delete(file);
                } catch { /* Preserve files whose contents cannot be confirmed. */ }
            }
            throw error;
        }
		return path;
	}

    async syncNotes(manual = false) {
        if (this.syncing || this.importing || !this.hasSession || this.needsLogin) return;
        this.syncing = true;
        const signal = this.authorization.signal;
        try {
            const notebooks = await this.listNotebooks();
            // Bound each polling round; rotate so large accounts continue on the next round.
            const count = manual ? notebooks.length : Math.min(15, notebooks.length);
            let conflicts = 0;
            for (let i = 0; i < count; i++) {
                if (signal.aborted) throw new PixnoError(401);
                const notebook = notebooks[this.syncOffset % notebooks.length];
                try { await this.syncNotebook(notebook.id); }
                catch (error) {
                    if (error instanceof PixnoError && [401, 429, 503].includes(error.status)) throw error;
                    conflicts++;
                }
                this.syncOffset = (this.syncOffset + 1) % notebooks.length;
            }

            if (manual) new Notice(conflicts ? `Sync completed with ${conflicts} files needing review. Local files were preserved.` : "Sync completed.");
        } catch (error) {
            if (manual) new Notice(error instanceof PixnoError && error.status === 429
                ? "Sync paused by the request limit. Try again in a minute."
                : "Sync paused. Local edits are preserved; move an edited copy out of the sync path before importing again.");
        } finally { this.syncing = false; }
    }

    private async syncNotebook(id: number) {
        if (this.importing) return;
        this.importing = true;
        const lifetime = this.authorization.signal;
        try {
            const revision = await this.read((key, signal) => this.client.revision(key, id, signal));
            if (lifetime.aborted) throw new PixnoError(401);
            const record = this.syncRecords[String(id)];
            if (record?.revision === revision) return;
            await this.importWithImages(id, record, revision);
        } finally { this.importing = false; }
    }

    private trackMobileLogin(id: number, url: string, modal: MobileUploadModal) {
        const token = new URL(url).hash.slice(1);
        this.pendingMobileLogins.set(id, { hash: digest(token), until: Date.now() + 240_000, modal });
    }

    private async syncMobileNotes() {
        if (this.stopped || this.mobileSyncing || !this.hasSession || this.needsLogin) return;
        this.mobileSyncing = true;
        const signal = this.authorization.signal;
        try {
            for (const [id, pending] of this.pendingMobileLogins) {
                if (signal.aborted) return;
                if (Date.now() > pending.until) { this.pendingMobileLogins.delete(id); continue; }
                try {
                    const connected = await this.read((key, current) => this.client.mobileStatus(key, pending.hash, current));
                    if (signal.aborted) return;
                    // A refreshed QR must not be closed by an older in-flight response.
                    if (connected && this.pendingMobileLogins.get(id) === pending) {
                        this.pendingMobileLogins.delete(id);
                        pending.modal.close();
                    }
                } catch { /* Retry confirmation without blocking note delivery. */ }
            }
            const ids = Object.entries(this.syncRecords).filter(([, record]) => record.block).map(([id]) => Number(id));
            // Bound background work and rotate through all phone notebooks, even with Auto Sync off.
            for (let i = 0; i < Math.min(3, ids.length); i++) {
                if (signal.aborted) return;
                const id = ids[this.mobileOffset % ids.length];
                this.mobileOffset = (this.mobileOffset + 1) % ids.length;
                try { await this.syncNotebook(id); this.mobileFailures.delete(id); }
                catch {
                    if (!signal.aborted && !this.mobileFailures.has(id)) {
                        this.mobileFailures.add(id);
                        new Notice("Phone sync paused. Check your connection and local edits.");
                    }
                }
            }
        } finally { this.mobileSyncing = false; }
    }

    async uploadFromPhone() {
        if (!this.hasSession || this.needsLogin) { new Notice("Log in to Pixno in plugin settings first."); return; }
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) { new Notice("Open a Markdown note before uploading from your phone."); return; }
        const target = view.file;
        const anchor = captureAnchor(view.editor.getValue(), view.editor.posToOffset(view.editor.getCursor()));
        const signal = this.authorization.signal;
        try {
            const key = await this.authorization.access();
            const mobile = await this.client.mobile(key, signal);
            const id = mobile.notebookId;
            if (signal.aborted) throw new PixnoError(401);
            const initial = "\nWaiting for images from your phone…\n";
            await this.app.vault.process(target, text => {
                if (signal.aborted) throw new PixnoError(401);
                return insertAtAnchor(text, anchor, `\n<!-- pixno:${id}:start -->${initial}<!-- pixno:${id}:end -->\n`);
            });
            if (signal.aborted) throw new PixnoError(401);
            this.syncRecords[String(id)] = { path: target.path, digest: digest(initial), revision: "", block: String(id) };
            await this.writeSettings();
            this.mobileModal?.close();
            const modal = new MobileUploadModal(this.app, mobile.loginUrl, async () => {
                if (signal.aborted) throw new PixnoError(401);
                const access = await this.authorization.access();
                const next = await this.client.mobile(access, signal, id);
                this.trackMobileLogin(id, next.loginUrl, modal);
                return next.loginUrl;
            });
            this.mobileModal = modal;
            this.trackMobileLogin(id, mobile.loginUrl, modal);
            modal.open();
            void this.syncMobileNotes();
        } catch (error) { new Notice(error instanceof PixnoError && error.code === "mobile_permission_required"
            ? "Log out and log in again to allow phone sign-in."
            : "Could not create the login QR. Wait a moment and try again."); }
    }
}
