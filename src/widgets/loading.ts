import { WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";

export class LoadingPhotesWidget extends WidgetType {
	toDOM() {
		const div = document.createElement("div");
		div.className = "photes-button disabled";
		const iconContainer = document.createElement("div");
		iconContainer.setAttribute("class", "loading-icon");
		setIcon(iconContainer, "loader-2");
		div.appendChild(iconContainer);
		return div;
	}
	ignoreEvent(): boolean {
		return true;
	}
}
