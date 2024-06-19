import { WidgetType } from "@codemirror/view";
import createPhotesIcon from "../assets/photes";

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
		const icon = createPhotesIcon();
		icon.setAttribute("class", "photes-icon");
		div.appendChild(icon);
		return div;
	}

	ignoreEvent(): boolean {
		return false;
	}
}
