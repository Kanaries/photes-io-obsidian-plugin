import { App, Modal } from "obsidian";
import { toCanvas } from "qrcode";

export class MobileUploadModal extends Modal {
    private closed = false;
    constructor(app: App, private url: string, private poll: () => Promise<void>) { super(app); }
    onOpen() {
        this.contentEl.createEl("h2", { text: "Upload images from your phone" });
        this.contentEl.createEl("p", { text: "Scan and sign in to the same Pixno account. Keep this window open." });
        const canvas = this.contentEl.createEl("canvas");
        void toCanvas(canvas, this.url, { width: 260, margin: 2 }).catch(() => {
            this.contentEl.createEl("p", { text: "QR unavailable. Use the link below." });
        });
        this.contentEl.createEl("a", { text: "Open the mobile notebook", href: this.url, attr: { target: "_blank", rel: "noopener noreferrer" } });
        const status = this.contentEl.createEl("p", { text: "Waiting for notes…", attr: { role: "status" } });
        const check = async () => {
            if (this.closed) return;
            try { await this.poll(); if (!this.closed) status.setText("Waiting for notes…"); }
            catch { if (!this.closed) status.setText("Sync paused. Check your Pixno connection and local edits, then try Sync notes."); }
            if (!this.closed) this.timer = window.setTimeout(check, 10_000);
        };
        void check();
    }
    private timer: number | undefined;
    onClose() { this.closed = true; window.clearTimeout(this.timer); this.contentEl.empty(); }
}
