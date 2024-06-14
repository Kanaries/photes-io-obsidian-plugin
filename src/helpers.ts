export function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
	const timeout = new Promise((_resolve, reject) => {
		const id = setTimeout(() => {
			clearTimeout(id);
			reject(`timed out after ${ms} ms`);
		}, ms);
	}) as unknown as Promise<T>;
	return Promise.race([promise, timeout]);
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
