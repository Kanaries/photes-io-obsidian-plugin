import { WidgetType } from "@codemirror/view";
import createLoaderIcon from "../assets/loader";

export class LoadingPhotesWidget extends WidgetType {
	toDOM() {
		const div = document.createElement("div");
		div.className = "photes-button disabled";
		const icon = createLoaderIcon();
		icon.setAttribute("class", "loading-icon");
		div.appendChild(icon);
		return div;
	}
	ignoreEvent(): boolean {
		return true;
	}
}
