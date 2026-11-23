import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const obsidianShim = {
	name: "obsidian-test-shim",
	setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
		builder.onLoad({ filter: /^obsidian$/, namespace: "test" }, () => ({
			contents: `
				export class TFolder {}
				export class Plugin {}
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
	assert.deepEqual(await client.download(key, 12), { ...notebook, notes: ["First", "Second"] });
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

function pluginHarness(responses, existingPaths = []) {
	const saved = [];
	const created = [];
	const plugin = new PixnoPlugin();
	plugin.loadData = async () => ({ accessToken: "old-key", autoSync: true });
	plugin.saveData = async content => saved.push(content);
	plugin.addSettingTab = () => {};
	plugin.app = {
		vault: {
			getAbstractFileByPath: path => existingPaths.includes(path) ? { path } : null,
			createFolder: async () => {},
			create: async (path, value) => created.push({ path, value }),
		},
	};
	globalThis.pixnoTestRequest = async ({ headers }) => {
		assert.deepEqual(headers, { Authorization: `Bearer ${key}` });
		return responses.shift();
	};
	return { plugin, saved, created };
}

test("drops legacy settings, keeps the new secret in memory and imports only complete Markdown", async () => {
	const { plugin, saved, created } = pluginHarness([
		success({ plugin: "obsidian", access: "read", expires_at: expiry }),
		success({ notebook, notes: [{ id: 13, content: "First" }], next_after: 13 }),
		success({ notebook, notes: [{ id: 19, content: "Second" }], next_after: null }),
	]);
	try {
		await plugin.onload();
		await plugin.connect(key);
		assert.equal(await plugin.importNotebook(12), "Pixno Imports/notebook-12.md");
		assert.deepEqual(saved, [{ v2: true }]);
		assert.deepEqual(created, [{ path: "Pixno Imports/notebook-12.md", value: "# A notebook\n\nFirst\n\nSecond\n" }]);
		plugin.disconnect();
		await assert.rejects(plugin.listNotebooks(), { status: 401 });
	} finally {
		delete globalThis.pixnoTestRequest;
	}
});

test("creates no file after a failed later page and leaves a pre-existing path untouched", async () => {
	for (const priorPath of [false, true]) {
		const { plugin, created } = pluginHarness([
			success({ plugin: "obsidian", access: "read", expires_at: expiry }),
			success({ notebook, notes: [{ id: 13, content: "First" }], next_after: priorPath ? null : 13 }),
			{ status: 503 },
		], priorPath ? ["Pixno Imports/notebook-12.md"] : []);
		try {
			await plugin.connect(key);
			await assert.rejects(plugin.importNotebook(12), { status: priorPath ? 409 : 503 });
			assert.deepEqual(created, []);
		} finally {
			delete globalThis.pixnoTestRequest;
		}
	}
});

test("disconnect cancels the import without requesting further pages or writing a vault file", async () => {
	const { plugin, created } = pluginHarness([success({ plugin: "obsidian", access: "read", expires_at: expiry })]);
	try {
		await plugin.connect(key);
		let requested = 0;
		let complete;
		globalThis.pixnoTestRequest = () => {
			requested++;
			return new Promise(resolve => { complete = resolve; });
		};
		const importResult = plugin.importNotebook(12);
		plugin.disconnect();
		await assert.rejects(importResult, { status: 401 });
		complete(success({ notebook, notes: [{ id: 13, content: "First" }], next_after: 13 }));
		assert.equal(requested, 1);
		assert.deepEqual(created, []);
	} finally {
		delete globalThis.pixnoTestRequest;
	}
});
