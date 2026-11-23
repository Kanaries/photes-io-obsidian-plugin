import { App, Modal } from "obsidian";
import { toCanvas } from "qrcode";

export class MobileUploadModal extends Modal {
    private closed = false;
    constructor(app: App, private url: string, private poll: () => Promise<void>) { super(app); }
    onOpen() {
        this.contentEl.createEl("h2", { text: "Upload images from your phone" });
        this.contentEl.createEl("p", { text: "Scan with your phone, sign in to the same Pixno account, then upload or take photos. Generated notes and images will appear in this Obsidian note. Keep this window open while uploading." });
        const canvas = this.contentEl.createEl("canvas");
        void toCanvas(canvas, this.url, { width: 260, margin: 2 }).catch(() => {
            this.contentEl.createEl("p", { text: "Use the notebook link below if the QR cannot be displayed." });
        });
        this.contentEl.createEl("a", { text: "Open the mobile notebook", href: this.url, attr: { target: "_blank", rel: "noopener noreferrer" } });
        const status = this.contentEl.createEl("p", { text: "Waiting for photos and generated notes…", attr: { role: "status" } });
        const check = async () => {
            if (this.closed) return;
            try { await this.poll(); if (!this.closed) status.setText("Connected. Checking for new notes…"); }
            catch { if (!this.closed) status.setText("Sync paused. Check your Pixno connection and local edits, then try Sync notes."); }
            if (!this.closed) this.timer = window.setTimeout(check, 10_000);
        };
        void check();
    }
    private timer: number | undefined;
    onClose() { this.closed = true; window.clearTimeout(this.timer); this.contentEl.empty(); }
}
