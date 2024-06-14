import { WidgetType } from "@codemirror/view";
import createPhotesIcon from "../assets/photes";

export class PhotesWidget extends WidgetType {
	toDOM() {
		const div = document.createElement("div");
		div.className = "photes-button";
		const icon = createPhotesIcon();
		icon.setAttribute("class", "photes-icon");
		div.appendChild(icon);
		return div;
	}
	ignoreEvent(): boolean {
		return false;
	}
}
