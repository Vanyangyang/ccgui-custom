import { decodeFileLink, isFileLinkUrl, resolveFilePath } from "@/lib/fileLinks";
import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";

/** Only passive raster payloads may reach an img, never arbitrary URLs. */
export function isRasterDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
}

export function resolveChatImage(ref: string, workspacePath: string): { kind: "data" | "file"; value: string } | null {
  if (isRasterDataUrl(ref)) return { kind: "data", value: ref };
  let path = isFileLinkUrl(ref) ? decodeFileLink(ref) : ref;
  try { path = decodeURIComponent(path); } catch { /* Literal percent in filenames. */ }
  path = path.trim();
  if (!path || /[\x00-\x1f]/.test(path) || /^[\\/]{2}/.test(path) ||
      (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) return null;
  const resolved = resolveFilePath(path, workspacePath);
  if (!resolved || /^[\\/]{2}/.test(resolved)) return null;
  return { kind: "file", value: resolved };
}

export function chatImageName(ref: string): string | null {
  if (/^(?:data|blob|javascript):/i.test(ref)) return null;
  let path = isFileLinkUrl(ref) ? decodeFileLink(ref) : ref;
  try { path = decodeURIComponent(path); } catch { /* Literal percent. */ }
  return path.split(/[\\/]/).pop()?.split(/[?#]/)[0]?.slice(0, 160) || null;
}

/** A displayable local image. `blob` is set when `url` is an object URL the
 *  loader owns (desktop); release it with `releaseChatImage`. */
export interface LoadedChatImage {
  url: string;
  size?: number;
  blob?: Blob;
}

/** Same content check as the backend's `raster_mime`; sets the Blob type
 *  that clipboard copy and annotation attachments rely on. */
export function rasterMime(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((value, i) => bytes[i] === value);
  const ascii = (from: number, text: string) =>
    [...text].every((char, i) => bytes[from + i] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM")) return "image/bmp";
  if (starts(0, 0, 1, 0)) return "image/x-icon";
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  return null;
}

/** Desktop reads raw bytes (no base64 round trip, 64MB cap) into an object
 *  URL; web keeps the bridge's data URL read. null = not a usable image. */
export async function loadChatImage(path: string): Promise<LoadedChatImage | null> {
  if (isWeb) {
    const content = await ipc.readFile(path);
    return content.kind === "image" && content.dataUrl && isRasterDataUrl(content.dataUrl) ? { url: content.dataUrl } : null;
  }
  const payload: unknown = await ipc.readImageBytes(path);
  const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload)
    : ArrayBuffer.isView(payload) ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    : Array.isArray(payload) ? Uint8Array.from(payload as number[]) : null;
  const type = bytes && rasterMime(bytes);
  if (!bytes || !type) return null;
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  return { url: URL.createObjectURL(blob), size: blob.size, blob };
}

export function releaseChatImage(image: LoadedChatImage | null | undefined) {
  if (image?.blob) URL.revokeObjectURL(image.url);
}
