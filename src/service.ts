import { loadImageBlob } from "./helpers";
import { upload } from "@vercel/blob/client";

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
	onWrite: (note: string) => void
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
