import { WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";

export class PhotesWidget extends WidgetType {
	src: string;

	constructor(src: string) {
		super();
		this.src = src;
	}

	toDOM() {
		const div = document.createElement("div");
		div.className = "photes-button";
		div.setAttribute("data-src", this.src);
		const iconContainer = document.createElement("div");
		iconContainer.setAttribute("class", "photes-icon");
		setIcon(iconContainer, "photes");
		div.appendChild(iconContainer);
		return div;
	}

	ignoreEvent(): boolean {
		return false;
	}
}
