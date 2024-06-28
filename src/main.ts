import {
	App,
	ButtonComponent,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	Setting,
	normalizePath,
} from "obsidian";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { DummyPhotesPlugin, PhotesPlugin } from "src/editor";
import { PhotesSettingsTab } from "src/settings";
import { getNote } from "src/service";
import { onElement } from "src/helpers";
import { Platform } from "obsidian";
import { Extension } from "@codemirror/state";
import { listenSync } from "./sync";

interface MyPluginSettings {
	accessToken: string;
	imagePath: string;
	syncPath: string;
	autoSync: boolean;
	lastSyncedTime: number;
	syncTimestamp: number;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	accessToken: "",
	imagePath: "",
	syncPath: "",
	autoSync: false,
	lastSyncedTime: 0,
	syncTimestamp: 0,
};

export default class PhotesIOPlugin extends Plugin {
	settings: MyPluginSettings;
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
		await this.loadSettings();
		this.registerDocument(document);
		this.app.workspace.on("window-open", (_workspaceWindow, window) => {
			this.registerDocument(window.document);
		});
		this.updateEditorExtension();
		this.registerEditorExtension(this.editorExtension);

		this.addRibbonIcon(
			"camera",
			"Generate notes from photos",
			async (evt: MouseEvent) => {
				if (!this.settings.accessToken) {
					this.openSetting();
					return;
				}
				if (Platform.isAndroidApp) {
					const menu = new Menu();
					menu.addItem((item) =>
						item
							.setTitle("From Camera")
							.setIcon("camera")
							.onClick(() => {
								const filePicker = createEl("input", {});
								filePicker.accept = "image/*";
								filePicker.capture = "camera";
								filePicker.type = "file";
								filePicker.onchange = () => {
									if (!filePicker.files?.length) return;
									const selectedFile = filePicker.files[0];
									this.addImage(selectedFile);
								};
								filePicker.click();
							})
					);

					menu.addItem((item) =>
						item
							.setTitle("From Gallery")
							.setIcon("book-image")
							.onClick(() => {
								const filePicker = createEl("input", {});
								filePicker.accept = "image/*";
								filePicker.type = "file";
								filePicker.onchange = () => {
									if (!filePicker.files?.length) return;
									const selectedFile = filePicker.files[0];
									this.addImage(selectedFile);
								};
								filePicker.click();
							})
					);

					menu.showAtMouseEvent(evt);
				} else {
					const filePicker = createEl("input", {});
					filePicker.accept = "image/*";
					filePicker.type = "file";
					filePicker.onchange = () => {
						if (!filePicker.files?.length) return;
						const selectedFile = filePicker.files[0];
						this.addImage(selectedFile);
					};
					filePicker.click();
				}
			}
		);

		this.tab = new PhotesSettingsTab(this.app, this);

		this.addSettingTab(this.tab);

		this.registerObsidianProtocolHandler("photes-login", async (params) => {
			const { token } = params;
			this.settings.accessToken = token;
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
	}

	onunload() {
		this.syncInstance?.stop();
	}

	updateUIItems() {
		if (this.processing) {
			if (!this.statusBarItem) {
				this.statusBarItem = this.addStatusBarItem();
				this.statusBarItem.className = "photes-status-bar-item";
			}
			this.statusBarItem.show();
			if (this.uploading) {
				this.statusBarItem.setText(`Photes: Uploading Image...`);
			} else {
				this.statusBarItem.setText("Photes: Generating Note...");
			}

			if (this.modalButtonItem) {
				this.modalButtonItem.setDisabled(true);
				if (this.uploading) {
					this.modalButtonItem.setButtonText("Uploading Image...");
				} else {
					this.modalButtonItem.setButtonText("Generating Note...");
				}
			} else if (Platform.isMobile) {
				if (this.uploading) {
					new Notice("Photes: Uploading Image...");
				} else {
					new Notice("Photes: Generating Note...");
				}
			}
		} else {
			if (this.statusBarItem) {
				this.statusBarItem.hide();
			}
			if (this.modalButtonItem) {
				this.modalButtonItem.setDisabled(false);
				this.modalButtonItem.setButtonText("Generate Note");
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
								"There's something wrong when getting the image. You can try right-click on the image to resolve this. Please Report this problem to PhotesIO."
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
								"There's something wrong when getting the image. You can try right-click on the image to resolve this. Please Report this problem to PhotesIO."
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
											"Login to Generate Note"
										)
											.setCta()
											.onClick(() => {
												self.openSetting();
												this.close();
											});
									});
								} else {
									new Setting(contentEl).addButton((btn) => {
										btn.setButtonText("Generate Note")
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
		this.app.setting.openTabById("photes-io-obsidian-plugin");
	}

	async onImageContextMenu(event: MouseEvent, img: HTMLImageElement) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.editor) {
			if (!this.settings.accessToken) {
				const menu = new Menu();
				menu.addItem((item) => {
					item.setTitle("Login to Generate Note");
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
					item.setTitle("Generating Note...");
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
				item.setTitle("Generate Note");
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

	async addImage(file: File) {
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
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
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
			new Notice(`Generate Notes Failed. ${e}`);
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
