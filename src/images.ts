import { PixnoError } from "./service";

export function imageExtension(bytes: ArrayBuffer): string {
    const b = new Uint8Array(bytes);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    const start = String.fromCharCode(...b.slice(0, 12));
    if (start.startsWith("GIF87a") || start.startsWith("GIF89a")) return "gif";
    if (start.startsWith("RIFF") && start.slice(8) === "WEBP") return "webp";
    throw new PixnoError(415);
}

export async function prepareUpload(file: File): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    if (file.size > 20 * 1024 * 1024 || !file.size) throw new PixnoError(413);
    const bytes = await file.arrayBuffer();
    const ext = imageExtension(bytes);
    if (file.size <= 3 * 1024 * 1024) return { bytes, contentType: ext === "jpg" ? "image/jpeg" : `image/${ext}` };
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    try {
        const ratio = Math.min(1, 4000 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        const context = canvas.getContext("2d");
        if (!context) throw new PixnoError(415);
        context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
        if (!blob || blob.size > 3 * 1024 * 1024) throw new PixnoError(413);
        return { bytes: await blob.arrayBuffer(), contentType: "image/jpeg" };
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}
