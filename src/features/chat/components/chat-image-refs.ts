import { decodeFileLink, isFileLinkUrl, resolveFilePath } from "@/lib/fileLinks";

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
