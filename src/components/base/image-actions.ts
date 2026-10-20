import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";

/** Base64 data URL → Blob without fetch (CSP may block data: fetches). */
function dataUrlBlob(src: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

/** The clipboard reliably accepts only image/png; other formats are redrawn
 *  from the already-decoded preview element. */
async function pngBlob(src: string, img: HTMLImageElement | null, blob?: Blob): Promise<Blob> {
  if (blob?.type === "image/png") return blob;
  if (/^data:image\/png;/i.test(src)) {
    const blob = dataUrlBlob(src);
    if (blob) return blob;
  }
  if (!img || !img.naturalWidth) throw new Error("image is not loaded");
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas is unavailable");
  context.drawImage(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png"));
}

/** `blob` is the image behind an object URL, used as-is when it is a PNG. */
export async function copyImageToClipboard(src: string, img: HTMLImageElement | null, blob?: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("clipboard images are not supported");
  }
  const png = await pngBlob(src, img, blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Desktop: native save dialog (false = cancelled); a file-backed image is
 *  copied from `sourcePath` by the backend, otherwise its data URL is sent.
 *  Web: a browser download, which reports started rather than saved. */
export async function saveImage(src: string, name: string, sourcePath?: string): Promise<boolean> {
  if (isWeb) {
    const link = document.createElement("a");
    link.href = src;
    link.download = name;
    link.click();
    return true;
  }
  if (!sourcePath && !src.startsWith("data:")) throw new Error("image source is not saveable");
  return (await ipc.saveImageAs(name, sourcePath ? { sourcePath } : { dataUrl: src })) !== null;
}
