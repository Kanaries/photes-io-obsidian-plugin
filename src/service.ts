import { App, normalizePath } from "obsidian";
import { loadImageBlob, retry } from "./helpers";
import { upload } from "@vercel/blob/client";
import pLimit from "p-limit";

const BASE_URL = "https://photes.io";

export async function getInfo(accessKey: string) {
	let response: Response;
	try {
		response = await fetch(`${BASE_URL}/api/plugin/info`, {
			headers: {
				"access-key": accessKey,
			},
		});
	} catch (e) {
		throw new Error("Sorry, something went wrong. Please try again.");
	}
	if (!response.ok) {
		let result;
		try {
			result = await response.json();
		} catch (e) {
			throw new Error("Sorry, something went wrong. Please try again.");
		}
		if (result) {
			throw new Error(result.message);
		}
	}
	return await response.json();
}

async function putBlob(
	filename: string,
	blob: Blob,
	key: string
): Promise<string> {
	const result = await upload(filename, blob, {
		access: "public",
		handleUploadUrl: `${BASE_URL}/api/plugin/client_upload`,
		clientPayload: key,
	});
	return result.url;
}

export async function getNote(
	image: string | Blob,
	accessKey: string,
	onWrite: (note: string) => void,
	onUploadEnd: () => void
) {
	let blob: Blob;
	if (image instanceof Blob) {
		blob = image;
	} else {
		blob = await loadImageBlob(image);
	}
	let formData: FormData;
	const randomGuid = window.URL.createObjectURL(new Blob([]))
		.split("/")
		.pop();
	const filename = `${randomGuid}.${blob.type.split("/")[1]}`;
	if (blob.size > 1024 * 1024) {
		try {
			const path = await putBlob(filename, blob, accessKey);
			formData = new FormData();
			formData.append("path", path);
		} catch (e) {
			throw new Error(
				"Sorry, something went wrong when uploading image. Please try again."
			);
		}
	} else {
		formData = new FormData();
		formData.append("file", blob, filename);
	}
	let noteResp: Response;
	try {
		noteResp = await fetch(`${BASE_URL}/api/plugin/make_note`, {
			method: "POST",
			body: formData,
			headers: {
				"access-key": accessKey,
			},
		});
	} catch (e) {
		throw new Error("Sorry, something went wrong. Please try again.");
	}
	onUploadEnd();

	if (!noteResp.ok) {
		let result;
		try {
			result = await noteResp.json();
		} catch (e) {
			throw new Error("Sorry, something went wrong. Please try again.");
		}
		if (result) {
			throw new Error(result.message);
		}
	}
	const reader = noteResp.body?.getReader();
	if (reader) {
		onWrite("\n");
		return reader
			.read()
			.then(function processText({ done, value }): Promise<void> {
				onWrite(new TextDecoder().decode(value));
				if (done) {
					return Promise.resolve();
				}
				return reader.read().then(processText);
			});
	}
}

export async function login() {
	window.open(`${BASE_URL}/obsidian/login`);
}

export async function getDownloadList(
	accessKey: string,
	fromTimestamp?: number
): Promise<{
	lastUpdated: number;
	fileList: {
		assets: string[];
		markdowns: { url: string; name: string }[];
	};
}> {
	const resp = await fetch(
		`${BASE_URL}/api/plugin/list?timestamp=${fromTimestamp ?? 0}`,
		{
			headers: {
				"access-key": accessKey,
			},
		}
	);
	if (resp.ok) {
		return resp.json();
	} else {
		throw new Error("Sorry, something went wrong. Please try again.");
	}
}

export const removeNotebook = async (
	app: App,
	path: string,
	notebook_id: number
) => {
	const ending = `-${notebook_id}.md`;
	const file = app.vault
		.getFolderByPath(normalizePath(path))
		?.children.find((x) => x.name.endsWith(ending));
	if (file) {
		await app.vault.delete(file);
	}
};

export const downloadAssets =
	(app: App, accessKey: string, path: string) =>
	async (item: { url: string; dest: string; needAuth?: boolean }) => {
		const resp = await fetch(item.url, {
			headers: item.needAuth
				? {
						"access-key": accessKey,
				  }
				: undefined,
		});
		if (item.dest.endsWith(".md")) {
			// overwrite existing markdown
			const ending = item.dest.split("-").at(-1);
			const filename = item.dest.split("/").at(-1);
			if (ending) {
				const file = app.vault
					.getFolderByPath(normalizePath(path))
					?.children.find((x) => x.name.endsWith(ending));
				if (file) {
					if (file.name === filename || filename === `!-${ending}`) {
						// just edit the existing file
						await app.vault.modifyBinary(
							app.vault.getFileByPath(file.path)!,
							await resp.arrayBuffer()
						);
						return;
					} else {
						await app.vault.delete(file);
					}
				}
			} else if (filename === `!-${ending}`) {
				// should edit exist file, return if not exist
				return;
			}
		} else {
			const file = app.vault.getAbstractFileByPath(
				normalizePath(item.dest)
			);
			if (file) {
				// don't download normal asset if file exists
				return;
			}
		}
		await app.vault.createBinary(item.dest, await resp.arrayBuffer(), {});
	};

export const getNotebookDownloadURL = (notebookID: number, templateNoteID?: number) =>
	`${BASE_URL}/api/plugin/download?id=${notebookID}${templateNoteID ? `&note_id=${templateNoteID}` : ""}`;

export async function startSync(
	accessKey: string,
	app: App,
	path: string,
	onReport?: (info: string) => void,
	fromTimestamp?: number
) {
	onReport?.("Fetching data...");
	const folderExists = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!folderExists) {
		await app.vault.createFolder(path);
	}
	const imageFolderExists = app.vault.getAbstractFileByPath(
		normalizePath(path + "/images")
	);
	if (!imageFolderExists) {
		await app.vault.createFolder(path + "/images");
	}

	const { fileList, lastUpdated } = await getDownloadList(
		accessKey,
		fromTimestamp
	);
	const { assets, markdowns } = fileList;
	const downloadList: { url: string; dest: string; needAuth?: boolean }[] =
		[];
	assets.forEach((x) => {
		const filename = x.split("/").at(-1);
		const filePath = `${path}/images/${filename}`;
		const fileExists = app.vault.getAbstractFileByPath(
			normalizePath(filePath)
		);
		if (!fileExists) {
			downloadList.push({
				url: x,
				dest: filePath,
			});
		}
	});
	markdowns.forEach((x) => {
		downloadList.push({
			url: x.url,
			dest: `${path}/${x.name}`,
			needAuth: true,
		});
	});
	const total = downloadList.length;
	let finnished = 0;
	let failed = 0;
	const download = retry(downloadAssets(app, accessKey, path), {
		maxRetry: 3,
		wait: 500,
	});
	onReport?.(`Downloading... 0/${total}`);
	const limit = pLimit(5);
	const promises = downloadList.map((x) =>
		limit(() =>
			download(x)
				.catch(() => {
					failed++;
				})
				.finally(() => {
					finnished++;
					onReport?.(`Downloading... ${finnished}/${total}`);
				})
		)
	);
	await Promise.all(promises);
	if (failed > 0) {
		onReport?.(`Sync Completed with ${failed} failed downloads`);
	} else {
		onReport?.(`Sync Completed`);
	}

	return {
		lastSyncedTime: Date.now(),
		syncTimestamp: lastUpdated,
	};
}

export async function getSupabaseToken(accessKey: string) {
	const resp = await fetch(`${BASE_URL}/api/plugin/auth`, {
		headers: {
			"access-key": accessKey,
		},
	});
	if (resp.ok) {
		return resp.text();
	} else {
		throw new Error("Sorry, something went wrong. Please try again.");
	}
}

export async function getQRCodeURL(accessKey: string) {
	const resp = await fetch(`${BASE_URL}/api/plugin/quick_login`, {
		headers: {
			"access-key": accessKey,
		},
	});
	if (resp.ok) {
		return resp.text();
	} else {
		throw new Error("Sorry, something went wrong. Please try again.");
	}
}
