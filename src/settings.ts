import { App, PluginSettingTab, Setting } from "obsidian";
import type PixnoPlugin from "./main";
import { Notebook, PixnoError } from "./service";

function message(error: unknown) {
	switch (error instanceof PixnoError ? error.status : 0) {
		case 401: return "Your Pixno session has expired. Log in again.";
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
				this.notebooks = [];
				this.selection = undefined;
			}
			this.status = message(error);
		} finally {
			this.busy = false;
			this.display();
		}
	}

	authorizationChanged(status: string) {
		this.status = status;
		if (this.containerEl?.isConnected) this.display();
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("p", { text: "Import Pixno notebooks as Markdown. Each import creates a new file in Pixno Imports." });

		if (!this.plugin.hasSession || this.plugin.needsLogin || this.plugin.waiting) {
			new Setting(containerEl)
				.setName("Pixno")
				.setDesc(this.plugin.waiting
					? "Finish signing in and approving access in your browser, then return to Obsidian."
					: "Log in through the browser to import your notebooks.")
				.addButton(button => button.setButtonText(this.plugin.waiting ? "Start a new login" : "Log in to Pixno").setDisabled(this.busy).onClick(() => {
					try {
						this.plugin.beginLogin();
						this.notebooks = [];
						this.selection = undefined;
						this.status = "Continue in your browser.";
					} catch (error) {
						this.status = message(error);
					}
					this.display();
				}));
		} else {
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
		if (this.plugin.hasSession) {
			new Setting(containerEl)
				.setName("Pixno session")
				.addButton(button => button.setButtonText("Log out").setDisabled(this.busy).onClick(() => this.run(async () => {
					this.notebooks = [];
					this.selection = undefined;
					try {
						await this.plugin.logout();
						this.status = "Logged out of Pixno.";
					} catch {
						this.status = this.plugin.hasSession
							? "Could not confirm logout. Review your session in Pixno Integrations."
							: "Local session cleared. Review Pixno Integrations to revoke the server session.";
					}
				})));
		}
		containerEl.createEl("a", {
			text: "Manage Pixno integrations",
			href: this.plugin.integrationsUrl,
			attr: { target: "_blank", rel: "noopener noreferrer" },
		});
		containerEl.createEl("p", { text: this.status, attr: { role: "status" } });
	}
}
