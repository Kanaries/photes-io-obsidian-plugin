export function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
	const timeout = new Promise((_resolve, reject) => {
		const id = setTimeout(() => {
			clearTimeout(id);
			reject(`timed out after ${ms} ms`);
		}, ms);
	}) as unknown as Promise<T>;
	return Promise.race([promise, timeout]);
}

export function retry<T extends any[], U>(
	builder: (...param: T) => Promise<U>,
	options: {
		maxRetry?: number;
		wait?: number;
	} = {}
) {
	const { maxRetry = 3, wait = 100 } = options;
	return async function (...p: T) {
		let lastErr: any;
		for (let i = 0; i < maxRetry; i++) {
			try {
				return await builder(...p);
			} catch (e) {
				lastErr = e;
				if (i < maxRetry - 1) {
					await new Promise<void>((r) => setTimeout(r, wait));
				}
			}
		}
		throw lastErr;
	};
}

export function onElement(
	el: Document,
	event: keyof HTMLElementEventMap,
	selector: string,
	listener: (event: Event) => void,
	options?: { capture?: boolean }
) {
	el.on(event, selector, listener, options);
	return () => el.off(event, selector, listener, options);
}

export async function loadImageBlob(imgSrc: string): Promise<Blob> {
	const loadImageBlobCore = () =>
		new Promise<Blob>((resolve, reject) => {
			const image = new Image();
			image.crossOrigin = "anonymous";
			image.onload = () => {
				const canvas = document.createElement("canvas");
				canvas.width = image.width;
				canvas.height = image.height;
				const ctx = canvas.getContext("2d")!;
				ctx.drawImage(image, 0, 0);
				canvas.toBlob((blob: Blob) => {
					resolve(blob);
				});
			};
			image.onerror = async () => {
				try {
					await fetch(image.src, { mode: "no-cors" });

					// console.log("possible CORS violation, falling back to allOrigins proxy");
					// https://github.com/gnuns/allOrigins
					const blob = await loadImageBlob(
						`https://api.allorigins.win/raw?url=${encodeURIComponent(
							imgSrc
						)}`
					);
					resolve(blob);
				} catch {
					reject();
				}
			};
			image.src = imgSrc;
		});
	return withTimeout(5000, loadImageBlobCore());
}

export function getImageDOM(
	element: HTMLElement | null
): HTMLImageElement | null {
	if (!element) {
		return null;
	}
	if (element instanceof HTMLImageElement) {
		return element;
	}
	if (element.children.length > 0) {
		for (let i = 0; i < element.children.length; i++) {
			const child = getImageDOM(element.children[i] as HTMLElement);
			if (child) {
				return child;
			}
		}
	}
	return null;
}

export function createQueuedProcessor<T>(
	processor: (item: T) => Promise<void>,
	getValue: (item: T) => string | number
) {
	const processingMap = new Map<
		string | number,
		| {
				state: "processing";
		  }
		| {
				state: "pending";
				item: T;
		  }
	>();

	async function processNext(key: string | number, arg: T) {
		processingMap.set(key, { state: "processing" });
		await processor(arg);
		const pending = processingMap.get(key);
		processingMap.delete(key);

		if (pending?.state === "pending") {
			processNext(key, pending.item);
		}
	}

	return async function (arg: T) {
		const key = getValue(arg);
		if (processingMap.has(key)) {
			processingMap.set(key, { state: "pending", item: arg });
		} else {
			processNext(key, arg);
		}
	};
}
