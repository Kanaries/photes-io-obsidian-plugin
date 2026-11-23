import { App, PluginSettingTab, Setting } from "obsidian";
import type PixnoPlugin from "./main";
import { Notebook, PixnoError } from "./service";

function message(error: unknown) {
	switch (error instanceof PixnoError ? error.status : 0) {
		case 401: return "The key is invalid or has expired. Create a new key in Pixno.";
		case 404: return "This notebook is no longer available.";
		case 409: return "An import already exists at this path. Move it before importing another copy.";
		case 413: return "This notebook or list is too large for the plugin to import.";
		case 429: return "Pixno is limiting requests. Wait a minute and try again.";
		case 503: return "Pixno plugin access is temporarily unavailable.";
		default: return "Pixno could not complete the request. Try again.";
	}
}

export class PixnoSettingsTab extends PluginSettingTab {
	private notebooks: Notebook[] = [];
	private selection: number | undefined;
	private status = "";
	private busy = false;

	constructor(app: App, private plugin: PixnoPlugin) {
		super(app, plugin);
	}

	private async run(action: () => Promise<void>) {
		if (this.busy) return;
		this.busy = true;
		this.status = "Working…";
		this.display();
		try {
			await action();
		} catch (error) {
			if (error instanceof PixnoError && error.status === 401) {
				this.plugin.disconnect();
				this.notebooks = [];
				this.selection = undefined;
			}
			this.status = message(error);
		} finally {
			this.busy = false;
			this.display();
		}
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("p", { text: "Import Pixno notebooks as Markdown. Each import creates a new file in Pixno Imports." });

		if (!this.plugin.expiry) {
			containerEl.createEl("a", {
				text: "Create a Pixno access key",
				href: this.plugin.integrationsUrl,
				attr: { target: "_blank", rel: "noopener noreferrer" },
			});
			let key = "";
			new Setting(containerEl)
				.setName("Pixno access key")
				.setDesc("Paste the key from Pixno. It stays in memory until Obsidian closes or the plugin unloads.")
				.addText(input => {
					input.inputEl.type = "password";
					input.inputEl.autocomplete = "off";
					input.inputEl.setAttribute("aria-label", "Pixno access key");
					input.setDisabled(this.busy);
					input.onChange(value => { key = value; });
				})
				.addButton(button => button.setButtonText("Connect").setDisabled(this.busy).onClick(() => {
					const candidate = key;
					key = "";
					return this.run(async () => {
						await this.plugin.connect(candidate);
						this.status = "Connected to Pixno.";
					});
				}));
		} else {
			new Setting(containerEl)
				.setName("Connected to Pixno")
				.setDesc(`Key expires ${new Date(this.plugin.expiry).toLocaleString()}.`)
				.addButton(button => button.setButtonText("Disconnect").setDisabled(this.busy).onClick(() => {
					this.plugin.disconnect();
					this.notebooks = [];
					this.selection = undefined;
					this.status = "Disconnected.";
					this.display();
				}));
			new Setting(containerEl).setName("Pixno notebooks")
				.addButton(button => button.setButtonText("Load notebooks").setDisabled(this.busy).onClick(() => this.run(async () => {
					this.notebooks = await this.plugin.listNotebooks();
					this.selection = this.notebooks[0]?.id;
					this.status = this.notebooks.length ? "Choose a notebook to import." : "No Pixno notebooks found.";
				})));
			if (this.selection !== undefined) {
				new Setting(containerEl)
					.setName("Notebook to import")
					.addDropdown(dropdown => {
						for (const notebook of this.notebooks) {
							dropdown.addOption(String(notebook.id), notebook.title || `Notebook ${notebook.id}`);
						}
						dropdown.setValue(String(this.selection)).setDisabled(this.busy).onChange(value => {
							this.selection = Number(value);
						});
					})
					.addButton(button => button.setButtonText("Import Markdown").setDisabled(this.busy).onClick(() => this.run(async () => {
						if (this.selection === undefined) return;
						const path = await this.plugin.importNotebook(this.selection);
						this.status = `Imported ${path}.`;
					})));
			}
		}
		containerEl.createEl("p", { text: this.status, attr: { role: "status" } });
	}
}
