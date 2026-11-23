const DEFAULT_ORIGIN = "https://photes.io";
const API_ROOT = "/api/plugin/obsidian/v2";
const MAX_PAGES = 80;
const REQUEST_TIMEOUT_MS = 12_000;
const OPERATION_TIMEOUT_MS = 90_000;
const MAX_NOTEBOOK_CHARS = 8 * 1024 * 1024;
const KEY_PATTERN = /^pxo_[A-Za-z0-9_-]{43}$/;
declare const PIXNO_API_ORIGIN: string | undefined;

export function pixnoOrigin(value = typeof PIXNO_API_ORIGIN === "string" ? PIXNO_API_ORIGIN : DEFAULT_ORIGIN) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Invalid Pixno API origin");
	}
	return url.origin;
}

export function isAccessKey(value: string) {
	return KEY_PATTERN.test(value);
}

export class PixnoError extends Error {
	constructor(readonly status: number) {
		super("Pixno request failed");
	}
}

type JsonObject = Record<string, unknown>;
type RequestBudget = { signal?: AbortSignal; deadline: number };
type Transport = (request: { url: string; headers: Record<string, string> }) => Promise<{ status: number; json: unknown }>;
export type Notebook = { id: number; title: string | null };

function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new PixnoError(502);
	return value as JsonObject;
}

function positiveId(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new PixnoError(502);
	return value;
}

function cursor(value: unknown, lastId: number, previous: number): number | null {
	if (value === null) return null;
	const next = positiveId(value);
	if (next !== lastId || next <= previous) throw new PixnoError(502);
	return next;
}

function notebook(value: unknown): Notebook {
	const source = object(value);
	if (source.title !== null && typeof source.title !== "string") throw new PixnoError(502);
	return { id: positiveId(source.id), title: source.title };
}

function budget(signal?: AbortSignal): RequestBudget {
	return { signal, deadline: Date.now() + OPERATION_TIMEOUT_MS };
}

export function createPixnoReadClient(request: Transport, apiOrigin = pixnoOrigin()) {
	const origin = pixnoOrigin(apiOrigin);
	async function get(path: string, key: string, operation: RequestBudget, params?: URLSearchParams) {
		if (!isAccessKey(key) || operation.signal?.aborted) throw new PixnoError(401);
		const timeoutMs = Math.min(operation.deadline - Date.now(), REQUEST_TIMEOUT_MS);
		if (timeoutMs <= 0) throw new PixnoError(503);
		const url = new URL(`${API_ROOT}${path}`, origin);
		if (params) url.search = params.toString();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const stop = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new PixnoError(503)), timeoutMs);
			onAbort = () => reject(new PixnoError(401));
			operation.signal?.addEventListener("abort", onAbort, { once: true });
		});
		let response: Awaited<ReturnType<Transport>>;
		try {
			response = await Promise.race([request({ url: url.href, headers: { Authorization: `Bearer ${key}` } }), stop]);
		} finally {
			clearTimeout(timer);
			if (onAbort) operation.signal?.removeEventListener("abort", onAbort);
		}
		if (operation.signal?.aborted) throw new PixnoError(401);
		if (response.status !== 200) throw new PixnoError(response.status);
		return object(response.json);
	}

	return {
		async info(key: string, signal?: AbortSignal) {
			const value = await get("/info", key, budget(signal));
			if (value.plugin !== "obsidian" || value.access !== "read" || typeof value.expires_at !== "string") {
				throw new PixnoError(502);
			}
			const expiry = Date.parse(value.expires_at);
			if (!Number.isFinite(expiry)) throw new PixnoError(502);
			if (expiry <= Date.now()) throw new PixnoError(401);
			return expiry;
		},
		async list(key: string, signal?: AbortSignal) {
			const operation = budget(signal);
			const notebooks: Notebook[] = [];
			let after = 0;
			for (let page = 0; page < MAX_PAGES; page++) {
				const params = after ? new URLSearchParams({ after: String(after) }) : undefined;
				const result = await get("/list", key, operation, params);
				if (!Array.isArray(result.notebooks) || result.notebooks.length > 50) throw new PixnoError(502);
				let lastId = after;
				for (const item of result.notebooks) {
					const entry = notebook(item);
					if (entry.id <= lastId) throw new PixnoError(502);
					lastId = entry.id;
					notebooks.push(entry);
				}
				const next = cursor(result.next_after, lastId, after);
				if (next === null) return notebooks;
				after = next;
			}
			throw new PixnoError(413);
		},
		async download(key: string, notebookId: number, signal?: AbortSignal) {
			positiveId(notebookId);
			const operation = budget(signal);
			let after = 0;
			let limit = 10;
			let title: string | null = null;
			let characters = 0;
			const notes: string[] = [];
			for (let page = 0; page < MAX_PAGES; page++) {
				const params = new URLSearchParams({ id: String(notebookId), limit: String(limit) });
				if (after) params.set("after", String(after));
				let result: JsonObject;
				try {
					result = await get("/download", key, operation, params);
				} catch (error) {
					if (!(error instanceof PixnoError) || error.status !== 413 || limit === 1) throw error;
					limit = Math.max(1, Math.floor(limit / 2));
					continue;
				}
				const entry = notebook(result.notebook);
				if (entry.id !== notebookId || !Array.isArray(result.notes) || result.notes.length > limit) {
					throw new PixnoError(502);
				}
				title = entry.title;
				let lastId = after;
				for (const item of result.notes) {
					const note = object(item);
					const id = positiveId(note.id);
					const content = note.content;
					if (id <= lastId || typeof content !== "string") throw new PixnoError(502);
					lastId = id;
					characters += content.length + 2;
					if (characters > MAX_NOTEBOOK_CHARS) throw new PixnoError(413);
					notes.push(content);
				}
				const next = cursor(result.next_after, lastId, after);
				if (next === null) return { id: notebookId, title, notes };
				after = next;
			}
			throw new PixnoError(413);
		},
	};
}

export function notebookMarkdown(value: { id: number; title: string | null; notes: string[] }) {
	const title = (value.title ?? "").replace(/[\r\n\u0000-\u001f]+/g, " ").trim();
	return [`# ${title || `Pixno notebook ${value.id}`}`, ...value.notes].join("\n\n") + "\n";
}
