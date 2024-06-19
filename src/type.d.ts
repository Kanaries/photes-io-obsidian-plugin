import { EditorView } from "@codemirror/view";
import "obsidian";
declare module "obsidian" {
	export interface App {
		setting: {
			open(): Promise<void>;
			openTabById(id: string): void;
		};
	}

	export interface Editor {
		cm: EditorView;
	}
}
