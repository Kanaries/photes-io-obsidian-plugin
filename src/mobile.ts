import { App, Modal } from "obsidian";
import { toCanvas } from "qrcode";

export class MobileUploadModal extends Modal {
    private closed = false;
    private timer: number | undefined;
    private expiry: number | undefined;
    constructor(app: App, private url: string, private poll: () => Promise<void>, private refresh: () => Promise<string>) { super(app); }
    onOpen() {
        this.contentEl.createEl("h2", { text: "Upload images from your phone" });
        this.contentEl.createEl("p", { text: "Scan to sign your phone into this Pixno account. Keep this window open." });
        const canvas = this.contentEl.createEl("canvas");
        const status = this.contentEl.createEl("p", { text: "Waiting for notes…", attr: { role: "status" } });
        const button = this.contentEl.createEl("button", { text: "Refresh QR" });
        const render = async () => {
            await toCanvas(canvas, this.url, { width: 260, margin: 2 });
            window.clearTimeout(this.expiry);
            this.expiry = window.setTimeout(() => {
                this.url = "";
                canvas.width = 0; canvas.height = 0;
                if (!this.closed) status.setText("QR expired. Refresh to try again.");
            }, 180_000);
        };
        void render().catch(() => status.setText("Could not display QR. Try refreshing."));
        button.addEventListener("click", async () => {
            if (button.disabled) return;
            button.disabled = true;
            try {
                const url = await this.refresh();
                if (this.closed) return;
                this.url = url;
                await render();
                status.setText("Waiting for notes…");
            } catch { if (!this.closed) status.setText("Could not refresh QR. Wait a moment and retry."); }
            finally { button.disabled = false; }
        });
        const check = async () => {
            if (this.closed) return;
            try { await this.poll(); }
            catch { if (!this.closed) status.setText("Sync paused. Check your connection and local edits."); }
            if (!this.closed) this.timer = window.setTimeout(check, 10_000);
        };
        void check();
    }
    onClose() {
        this.closed = true; this.url = "";
        window.clearTimeout(this.timer); window.clearTimeout(this.expiry);
        this.contentEl.empty();
    }
}
