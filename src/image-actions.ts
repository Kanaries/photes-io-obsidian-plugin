import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { setIcon } from "obsidian";

export type ImageEmbed = { markup: string; source: string; from: number; to: number };
export function imageEmbeds(text: string): ImageEmbed[] {
    const result: ImageEmbed[] = [];
    const pattern = /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g;
    let fence = "";
    let offset = 0;
    for (const line of text.split("\n")) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/);
        if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ""; offset += line.length + 1; continue; }
        if (!fence) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(line))) {
                if ((line.slice(0, match.index).match(/`/g)?.length ?? 0) % 2) continue;
                const raw = (match[1]?.split("|")[0] ?? match[2]).replace(/^<|>$/g, "");
                let source: string;
                try { source = /^https:\/\//i.test(raw) ? raw : decodeURIComponent(raw); } catch { source = raw; }
                result.push({ markup: match[0], source, from: offset + match.index, to: offset + match.index + match[0].length });
            }
        }
        offset += line.length + 1;
    }
    return result;
}

export type ImageAnchor = { original: string; offset: number; before: string; after: string };
export function captureAnchor(original: string, offset: number): ImageAnchor {
    if (offset < 0 || offset > original.length) throw new Error("Image position is unavailable");
    return { original, offset, before: original.slice(Math.max(0, offset - 160), offset), after: original.slice(offset, offset + 160) };
}
export function insertAtAnchor(current: string, anchor: ImageAnchor, addition: string): string {
    let at = anchor.offset;
    if (current !== anchor.original) {
        const context = anchor.before + anchor.after;
        const start = context ? current.indexOf(context) : -1;
        if (start < 0 || current.indexOf(context, start + 1) >= 0) throw new Error("The image position changed. The generated note remains in Pixno.");
        at = start + anchor.before.length;
    }
    return current.slice(0, at) + addition + current.slice(at);
}

type Generate = (view: EditorView, image: ImageEmbed) => Promise<void>;
class ImageButton extends WidgetType {
    constructor(private image: ImageEmbed, private generate: Generate) { super(); }
    toDOM(view: EditorView) {
        const button = document.createElement("button");
        button.className = "photes-button";
        button.type = "button"; button.title = "Generate note from this image";
        button.setAttribute("aria-label", button.title);
        setIcon(button, "sparkles");
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", event => {
            event.preventDefault(); event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            void this.generate(view, this.image).finally(() => { button.disabled = false; });
        });
        return button;
    }
    ignoreEvent() { return true; }
}
export function imageActionExtension(generate: Generate) {
    return ViewPlugin.fromClass(class {
        decorations;
        constructor(view: EditorView) { this.decorations = this.build(view); }
        update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view); }
        build(view: EditorView) {
            const decorations = [];
            const seen = new Set<number>();
            for (const range of view.visibleRanges) {
                for (let position = range.from; position <= range.to;) {
                    const line = view.state.doc.lineAt(position);
                    for (const image of imageEmbeds(line.text)) {
                        const from = line.from + image.from;
                        if (seen.has(from)) continue;
                        let node = syntaxTree(view.state).resolveInner(from, 1);
                        let code = false;
                        for (;;) {
                            if (/code|math/i.test(node.name)) { code = true; break; }
                            if (!node.parent) break;
                            node = node.parent;
                        }
                        if (!code) {
                            seen.add(from);
                            decorations.push(Decoration.widget({ widget: new ImageButton({ ...image, from, to: line.from + image.to }, generate), side: -1 }).range(from));
                        }
                    }
                    if (line.to >= range.to) break;
                    position = line.to + 1;
                }
            }
            return Decoration.set(decorations, true);
        }
    }, { decorations: plugin => plugin.decorations });
}
