import { App, PluginSettingTab, Setting } from "obsidian";
import type PhotesObsidianPlugin from "./main";
import { getInfo, login } from "./service";

export class PhotesSettingsTab extends PluginSettingTab {
	plugin: PhotesObsidianPlugin;
	info: {
		usage: [number, number];
		email: string;
		subscription: {
			prices: {
				products: {
					name: string;
				};
			};
		} | null;
	} | null;
	error: string | null;

	constructor(app: App, plugin: PhotesObsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		if (this.plugin.settings.accessToken) {
			this.fetchInfo();
		}
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		if (this.plugin.settings.accessToken) {
			new Setting(containerEl)
				.setName("Logout")
				.setDesc("Logout from your Photes account")
				.addButton((button) => {
					button.setButtonText("Logout");
					button.onClick(async () => {
						this.plugin.settings.accessToken = "";
						await this.plugin.saveSettings();
						this.display();
					});
				});
			new Setting(containerEl).setName("User info").setHeading();
			if (!this.info) {
				if (this.error) {
					new Setting(containerEl)
						.setName("An Error Occurred")
						.setDesc(this.error)
						.addButton((button) => {
							button.setButtonText("Retry");
							button.onClick(async () => {
								await this.fetchInfo();
							});
						});
				} else {
					containerEl.createEl("p", { text: "Loading..." });
				}
			} else {
				const { usage, email, subscription } = this.info;
				new Setting(containerEl)
					.setName("Reload")
					.setDesc("Reload the user info")
					.addButton((button) => {
						button.setButtonText("Reload");
						button.onClick(async () => {
							await this.fetchInfo();
						});
					});

				const subscriptionName = subscription?.prices.products.name;
				const infoEl = containerEl.createEl("div", {
					cls: "photes-info",
				});
				infoEl.createEl("p", { text: `Email: ${email}` });
				if (subscriptionName) {
					infoEl.createEl("p", {
						text: `Subscription: ${subscriptionName}`,
					});
				} else {
					infoEl.createEl("p", {
						text: `Subscription: Free`,
					});
				}
				infoEl.createEl("p", {
					text: `Usage: ${usage[0]} / ${usage[1]}`,
				});
			}
		} else {
			new Setting(containerEl)
				.setName("Login")
				.setDesc("Login to your Photes account to use the feature")
				.addButton((button) => {
					button.setButtonText("Login");
					button.onClick(async () => {
						login();
					});
				});
		}
		// new Setting(containerEl).setName("Common Settings").setHeading();
		new Setting(containerEl)
			.setName("Image path")
			.setDesc(
				"The path to save the image when importing from Ribbon action."
			)
			.addText((text) => {
				text.setPlaceholder("/assets");
				text.setValue(this.plugin.settings.imagePath);
				text.onChange(async (value) => {
					this.plugin.settings.imagePath = value;
					await this.plugin.saveSettings();
				});
			});
	}

	async fetchInfo() {
		this.info = null;
		this.error = null;
		this.display();
		try {
			const resp = await getInfo(this.plugin.settings.accessToken);
			this.info = resp;
		} catch (e) {
			this.error = `${e}`;
		}
		this.display();
	}
}
