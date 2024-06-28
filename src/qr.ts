import { App, Modal, Notice, Setting } from "obsidian";
import PhotesIOPlugin from "./main";
import { toDataURL } from "qrcode";
import { getQRCodeURL } from "./service";

export default class PhotesQRModal extends Modal {
	plugin: PhotesIOPlugin;
	constructor(app: App, plugin: PhotesIOPlugin) {
		super(app);
		this.plugin = plugin;
	}
	onOpen() {
		const accessKey = this.plugin.settings.accessToken;
		if (!accessKey) {
			new Notice("Please login to use this feature.");
			this.close();
			return;
		}
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Photes QR" });
		contentEl.createEl("p", {
			text: "Scan this QR code to upload images from your phone and create notes.",
		});
		const qr = contentEl.createDiv("photes-qr");
		let img: HTMLImageElement;
		const setQR = () => {
			getQRCodeURL(accessKey)
				.then((x) => toDataURL(x))
				.then((url) => {
					if (img) {
						img.src = url;
					} else {
						img = qr.createEl("img", {
							attr: {
								src: url,
							},
						});
					}
				})
				.catch((e) => {
					new Notice(
						"Failed to get QR code. Please try again later."
					);
					console.error(e);
				});
		};
		setQR();
		new Setting(contentEl).addButton((button) => {
			button.setButtonText("Refresh QR Code");
			button.onClick(() => {
				setQR();
			});
		});
	}
}
