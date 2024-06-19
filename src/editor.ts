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
					if (node.name.includes("embed_hmd")) {
						const src = view.state.doc.sliceString(
							node.from,
							node.to
						);
						// ![[img]]
						builder.add(
							node.from - 3,
							node.from - 3,
							Decoration.widget({
								widget: new PhotesWidget(src),
								side: 0,
							})
						);
					}
					if (node.name.includes("image-marker")) {
						const n = node;
						const line = view.state.doc.lineAt(n.from);
						const text = view.state.sliceDoc(n.from, line.to);
						// ![desc](img)
						const src = text.match(/^!\[.*?\]\((.*?)\)/)?.[1];
						builder.add(
							node.from,
							node.from,
							Decoration.widget({
								widget: new PhotesWidget(src ?? ""),
								side: 0,
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
					if (node.name.includes("embed_hmd")) {
						// ![[img]]
						builder.add(
							node.from - 3,
							node.from - 3,
							Decoration.widget({
								widget: new LoadingPhotesWidget(),
								side: 0,
							})
						);
					}
					if (node.name.includes("image-marker")) {
						// ![desc](img)
						builder.add(
							node.from,
							node.from,
							Decoration.widget({
								widget: new LoadingPhotesWidget(),
								side: 0,
							})
						);
					}
				},
			});
		}
		return builder.finish();
	}
}
