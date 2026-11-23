import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const obsidianShim = {
	name: "obsidian-test-shim",
	setup(builder) {
        builder.onResolve({ filter: /^@codemirror\// }, args => ({ path: args.path, namespace: "cm-test" }));
        builder.onLoad({ filter: /.*/, namespace: "cm-test" }, () => ({ contents: `export class WidgetType {} export const ViewPlugin = { fromClass: () => ({}) }; export const Decoration = {}; export const syntaxTree = () => ({});` }));
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
		builder.onLoad({ filter: /^obsidian$/, namespace: "test" }, () => ({
			contents: `
				export class Modal {}
                export class TFolder { static [Symbol.hasInstance](v) { return v?.isFolder === true; } }
				export class Plugin { registerInterval() {} addRibbonIcon() {} addCommand() {} registerEditorExtension() {} registerMarkdownPostProcessor() {} registerEvent() {} }
                export class TFile { static [Symbol.hasInstance](v) { return v?.isFile === true; } }
                export class MarkdownView {}
                export class Menu {}
                export const setIcon = () => {};
                export class Notice { constructor(text) { globalThis.pixnoNotices?.push(text); } hide() {} }
				export class PluginSettingTab {}
				export class Setting {}
				export const normalizePath = path => path;
				export const requestUrl = request => globalThis.pixnoTestRequest(request);
			`,
		}));
	},
};

async function moduleFor(entryPoint) {
	const { outputFiles: [file] } = await build({
		entryPoints: [entryPoint], bundle: true, write: false, format: "esm", plugins: [obsidianShim],
	});
	return import(`data:text/javascript;base64,${Buffer.from(file.contents).toString("base64")}`);
}

const { createPixnoReadClient, PixnoError, pixnoOrigin } = await moduleFor("src/service.ts");
const { default: PixnoPlugin } = await moduleFor("src/main.ts");
const key = "pxo_" + "A".repeat(43);
const expiry = new Date(Date.now() + 3600_000).toISOString();
const notebook = { id: 12, title: "A notebook" };
const success = json => ({ status: 200, json });

test("only sends a v2 Bearer key to the configured HTTPS origin", async () => {
	const seen = [];
	const client = createPixnoReadClient(async ({ url, headers }) => {
		seen.push(new URL(url));
		assert.deepEqual(headers, { Authorization: `Bearer ${key}` });
		return success({ plugin: "obsidian", access: "read", expires_at: expiry });
	}, "https://preview.example");
	await assert.rejects(client.info("old-key"), { status: 401 });
	assert.equal(seen.length, 0);
	assert.equal(await client.info(key), Date.parse(expiry));
	assert.equal(seen[0].href, "https://preview.example/api/plugin/obsidian/v2/info");
	assert.throws(() => pixnoOrigin("http://example.test"));
	assert.throws(() => pixnoOrigin("https://user@example.test/other"));
});

test("paginates notebook results and rejects a stalled cursor", async () => {
	const pages = [
		success({ notebooks: [notebook], next_after: 12 }),
		success({ notebooks: [{ id: 20, title: null }], next_after: null }),
	];
	const client = createPixnoReadClient(async ({ url }) => {
		assert.equal(new URL(url).searchParams.get("after"), pages.length === 2 ? null : "12");
		return pages.shift();
	});
	assert.deepEqual(await client.list(key), [notebook, { id: 20, title: null }]);
	const stalled = createPixnoReadClient(async () => success({ notebooks: [], next_after: 12 }));
	await assert.rejects(stalled.list(key), error => error instanceof PixnoError && error.status === 502);
});

test("retries an oversized download page with a smaller limit and preserves cursor order", async () => {
	const requests = [];
	const client = createPixnoReadClient(async ({ url }) => {
		const query = new URL(url).searchParams;
		requests.push([query.get("after"), query.get("limit")]);
		if (requests.length === 1) return { status: 413 };
		return requests.length === 2
			? success({ notebook, notes: [{ id: 13, content: "First" }], next_after: 13 })
			: success({ notebook, notes: [{ id: 19, content: "Second" }], next_after: null });
	});
	assert.deepEqual(await client.download(key, 12), { ...notebook, notes: ["First", "Second"], noteIds: [13,19], imageNoteIds: [] });
	assert.deepEqual(requests, [[null, "10"], [null, "5"], ["13", "5"]]);
});

test("fails closed for mismatched notebook ID, authorization loss and maintenance", async () => {
	for (const result of [
		[502, success({ notebook: { id: 908, title: null }, notes: [], next_after: null })],
		[401, { status: 401 }],
		[503, { status: 503 }],
	]) {
		const client = createPixnoReadClient(async () => result[1]);
		await assert.rejects(client.download(key, 12), { status: result[0] });
	}
});

const code = "C".repeat(43);
const firstRefresh = "pxor_" + "D".repeat(43);
const nextRefresh = "pxor_" + "E".repeat(43);
const minted = (refreshToken = firstRefresh, expires = 900) => success({
	access_token: key,
	refresh_token: refreshToken,
	expires_in: expires,
	token_type: "Bearer",
});
const originKey = createHash("sha256").update("https://photes.io").digest("hex").slice(0, 32);
const secretId = `pixno-refresh-${originKey}`;

function pluginHarness(responses, { previous, secret, existingPaths = [] } = {}) {
	const saved = [];
	const created = [];
	const requests = [];
	const secrets = new Map(secret ? [[secretId, secret]] : []);
	const plugin = new PixnoPlugin();
	let callback;
	let opened;
	plugin.loadData = async () => previous ?? { accessToken: "old-key", autoSync: true };
	plugin.saveData = async content => saved.push(content);
	plugin.addSettingTab = () => {};
	plugin.registerObsidianProtocolHandler = (name, handler) => {
		assert.equal(name, "pixno-auth");
		callback = handler;
	};
	plugin.app = {
		secretStorage: {
			getSecret: id => secrets.get(id) ?? null,
			setSecret: (id, value) => { secrets.set(id, value); },
		},
		workspace: { on: () => ({}) },
        vault: {
			getAbstractFileByPath: path => existingPaths.includes(path) ? { path } : null,
			createFolder: async () => {},
			create: async (path, value) => created.push({ path, value }),
		},
	};
	globalThis.window = { setInterval: () => 1, open: (url, target, flags) => {
		assert.equal(target, "_blank");
		assert.match(flags, /noopener/);
		opened = new URL(url);
	} };
	globalThis.pixnoTestRequest = async request => {
		const url = new URL(request.url);
		assert.equal(url.origin, "https://photes.io");
		assert.ok(url.pathname.startsWith("/api/plugin/obsidian/v2/"));
		if (request.method === "POST") {
			assert.equal(url.search, "");
			assert.deepEqual(request.headers, { "Content-Type": "application/json" });
		} else {
			assert.deepEqual(request.headers, { Authorization: `Bearer ${key}` });
		}
		requests.push(request);
		const response = responses.shift();
		return typeof response === "function" ? response(request) : response;
	};
	function start() {
		plugin.beginLogin();
		assert.equal(opened.origin, "https://photes.io");
		assert.equal(opened.pathname, "/plugin/obsidian/authorize");
		assert.deepEqual([...opened.searchParams.keys()], ["state", "code_challenge", "code_challenge_method", "scope"]);
		assert.equal(opened.searchParams.get("code_challenge_method"), "S256");
		return { action: "pixno-auth", code, state: opened.searchParams.get("state") };
	}
	return { plugin, saved, created, requests, secrets, start, callback: params => callback(params), opened: () => opened };
}

test("exchanges a browser code once after matching state and PKCE, then imports complete Markdown", async () => {
	const h = pluginHarness([
		minted(),
		success({ notebook, notes: [{ id: 13, content: "First" }], next_after: 13 }),
		success({ notebook, notes: [{ id: 19, content: "Second" }], next_after: null }),
	]);
	await h.plugin.onload();
	const callback = h.start();
	await h.callback({ ...callback, state: "Z".repeat(43) });
	await h.callback({ ...callback, extra: "unexpected" });
	assert.equal(h.requests.length, 0);
	await h.callback(callback);
	await h.callback(callback);
	assert.equal(h.requests.length, 1);
	const { grant_type, code: authCode, code_verifier } = JSON.parse(h.requests[0].body);
	assert.equal(grant_type, "authorization_code");
	assert.equal(authCode, code);
	assert.match(code_verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(createHash("sha256").update(code_verifier).digest("base64url"), h.opened().searchParams.get("code_challenge"));
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.deepEqual(h.saved.map(({ version, pendingRotations }) => ({ version, pendingRotations })), [{ version: 4, pendingRotations: [] }, { version: 4, pendingRotations: [] }]);
	assert.equal(await h.plugin.importNotebook(12), "Pixno Imports/notebook-12.md");
	assert.deepEqual(h.created, [{ path: "Pixno Imports/notebook-12.md", value: "# A notebook\n\nFirst\n\nSecond\n" }]);
	h.plugin.onunload();
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.equal(h.requests.length, 3);
});

test("rejects expired and superseded callbacks before exchange", async t => {
	let time = Date.now();
	t.mock.method(Date, "now", () => time);
	const h = pluginHarness([]);
	await h.plugin.onload();
	const stale = h.start();
	const current = h.start();
	await h.callback(stale);
	time += 5 * 60_000;
	await h.callback(current);
	assert.equal(h.requests.length, 0);
	assert.equal(h.plugin.hasSession, false);
});

test("coalesces startup rotation and concurrent requests and rotates again on expiry", async t => {
	let time = Date.now();
	t.mock.method(Date, "now", () => time);
	const rows = success({ notebooks: [notebook], next_after: null });
	const h = pluginHarness([minted(nextRefresh, 2), rows, rows, minted(firstRefresh), rows], {
		previous: { version: 4, pendingRotations: [] }, secret: firstRefresh,
	});
	await h.plugin.onload();
	assert.deepEqual(await Promise.all([h.plugin.listNotebooks(), h.plugin.listNotebooks()]), [[notebook], [notebook]]);
	assert.equal(h.requests.filter(x => x.method === "POST").length, 1);
	assert.deepEqual(JSON.parse(h.requests[0].body), { grant_type: "refresh_token", refresh_token: firstRefresh });
	assert.equal(h.secrets.get(secretId), nextRefresh);
	assert.deepEqual(h.saved.map(({ version, pendingRotations }) => ({ version, pendingRotations })), [{ version: 4, pendingRotations: [originKey] }, { version: 4, pendingRotations: [] }]);
	time += 3_000;
	assert.deepEqual(await h.plugin.listNotebooks(), [notebook]);
	assert.deepEqual(JSON.parse(h.requests[3].body), { grant_type: "refresh_token", refresh_token: nextRefresh });
	h.plugin.onunload();
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.equal(h.requests.filter(x => x.url.endsWith("/logout")).length, 0);
});

test("preserves the local secret after ambiguous refresh and never replays it across restarts", async () => {
	const h = pluginHarness([() => { throw new Error("private transient provider response"); }], {
		previous: { version: 4, pendingRotations: [] }, secret: firstRefresh,
	});
	await h.plugin.onload();
	await assert.rejects(h.plugin.listNotebooks(), { status: 503 });
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.equal(h.plugin.needsLogin, true);
	const restarted = pluginHarness([], { previous: h.saved.at(-1), secret: h.secrets.get(secretId) });
	await restarted.plugin.onload();
	await assert.rejects(restarted.plugin.listNotebooks(), { status: 401 });
	assert.equal(restarted.requests.length, 0);
	assert.equal(restarted.secrets.get(secretId), firstRefresh);
});

test("allows retry only when the server rejected rotation before executing it", async () => {
	const h = pluginHarness([{ status: 429, json: { error: "rate_limited" } }, minted(nextRefresh), success({ notebooks: [notebook], next_after: null })], {
		previous: { version: 4, pendingRotations: [] }, secret: firstRefresh,
	});
	await h.plugin.onload();
	await assert.rejects(h.plugin.listNotebooks(), { status: 429 });
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.equal(h.plugin.needsLogin, false);
	assert.deepEqual(await h.plugin.listNotebooks(), [notebook]);
	assert.equal(h.secrets.get(secretId), nextRefresh);
});

test("clears invalid grants and logs out by exact refresh token with a local clear", async () => {
	const denied = pluginHarness([{ status: 401 }], { previous: { version: 4, pendingRotations: [] }, secret: firstRefresh });
	await denied.plugin.onload();
	await assert.rejects(denied.plugin.listNotebooks(), { status: 401 });
	assert.equal(denied.plugin.hasSession, false);

	const h = pluginHarness([minted(), { status: 204 }]);
	await h.plugin.onload();
	await h.callback(h.start());
	await h.plugin.logout();
	assert.equal(h.requests[1].url, "https://photes.io/api/plugin/obsidian/v2/logout");
	assert.deepEqual(JSON.parse(h.requests[1].body), { refresh_token: firstRefresh });
	assert.equal(h.secrets.get(secretId), "");
	assert.equal(h.plugin.hasSession, false);
	await assert.rejects(h.plugin.listNotebooks(), { status: 401 });
});

test("rejects late refresh after logout and preserves no local credentials on failed revocation", async () => {
	let finish;
	const work = new Promise(resolve => { finish = resolve; });
	const h = pluginHarness([() => work, { status: 503 }], { previous: { version: 4, pendingRotations: [] }, secret: firstRefresh });
	await h.plugin.onload();
	const access = h.plugin.listNotebooks();
	access.catch(() => {});
	while (h.requests.length === 0) await new Promise(resolve => setImmediate(resolve));
	await assert.rejects(h.plugin.logout(), { status: 503 });
	finish(minted(nextRefresh));
	await assert.rejects(access, { status: 401 });
	assert.equal(h.secrets.get(secretId), "");
	assert.equal(h.requests.length, 2);
});

test("never creates a file after failed pagination or if the path is already taken", async () => {
	for (const priorPath of [false, true]) {
		const h = pluginHarness([
			minted(),
			success({ notebook, notes: [{ id: 13, content: "First" }], next_after: priorPath ? null : 13 }),
			{ status: 503 },
		], { existingPaths: priorPath ? ["Pixno Imports/notebook-12.md"] : [] });
		await h.plugin.onload();
		await h.callback(h.start());
		await assert.rejects(h.plugin.importNotebook(12), { status: priorPath ? 409 : 503 });
		assert.deepEqual(h.created, []);
	}
});

test("does not let a late exchange replace a newer browser login", async () => {
	let finish;
	const work = new Promise(resolve => { finish = resolve; });
	const h = pluginHarness([() => work, minted(nextRefresh)]);
	await h.plugin.onload();
	const first = h.callback(h.start());
	const latest = h.start();
	await h.callback(latest);
	finish(minted(firstRefresh));
	await first;
	assert.equal(h.secrets.get(secretId), nextRefresh);
	assert.equal(h.requests.length, 2);
});

test("revokes a newly exchanged grant when vault secret storage rejects the write", async () => {
	const h = pluginHarness([minted(), { status: 204 }], { previous: { version: 4, pendingRotations: [] } });
	h.plugin.app.secretStorage.setSecret = () => { throw new Error("storage unavailable"); };
	await h.plugin.onload();
	await h.callback(h.start());
	assert.equal(h.plugin.hasSession, false);
	assert.equal(h.requests.length, 2);
	assert.ok(h.requests[1].url.endsWith("/logout"));
	assert.deepEqual(JSON.parse(h.requests[1].body), { refresh_token: firstRefresh });
});

test("revokes the known grant and clears its exact secret when settings storage fails", async () => {
	const h = pluginHarness([minted(), { status: 204 }], { previous: { version: 4, pendingRotations: [] } });
	const save = h.plugin.saveData;
	let first = true;
	h.plugin.saveData = async value => {
		if (first) {
			first = false;
			throw new Error("settings unavailable");
		}
		return save(value);
	};
	await h.plugin.onload();
	await h.callback(h.start());
	assert.equal(h.secrets.get(secretId), "");
	assert.equal(h.plugin.hasSession, false);
	assert.equal(h.requests.length, 2);
	assert.deepEqual(JSON.parse(h.requests[1].body), { refresh_token: firstRefresh });
});

test("revokes a known rotated grant after a failed local write and does not replay the old refresh secret", async () => {
	const h = pluginHarness([minted(nextRefresh), { status: 204 }], {
		previous: { version: 4, pendingRotations: [] }, secret: firstRefresh,
	});
	h.plugin.app.secretStorage.setSecret = () => { throw new Error("storage unavailable"); };
	await h.plugin.onload();
	await assert.rejects(h.plugin.listNotebooks(), { status: 503 });
	assert.deepEqual(JSON.parse(h.requests[1].body), { refresh_token: nextRefresh });
	assert.equal(h.secrets.get(secretId), firstRefresh);
	assert.equal(h.plugin.needsLogin, true);
	await assert.rejects(h.plugin.listNotebooks(), { status: 401 });
	assert.equal(h.requests.length, 2);
});

test("late save-failure cleanup leaves a different login's credential intact", async () => {
	let failSave;
	const failedWrite = new Promise((_resolve, reject) => { failSave = reject; });
	const h = pluginHarness([minted(), minted(nextRefresh), { status: 204 }, { status: 204 }], {
		previous: { version: 4, pendingRotations: [] },
	});
	const save = h.plugin.saveData;
	let first = true;
	h.plugin.saveData = value => {
		if (first) {
			first = false;
			return failedWrite;
		}
		return save(value);
	};
	await h.plugin.onload();
	const superseded = h.callback(h.start());
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.secrets.get(secretId), firstRefresh);
	const active = h.callback(h.start());
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.secrets.get(secretId), nextRefresh);
	failSave(new Error("previous settings write failed"));
	await Promise.all([superseded, active]);
	assert.equal(h.secrets.get(secretId), nextRefresh);
	const revocations = h.requests.filter(request => request.url.endsWith("/logout"));
	assert.ok(revocations.length > 0);
	assert.ok(revocations.every(request => JSON.parse(request.body).refresh_token === firstRefresh));
});


test("source-image download keeps bearer on Pixno and detects image associations", async () => {
 const calls = [];
 const bytes = new Uint8Array([137,80,78,71,13,10,26,10]).buffer;
 const client = createPixnoReadClient(async request => {
  calls.push(request);
  if (request.url.includes("/download")) return success({ notebook, notes: [{ id: 13, content: "Image note", has_image: true }], next_after: null });
  if (request.url.includes("/v2/image")) return success({ url: "https://storage.example/storage/v1/object/sign/images/owner/image.png?token=short" });
  assert.deepEqual(request.headers, {});
  return { status: 200, json: null, arrayBuffer: bytes };
 });
 assert.deepEqual((await client.download(key, 12)).imageNoteIds, [13]);
 assert.equal(await client.image(key, 13), bytes);
 assert.equal(calls[1].headers.Authorization, `Bearer ${key}`);
});

test("generation is not retried and preserves permission errors", async () => {
 let calls = 0;
 const client = createPixnoReadClient(async request => {
  calls++;
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "image/png");
  return { status: 403, json: { error: "image_permission_required" } };
 });
 await assert.rejects(client.generate(key, new ArrayBuffer(8), "image/png"), error => error.code === "image_permission_required");
 assert.equal(calls, 1);
});

test("imports image bytes as vault attachments and embeds them in the notebook", async () => {
 const h = pluginHarness([minted()]); await h.plugin.onload(); await h.callback(h.start());
 const bytes = new Uint8Array([137,80,78,71,13,10,26,10]).buffer;
 const assets = [];
 h.plugin.client = { download: async () => ({ ...notebook, notes: ["Photo text"], noteIds: [13,14], imageNoteIds: [13] }), image: async () => bytes };
 h.plugin.app.vault.createBinary = async (path, data) => { assets.push({ path, data }); return { path }; };
 await h.plugin.importNotebook(12);
 assert.equal(assets.length, 1); assert.equal(assets[0].data, bytes);
 assert.match(assets[0].path, /^assets\/notebook-12-images\/note-13-[a-f0-9]{64}.png$/);
 assert.ok(h.created[0].value.includes(`![[${assets[0].path}]]`));
});

test("an interrupted image download does not save an incomplete notebook or attachments", async () => {
 const h = pluginHarness([minted()]); await h.plugin.onload(); await h.callback(h.start());
 let calls = 0; const assets = [];
 h.plugin.client = { download: async () => ({ ...notebook, notes: ["Photo text"], noteIds: [13,14], imageNoteIds: [13,14] }), image: async () => {
  if (++calls === 2) throw new PixnoError(503);
  return new Uint8Array([137,80,78,71,13,10,26,10]).buffer;
 } };
 h.plugin.app.vault.createBinary = async (...args) => assets.push(args);
 await assert.rejects(h.plugin.importNotebook(12), { status: 503 });
 assert.equal(assets.length, 0); assert.equal(h.created.length, 0);
});


test("respects notebook note order and places each image under its own heading", async () => {
 const client = createPixnoReadClient(async () => success({ notebook: { ...notebook, note_orders: [19,13] }, notes: [
  { id: 13, content: "# First\n\nFirst body", has_image: true },
  { id: 19, content: "# Second\n\nSecond body", has_image: true },
 ], next_after: null }));
 const value = await client.download(key, 12);
 const { notebookMarkdown } = await moduleFor("src/service.ts");
 const result = notebookMarkdown(value, new Map([[13,"first.png"],[19,"second.png"]]));
 assert.equal(result, "# A notebook\n\n# Second\n\n![[second.png]]\n\nSecond body\n\n# First\n\n![[first.png]]\n\nFirst body\n");
 assert.ok(!result.includes("Source images"));
});

test("image action anchors survive unrelated edits and refuse ambiguous moved images", async () => {
 const { imageEmbeds, captureAnchor, insertAtAnchor } = await moduleFor("src/image-actions.ts");
 const text = "# Heading\n![[one.png|300]]\nText\n![two](two.jpg)\n";
 const embeds = imageEmbeds(text);
 assert.deepEqual(embeds.map(x => x.source), ["one.png", "two.jpg"]);
 const anchor = captureAnchor(text, embeds[0].to);
 assert.equal(insertAtAnchor("prefix\n"+text, anchor, "\nGenerated"), "prefix\n# Heading\n![[one.png|300]]\nGenerated\nText\n![two](two.jpg)\n");
 assert.throws(() => insertAtAnchor(text.replace("one.png", "changed.png"), anchor, "Generated"));
 assert.equal(imageEmbeds("```\n![[code.png]]\n```\n`![[inline.png]]`").length, 0);
});

test("sync protects local edits and mobile blocks preserve unrelated surrounding text", async () => {
    const { digest, replaceSyncedContent, vaultFolder } = await moduleFor("src/sync-state.ts");
    const original = "# Cloud\nbody";
    const record = { path: "notes/cloud.md", digest: digest(original), revision: "" };
    assert.equal(replaceSyncedContent(original, record, "new"), "new");
    assert.throws(() => replaceSyncedContent(original + " local", record, "new"));
    const block = { ...record, block: "12" };
    const current = `local before\n<!-- pixno:12:start -->${original}<!-- pixno:12:end -->\nlocal after`;
    assert.equal(replaceSyncedContent(current, block, "new"), "local before\n<!-- pixno:12:start -->new<!-- pixno:12:end -->\nlocal after");
    assert.throws(() => replaceSyncedContent(current.replace("body", "edited"), block, "new"));
    assert.throws(() => replaceSyncedContent(current + current, block, "new"));
    for (const path of ["../outside", ".obsidian", "a/../b", "C:\\outside", "a/[[bad]]"]) assert.throws(() => vaultFolder(path));
    assert.equal(vaultFolder("/custom/images/"), "custom/images");
});

test("sync revision checks and mobile creation never expose a bearer in a QR URL or replay POST", async () => {
    const seen = [];
    const client = createPixnoReadClient(async request => {
        seen.push(request);
        return request.method === "POST" ? success({ notebook_id: 123, login_path: `/auth/quick-login?next=${encodeURIComponent("/workspace/notebook?notebook_id=123")}#${"A".repeat(43)}` }) : success({ revision: "a".repeat(64) });
    });
    assert.equal(await client.revision(key, 123), "a".repeat(64));
    assert.deepEqual(await client.mobile(key), { notebookId: 123, loginUrl: `https://photes.io/auth/quick-login?next=${encodeURIComponent("/workspace/notebook?notebook_id=123")}#${"A".repeat(43)}` });
    assert.equal(seen[1].url, "https://photes.io/api/plugin/obsidian/v2/mobile");
    assert.deepEqual(seen[1].headers, { Authorization: `Bearer ${key}`, "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(seen[1].body), { notebook_id: null });
    let attempts = 0;
    const failed = createPixnoReadClient(async () => { attempts++; throw new Error("connection lost"); });
    await assert.rejects(failed.mobile(key));
    assert.equal(attempts, 1);
});

test("custom folders persist across plugin reload without storing credentials", async () => {
    const h = pluginHarness([]);
    await h.plugin.onload();
    await h.plugin.savePreferences({ imagePath: "Media/Photos", syncPath: "Cloud/Pixno" });
    const saved = h.saved.at(-1);
    assert.deepEqual(saved.preferences, { autoSync: false, imagePath: "Media/Photos", syncPath: "Cloud/Pixno" });
    assert.equal(JSON.stringify(saved).includes("pxor_"), false);
    const other = pluginHarness([]);
    other.plugin.loadData = async () => saved;
    await other.plugin.onload();
    assert.deepEqual(other.plugin.preferences, saved.preferences);
});

test("automatic sync skips unchanged revisions and advances past a local conflict", async () => {
    const h = pluginHarness([minted()]); await h.plugin.onload(); await h.callback(h.start());
    const imported = [];
    h.plugin.client = { list: async () => [{ id: 12 }, { id: 13 }, { id: 14 }], revision: async () => "b".repeat(64) };
    h.plugin.syncRecords["12"] = { path: "old.md", digest: "c".repeat(64), revision: "b".repeat(64) };
    h.plugin.importWithImages = async id => { imported.push(id); if (id === 13) throw new Error("local edits"); };
    await h.plugin.syncNotes();
    assert.deepEqual(imported, [13, 14]);
    assert.equal(h.plugin.syncing, false);
    assert.equal(h.plugin.importing, false);
});

test("rejects a QR for a different origin, notebook or malformed one-time token", async () => {
 for (const login_path of ["https://evil.test/auth/quick-login#"+"A".repeat(43), "/workspace/notebook?notebook_id=123", "/auth/quick-login?next=%2Fworkspace%2Fnotebook%3Fnotebook_id%3D999#"+"A".repeat(43)]) {
  const client = createPixnoReadClient(async () => success({ notebook_id:123, login_path }));
  await assert.rejects(client.mobile(key), { status:502 });
 }
});

test("phone login changes modal state only after confirmation and sync continues with Auto Sync off", async () => {
 const h=pluginHarness([minted()]);await h.plugin.onload();await h.callback(h.start());
 let connected=false, closed=0;const synced=[];
 h.plugin.client={mobileStatus:async()=>connected};
 h.plugin.syncRecords["12"]={path:"test.md",digest:"a".repeat(64),revision:"",block:"12"};
 h.plugin.pendingMobileLogins.set(12,{hash:"a".repeat(64),until:Date.now()+60_000,modal:{showConnected(){closed++;},close(){throw new Error("must stay open");}}});
 h.plugin.syncNotebook=async id=>{synced.push(id);};
 await h.plugin.syncMobileNotes();assert.equal(closed,0);
 connected=true;await h.plugin.syncMobileNotes();assert.equal(closed,1);
 await h.plugin.syncMobileNotes();assert.equal(closed,1);assert.deepEqual(synced,[12,12,12]);
 assert.equal(h.plugin.preferences.autoSync,false);
 h.plugin.onunload();await h.plugin.syncMobileNotes();assert.equal(synced.length,3);
});

test("phone delivery reports success only after images and text are written, without duplicate notices", async () => {
 const h=pluginHarness([minted()]);await h.plugin.onload();await h.callback(h.start());
 const {digest}=await moduleFor("src/sync-state.ts");
 const initial="Waiting";let text=`before<!-- pixno:12:start -->${initial}<!-- pixno:12:end -->after`;
 const files=new Map([["test.md",{isFile:true,path:"test.md"}]]);
 h.plugin.app.vault={
  getAbstractFileByPath:path=>files.get(path),createFolder:async path=>files.set(path,{isFolder:true}),
  createBinary:async(path,bytes)=>{const f={isFile:true,path,bytes};files.set(path,f);return f;},
  readBinary:async f=>f.bytes,process:async(f,update)=>{text=update(text);},
 };
 h.plugin.client={download:async()=>({id:12,title:"Phone",notes:["# Test\nbody"],noteIds:[13],imageNoteIds:[13]}),image:async()=>new Uint8Array([137,80,78,71]).buffer};
 const received=[];h.plugin.mobileNotebookId=12;h.plugin.mobileModal={showReceived:notes=>received.push(notes)};
 globalThis.pixnoNotices=[];
 await h.plugin.importWithImages(12,{path:"test.md",block:"12",digest:digest(initial),revision:""},"v1");
 assert.match(text,/before<!-- pixno:12:start -->/);assert.match(text,/!\[\[assets\//);assert.match(text,/body/);assert.ok(text.endsWith("<!-- pixno:12:end -->after"));
 assert.equal(globalThis.pixnoNotices.length,1);assert.deepEqual(received.at(-1),[{id:13,title:"Test"}]);
 await h.plugin.importWithImages(12,h.plugin.syncRecords["12"],"v2");assert.equal(globalThis.pixnoNotices.length,1);
 h.plugin.client.image=async()=>{throw new Error("offline");};
 await assert.rejects(h.plugin.importWithImages(12,h.plugin.syncRecords["12"],"v3"));assert.equal(globalThis.pixnoNotices.length,1);
 delete globalThis.pixnoNotices;
});

test("mobile dialog replaces the QR with connection state and saved note titles", async () => {
 globalThis.window.clearTimeout=clearTimeout;
 const {MobileUploadModal}=await moduleFor("src/mobile.ts");
 const modal=new MobileUploadModal({},"https://example.invalid",async()=>"");
 const rendered=[];
 const element={empty(){rendered.length=0;},createEl(tag,options){rendered.push({tag,...options});return element;}};
 modal.contentEl=element;
 modal.showConnected();
 assert.ok(rendered.some(x=>x.text==="Phone connected"));
 assert.ok(rendered.some(x=>x.text==="Waiting for images and notes…"));
 modal.showReceived([{id:1,title:"First note"},{id:2,title:"<img src=x onerror=alert(1)>"}]);
 assert.deepEqual(rendered.filter(x=>x.tag==="li").map(x=>x.text),["First note","<img src=x onerror=alert(1)>"]);
 modal.showConnected();assert.equal(rendered.filter(x=>x.tag==="li").length,2);
 modal.onClose();modal.showReceived([{id:3,title:"Later"}]);assert.equal(rendered.length,0);
});
