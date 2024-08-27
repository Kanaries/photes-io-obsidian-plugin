import {
	App,
	ButtonComponent,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	Setting,
	addIcon,
	normalizePath,
} from "obsidian";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { DummyPhotesPlugin, PhotesPlugin } from "src/editor";
import { PhotesSettingsTab } from "src/settings";
import { getNote, startSync } from "src/service";
import { onElement } from "src/helpers";
import { Platform } from "obsidian";
import { Extension } from "@codemirror/state";
import { listenSync } from "./sync";
import PhotesQRModal from "./qr";

interface PhotesIOPluginSettings {
	accessToken: string;
	imagePath: string;
	syncPath: string;
	autoSync: boolean;
	lastSyncedTime: number;
	syncTimestamp: number;
}

const DEFAULT_SETTINGS: PhotesIOPluginSettings = {
	accessToken: "",
	imagePath: "",
	syncPath: "",
	autoSync: false,
	lastSyncedTime: 0,
	syncTimestamp: 0,
};

export default class PhotesIOPlugin extends Plugin {
	settings: PhotesIOPluginSettings;
	longTapTimeoutId?: number;
	shouldOpenModal: boolean = false;
	openModal?: () => void;
	tab: PhotesSettingsTab;
	processing: boolean = false;
	uploading: boolean = false;
	statusBarItem: HTMLElement | null = null;
	modalButtonItem: ButtonComponent | null = null;
	syncInstance: Awaited<ReturnType<typeof listenSync>> | null = null;
	private editorExtension: Extension[] = [];

	async onload() {
		addIcon(
			"photes",
			`<g clip-path="url(#clip0_1_14)"><path x="19.569" y="19.569" width="260.66" height="260.66" rx="30.431" stroke="currentColor" stroke-width="13.046" d="M16.667 6.523H83.266A10.144 10.144 0 0 1 93.41 16.667V83.266A10.144 10.144 0 0 1 83.266 93.41H16.667A10.144 10.144 0 0 1 6.523 83.266V16.667A10.144 10.144 0 0 1 16.667 6.523z"/><path d="M50.05 87.413V36.989h18.909q5.811 0 9.75 2.167 3.964 2.167 5.983 5.958 2.043 3.767 2.044 8.568 0 4.85 -2.044 8.617 -2.043 3.767 -6.032 5.934 -3.989 2.142 -9.824 2.142H56.303v-7.509h11.301q3.398 0 5.564 -1.182t3.201 -3.25q1.059 -2.069 1.059 -4.752 0 -2.684 -1.059 -4.727 -1.034 -2.043 -3.225 -3.176 -2.167 -1.157 -5.589 -1.157h-8.371v42.792z" fill="currentColor"/></g><defs><clipPath id="clip0_1_14"><path d="M0 0h100v100H0z"/></clipPath></defs>`
		);

		await this.loadSettings();
		this.registerDocument(document);
		this.app.workspace.on("window-open", (_workspaceWindow, window) => {
			this.registerDocument(window.document);
		});
		this.updateEditorExtension();
		this.registerEditorExtension(this.editorExtension);

		this.addRibbonIcon(
			"camera",
			Platform.isMobile ? "Generate notes from photos" : "Generate notes",
			async (evt: MouseEvent) => {
				if (!this.settings.accessToken) {
					this.openSetting();
					return;
				}
				const pickFile = async (
					inject?: (input: HTMLInputElement) => void
				) => {
					let view =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!view) {
						// active current file
						const file = this.app.workspace.getActiveFile();
						if (!file) {
							new Notice(
								"Please open a markdown file to add image"
							);
							return;
						}
						const leaf = this.app.workspace.getLeaf(false);
						await leaf.openFile(file);
						view =
							this.app.workspace.getActiveViewOfType(
								MarkdownView
							);
						if (!view) {
							new Notice(
								"Please open a markdown file to add image"
							);
							return;
						}
					}
					const filePicker = createEl("input", {});
					filePicker.accept = "image/*";
					filePicker.type = "file";
					inject?.(filePicker);
					filePicker.onchange = () => {
						if (!filePicker.files?.length) return;
						const selectedFile = filePicker.files[0];
						this.addImage(selectedFile, view!);
					};
					filePicker.click();
				};
				if (Platform.isAndroidApp) {
					const menu = new Menu();
					menu.addItem((item) =>
						item
							.setTitle("From camera")
							.setIcon("camera")
							.onClick(() => {
								pickFile((filePicker) => {
									filePicker.capture = "camera";
								});
							})
					);
					menu.addItem((item) =>
						item
							.setTitle("From gallery")
							.setIcon("book-image")
							.onClick(() => {
								pickFile();
							})
					);
					menu.showAtMouseEvent(evt);
				} else if (Platform.isMobile) {
					pickFile();
				} else {
					const menu = new Menu();
					menu.addItem((item) =>
						item
							.setTitle("Generate note from smartphone")
							.setIcon("monitor-smartphone")
							.onClick(() => {
								new PhotesQRModal(this.app, this).open();
							})
					);
					menu.addItem((item) =>
						item
							.setTitle("Generate note from image")
							.setIcon("book-image")
							.onClick(() => {
								pickFile();
							})
					);
					menu.showAtMouseEvent(evt);
				}
			}
		);

		this.tab = new PhotesSettingsTab(this.app, this);

		this.addSettingTab(this.tab);

		this.addCommand({
			id: "sync-notes",
			name: "Sync notes",
			callback: () => {
				if (!this.settings.accessToken) {
					new Notice("Please login to use this feature");
					this.openSetting();
					return;
				}
				startSync(
					this.settings.accessToken,
					this.app,
					this.settings.syncPath || DEFAULT_SETTINGS.syncPath,
					(x) => {
						this.showSyncStatus(x);
						this.tab.syncingInfo = x;
						this.tab.display();
					},
					this.settings.syncTimestamp
				).then(({ lastSyncedTime, syncTimestamp }) => {
					this.settings.lastSyncedTime = lastSyncedTime;
					this.settings.syncTimestamp = syncTimestamp;
					new Notice("Sync completed");
					this.showSyncStatus("");
					this.tab.syncingInfo = "";
					this.tab.display();
					this.saveSettings();
				});
			},
		});

		this.addCommand({
			id: "upload-from-mobile",
			name: "Upload image from mobile",
			callback: () => {
				new PhotesQRModal(this.app, this).open();
			},
		});

		this.registerObsidianProtocolHandler("photes-login", async (params) => {
			const { token } = params;
			this.settings.accessToken = token;
			this.settings.autoSync = true;
			this.settings.lastSyncedTime = Date.now();
			this.settings.syncTimestamp = Date.now();
			this.syncInstance?.stop();
			this.syncInstance = await listenSync(
				this.settings.accessToken,
				this.app,
				this
			);
			await this.saveSettings();
			this.tab.fetchInfo();
			this.tab.display();
		});

		if (this.settings.autoSync && this.settings.accessToken) {
			this.syncInstance = await listenSync(
				this.settings.accessToken,
				this.app,
				this
			);
		}

		this.registerInterval(
			window.setInterval(async () => {
				if (this.syncInstance) {
					if (this.syncInstance.getLastStatus() !== "SUBSCRIBED") {
						// try to reconnect
						this.syncInstance.stop();
						this.syncInstance = await listenSync(
							this.settings.accessToken,
							this.app,
							this
						);
						return;
					}
					this.syncInstance.startRefetch();
				}
			}, 1000 * 60 * 30)
		);
	}

	onunload() {
		this.syncInstance?.stop();
		this.syncInstance = null;
	}

	updateUIItems() {
		if (this.processing) {
			if (!this.statusBarItem) {
				this.statusBarItem = this.addStatusBarItem();
				this.statusBarItem.className = "photes-status-bar-item";
			}
			this.statusBarItem.show();
			if (this.uploading) {
				this.statusBarItem.setText(`Photes: Uploading image...`);
			} else {
				this.statusBarItem.setText("Photes: Generating note...");
			}

			if (this.modalButtonItem) {
				this.modalButtonItem.setDisabled(true);
				if (this.uploading) {
					this.modalButtonItem.setButtonText("Uploading image...");
				} else {
					this.modalButtonItem.setButtonText("Generating note...");
				}
			} else if (Platform.isMobile) {
				if (this.uploading) {
					new Notice("Photes: Uploading image...");
				} else {
					new Notice("Photes: Generating note...");
				}
			}
		} else {
			if (this.statusBarItem) {
				this.statusBarItem.hide();
			}
			if (this.modalButtonItem) {
				this.modalButtonItem.setDisabled(false);
				this.modalButtonItem.setButtonText("Generate note");
			}
		}
	}

	showSyncStatus(info: string) {
		if (info) {
			if (!this.statusBarItem) {
				this.statusBarItem = this.addStatusBarItem();
				this.statusBarItem.className = "photes-status-bar-item";
			}
			this.statusBarItem.show();
			this.statusBarItem.setText(info);
		} else {
			if (this.statusBarItem) {
				this.statusBarItem.hide();
			}
		}
	}

	updateEditorExtension() {
		this.editorExtension.length = 0;
		const myNewExtension = this.createEditorExtension();
		this.editorExtension.push(myNewExtension);
		this.app.workspace.updateOptions();
	}

	createEditorExtension() {
		if (this.processing) {
			return ViewPlugin.fromClass(DummyPhotesPlugin, {
				decorations: (p) => p.decorations,
			});
		}
		return ViewPlugin.fromClass(PhotesPlugin, {
			decorations: (p) => p.decorations,
			eventHandlers: {
				click: (e, view) => {
					let target = e.target as HTMLElement | null;
					const check = () => {
						while (target && target != view.dom) {
							if (target.classList.contains("photes-button")) {
								return true;
							}
							target = target.parentElement;
						}
						return false;
					};

					if (check()) {
						const src = target!.getAttribute("data-src");
						const currentLine = view.state.doc.lineAt(
							view.posAtDOM(target!)
						);
						if (!src) {
							new Notice(
								"There's something wrong when getting the image. You can try right-click on the image to resolve this. Please report this problem to photes.io."
							);
							return;
						}
						if (src.startsWith("http")) {
							this.addNote(src, currentLine.to, view);
							return;
						}
						const imageDOM = view.dom.querySelector(
							`div[src='${src}'] img`
						) as HTMLImageElement | null;
						if (imageDOM) {
							this.addNote(
								imageDOM.currentSrc,
								currentLine.to,
								view
							);
						} else {
							new Notice(
								"There's something wrong when getting the image. You can try right-click on the image to resolve this. Please report this problem to photes.io."
							);
						}
					}
				},
			},
		});
	}

	registerDocument(document: Document) {
		if (Platform.isDesktop) {
			this.register(
				onElement(
					document,
					"contextmenu",
					"img",
					this.onImageContextMenu.bind(this)
				)
			);
		} else {
			this.register(
				onElement(
					document,
					"touchstart",
					"img",
					this.startWaitingForLongTap.bind(this)
				)
			);

			this.register(
				onElement(
					document,
					"touchend",
					"img",
					this.stopWaitingForLongTap.bind(this, true)
				)
			);

			this.register(
				onElement(
					document,
					"touchmove",
					"img",
					this.stopWaitingForLongTap.bind(this)
				)
			);
		}
	}

	startWaitingForLongTap(event: TouchEvent, img: HTMLImageElement) {
		if (this.longTapTimeoutId) {
			clearTimeout(this.longTapTimeoutId);
			this.longTapTimeoutId = undefined;
		} else {
			if (event.targetTouches.length == 1) {
				this.longTapTimeoutId = window.setTimeout(
					this.processLongTap.bind(this, event),
					500
				);
				this.shouldOpenModal = false;
				this.openModal = () => {
					const activeView =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView?.editor) {
						const view = activeView.editor.cm;
						const self = this;
						let pos: number;
						try {
							pos = view.posAtDOM(img);
						} catch (e) {
							console.log("get pos failed", e);
							return;
						}
						const modal = new (class extends Modal {
							constructor(app: App) {
								super(app);
							}
							onOpen() {
								let { contentEl } = this;
								if (!self.settings.accessToken) {
									new Setting(contentEl).addButton((btn) => {
										btn.setButtonText(
											"Login to generate notes"
										)
											.setCta()
											.onClick(() => {
												self.openSetting();
												this.close();
											});
									});
								} else {
									new Setting(contentEl).addButton((btn) => {
										btn.setButtonText("Generate note")
											.setCta()
											.onClick(async () => {
												if (
													!self.settings.accessToken
												) {
													new Notice(
														"Please login to use this feature"
													);
													self.openSetting();
													return;
												}
												await self.addNote(
													img.currentSrc,
													pos,
													view
												);
												this.close();
											});
										self.modalButtonItem = btn;
									});
								}
							}

							onClose() {
								let { contentEl } = this;
								contentEl.empty();
								self.modalButtonItem = null;
							}
						})(this.app);
						modal.open();
					}
				};
			}
		}
	}

	// mobile
	stopWaitingForLongTap(checkOpenModal: boolean = false) {
		if (this.longTapTimeoutId) {
			clearTimeout(this.longTapTimeoutId);
			this.longTapTimeoutId = undefined;
		}
		if (this.shouldOpenModal && this.openModal && checkOpenModal) {
			this.openModal();
			this.shouldOpenModal = false;
			this.openModal = undefined;
		}
	}

	// mobile
	async processLongTap(event: TouchEvent) {
		event.stopPropagation();
		event.preventDefault();
		this.longTapTimeoutId = undefined;
		this.shouldOpenModal = true;
	}

	async openSetting() {
		await this.app.setting.open();
		this.app.setting.openTabById("image-notes-photes-io");
	}

	async onImageContextMenu(event: MouseEvent, img: HTMLImageElement) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.editor) {
			if (!this.settings.accessToken) {
				const menu = new Menu();
				menu.addItem((item) => {
					item.setTitle("Login to generate notes");
					item.setIcon("lock");
					item.onClick(() => {
						this.openSetting();
					});
				});
				menu.showAtMouseEvent(event);
				return;
			}
			if (this.processing) {
				const menu = new Menu();
				menu.addItem((item) => {
					item.setTitle("Generating note...");
					item.setIcon("sync");
					item.setDisabled(true);
				});
				menu.showAtMouseEvent(event);
				return;
			}
			const view = activeView.editor.cm;
			const menu = new Menu();
			menu.addItem((item) => {
				item.setIcon("sticky-note");
				item.setTitle("Generate note");
				item.onClick(async () => {
					if (!this.settings.accessToken) {
						new Notice("Please login to use this feature");
						this.openSetting();
						return;
					}
					const pos = view.posAtDOM(img);
					this.addNote(img.currentSrc, pos, view);
				});
			});
			menu.showAtMouseEvent(event);
		}
	}

	async addImage(file: File, view: MarkdownView) {
		const path = (this.settings.imagePath || "/assets").replace(
			/[\/]$/,
			""
		);
		const filename = file.name
			? file.name
			: `${(new Date() + "")
					.slice(4, 28)
					.split(" ")
					.join("_")
					.split(":")
					.join("-")}.${file.type.split("/")[1]}`;
		const filePath = normalizePath(`${path}/${filename}`);
		const folderExists = this.app.vault.getAbstractFileByPath(
			normalizePath(path)
		);
		if (!folderExists) {
			await this.app.vault.createFolder(path);
		}
		const fileExists = this.app.vault.getAbstractFileByPath(filePath);
		if (!fileExists) {
			await this.app.vault.createBinary(
				filePath,
				await file.arrayBuffer()
			);
		}
		const editorView = view.editor.cm;
		const cursor = editorView.state.selection.main.to;
		const imageText = `\n![[${filePath}]]\n`;
		editorView.dispatch({
			changes: {
				from: cursor,
				to: cursor,
				insert: imageText,
			},
		});
		this.addNote(file, cursor + imageText.length, editorView);
	}

	async addNote(image: string | Blob, pos: number, view: EditorView) {
		if (!this.settings.accessToken) {
			new Notice("Please login to use this feature");
			this.openSetting();
			return;
		}
		if (this.processing) {
			return;
		}
		this.processing = true;
		this.uploading = true;
		this.updateEditorExtension();
		this.updateUIItems();

		let cursor = pos;
		try {
			await getNote(
				image,
				this.settings.accessToken,
				(text) => {
					const change = {
						from: cursor,
						to: cursor,
						insert: text,
					};
					view.dispatch({ changes: change });
					cursor += text.length;
				},
				() => {
					this.uploading = false;
					this.updateUIItems();
				}
			);
		} catch (e) {
			new Notice(`Generate notes failed. ${e}`);
		} finally {
			this.processing = false;
			this.updateEditorExtension();
			this.updateUIItems();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
