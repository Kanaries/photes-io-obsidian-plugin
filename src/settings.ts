import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type PhotesObsidianPlugin from "./main";
import { getInfo, login, startSync } from "./service";
import { DEFAULT_SYNC_PATH } from "./const";
import { listenSync } from "./sync";

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
	syncingInfo: string | null;

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
				.setDesc(
					"Logout from your Photes account. This operation will also remove the sync info."
				)
				.addButton((button) => {
					button.setButtonText("Logout");
					button.onClick(async () => {
						this.plugin.settings.accessToken = "";
						this.plugin.settings.lastSyncedTime = 0;
						this.plugin.settings.syncTimestamp = 0;
						this.plugin.settings.autoSync = false;
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
			new Setting(containerEl).setHeading().setName("Sync Settings");
			new Setting(containerEl)
				.setName("Sync")
				.setDesc(
					this.syncingInfo
						? this.syncingInfo
						: this.plugin.settings.lastSyncedTime
						? `Last Synced time: ${new Date(
								this.plugin.settings.lastSyncedTime
						  ).toLocaleString()}`
						: "Not Synced yet"
				)
				.addButton((button) => {
					button.setButtonText("Sync");
					button.setDisabled(!!this.syncingInfo);
					button.onClick(async () => {
						const { lastSyncedTime, syncTimestamp } =
							await startSync(
								this.plugin.settings.accessToken,
								this.app,
								this.plugin.settings.syncPath ||
									DEFAULT_SYNC_PATH,
								(x) => {
									this.plugin.showSyncStatus(x);
									this.syncingInfo = x;
									this.display();
								},
								this.plugin.settings.syncTimestamp
							);
						console.log(syncTimestamp);
						this.plugin.settings.lastSyncedTime = lastSyncedTime;
						this.plugin.settings.syncTimestamp = syncTimestamp;
						new Notice("Sync Completed");
						this.plugin.showSyncStatus("");
						this.syncingInfo = "";
						this.display();
						await this.plugin.saveSettings();
					});
				});
			new Setting(containerEl)
				.setName("Enable Auto Sync")
				.setDesc("Automatically sync notes.")
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.autoSync);
					toggle.onChange(async (value) => {
						if (value) {
							if (!this.plugin.settings.syncTimestamp) {
								// first time to sync
								const self = this;
								class FirstTimeAskModal extends Modal {
									onOpen(): void {
										const { contentEl } = this;
										contentEl.createEl("h2", {
											text: "Do you want to Sync All notebooks now?",
										});
										contentEl.createEl("p", {
											text: "If you choose not to sync all notebooks, only new notes will be synced.",
										});
										new Setting(contentEl)
											.addButton((button) => {
												button.setButtonText(
													"Sync New notes only"
												);
												button.onClick(async () => {
													if (
														self.plugin.syncInstance
													) {
														self.plugin.syncInstance.stop();
													}
													this.close();
													self.plugin.settings.lastSyncedTime =
														Date.now();
													self.plugin.settings.syncTimestamp =
														Date.now();
													self.plugin.settings.autoSync =
														true;
													self.plugin.saveSettings();
													self.plugin.syncInstance =
														await listenSync(
															self.plugin.settings
																.accessToken,
															self.app,
															self.plugin
														);
												});
											})
											.addButton((button) => {
												button.setButtonText(
													"Sync All"
												);
												button.setCta();
												button.onClick(async () => {
													if (
														self.plugin.syncInstance
													) {
														self.plugin.syncInstance.stop();
													}
													this.close();
													self.plugin.settings.autoSync =
														true;
													self.plugin.saveSettings();
													self.plugin.syncInstance =
														await listenSync(
															self.plugin.settings
																.accessToken,
															self.app,
															self.plugin
														);
												});
											});
									}
									onClose(): void {
										this.containerEl.empty();
									}
								}
								new FirstTimeAskModal(this.app).open();
							} else {
								this.plugin.settings.autoSync = true;
								this.plugin.saveSettings();
								this.plugin.syncInstance = await listenSync(
									this.plugin.settings.accessToken,
									this.app,
									this.plugin
								);
							}
						} else {
							this.plugin.syncInstance?.stop();
							this.plugin.syncInstance = null;
							this.plugin.settings.autoSync = false;
							await this.plugin.saveSettings();
						}
					});
				});
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
		new Setting(containerEl).setName("Path Settings").setHeading();
		new Setting(containerEl)
			.setName("Sync Path")
			.setDesc(
				"The path to save synced notes. Edit it will only affect new files."
			)
			.addText((text) => {
				text.setPlaceholder("/photes");
				text.setValue(this.plugin.settings.syncPath);
				text.onChange(async (value) => {
					this.plugin.settings.syncPath = value;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("Image path")
			.setDesc("The path to save the image adding via Ribbon action.")
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
