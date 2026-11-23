import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export type SyncRecord = { path: string; digest: string; revision: string; block?: string };
export type Preferences = { autoSync: boolean; imagePath: string; syncPath: string };
export const defaults: Preferences = { autoSync: false, imagePath: "assets", syncPath: "Pixno Imports" };
export function vaultFolder(value: string) {
    const path = value.trim().replace(/^\/+|\/+$/g, "");
    if (!path || path.length > 200 || path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")) || /[\\:*?"<>|\[\]#^\u0000-\u001f]/.test(path)) throw new Error("Choose a folder inside this vault, without special characters.");
    return path;
}
export const digest = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
export function replaceSyncedContent(current: string, record: SyncRecord, next: string) {
    if (!record.block) {
        if (digest(current) !== record.digest) throw new Error("Local edits need review before syncing.");
        return next;
    }
    const start = `<!-- pixno:${record.block}:start -->`;
    const end = `<!-- pixno:${record.block}:end -->`;
    const from = current.indexOf(start), to = current.indexOf(end);
    if (from < 0 || to < from || current.indexOf(start, from + 1) >= 0 || current.indexOf(end, to + 1) >= 0) throw new Error("The mobile upload section moved.");
    if (digest(current.slice(from + start.length, to)) !== record.digest) throw new Error("Local edits need review before syncing.");
    return current.slice(0, from + start.length) + next + current.slice(to);
}
