import {
	ViewUpdate,
	PluginValue,
	EditorView,
	DecorationSet,
	Decoration,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { PhotesWidget } from "src/widgets/button";
import { LoadingPhotesWidget } from "./widgets/loading";

export class PhotesPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() {}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter(node) {
					if (node.name.includes("image-marker")) {
						builder.add(
							node.from,
							node.from,
							Decoration.widget({
								widget: new PhotesWidget(),
								side: -1,
							})
						);
					}
				},
			});
		}
		return builder.finish();
	}
}

export class DummyPhotesPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() {}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();

		for (let { from, to } of view.visibleRanges) {
			syntaxTree(view.state).iterate({
				from,
				to,
				enter(node) {
					if (node.name.includes("image-marker")) {
						builder.add(
							node.from,
							node.from,
							Decoration.widget({
								widget: new LoadingPhotesWidget(),
								side: -1,
							})
						);
					}
				},
			});
		}
		return builder.finish();
	}
}
