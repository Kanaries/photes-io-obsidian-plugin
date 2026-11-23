import { App, Modal } from "obsidian";
import { toCanvas } from "qrcode";

export class MobileUploadModal extends Modal {
    private closed = false;
    private connected = false;
    private received: { id: number; title: string }[] = [];
    private expiry: number | undefined;
    constructor(app: App, private url: string, private refresh: () => Promise<string>) { super(app); }
    showConnected() {
        if (this.closed) return;
        this.connected = true;
        this.url = "";
        window.clearTimeout(this.expiry);
        this.renderConnected();
    }
    showReceived(notes: { id: number; title: string }[]) {
        if (this.closed) return;
        this.received = notes;
        this.showConnected();
    }
    private renderConnected() {
        this.contentEl.empty();
        this.contentEl.createEl("h2", { text: "Phone connected" });
        this.contentEl.createEl("p", { text: this.received.length ? "Received" : "Waiting for images and notes…", attr: { role: "status" } });
        if (this.received.length) {
            const list = this.contentEl.createEl("ul");
            for (const note of this.received) list.createEl("li", { text: note.title });
        }
    }
    onOpen() {
        this.contentEl.createEl("h2", { text: "Upload images from your phone" });
        this.contentEl.createEl("p", { text: "Scan to sign your phone into this Pixno account." });
        const canvas = this.contentEl.createEl("canvas");
        const status = this.contentEl.createEl("p", { text: "Waiting for phone…", attr: { role: "status" } });
        const button = this.contentEl.createEl("button", { text: "Refresh QR" });
        const render = async () => {
            await toCanvas(canvas, this.url, { width: 260, margin: 2 });
            if (this.closed || this.connected) return;
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
                if (this.closed || this.connected) return;
                this.url = url;
                await render();
                status.setText("Waiting for phone…");
            } catch { if (!this.closed) status.setText("Could not refresh QR. Wait a moment and retry."); }
            finally { button.disabled = false; }
        });

    }
    onClose() {
        this.closed = true; this.url = "";
        window.clearTimeout(this.expiry);
        this.contentEl.empty();
    }
}
