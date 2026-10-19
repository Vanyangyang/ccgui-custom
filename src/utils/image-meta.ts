/** Image attachment metadata helpers: byte-size formatting and exact size
 * recovery from data URLs. Used by composer attachment chips and the image
 * lightbox. */

/** Byte count → "B" / "KB" / "MB" with one decimal, matching the reference
 *  UI ("187.5 KB"). Empty string for invalid input so callers can omit. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exact byte length of a base64 data URL's payload; null for non-data URLs.
 *  readFile returns image bodies as data URLs, so this recovers the on-disk
 *  file size without an extra stat IPC. */
export function dataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/** Decode a data URL to its natural pixel dimensions; null on failure. */
export function imageDimensions(
  url: string,
): Promise<{ width: number; height: number } | null> {
  const { promise, resolve } = Promise.withResolvers<{
    width: number;
    height: number;
  } | null>();
  const img = new Image();
  img.onload = () =>
    resolve({ width: img.naturalWidth, height: img.naturalHeight });
  img.onerror = () => resolve(null);
  img.src = url;
  return promise;
}

/** "792 × 964 · 187.5 KB" from partial metadata; empty string when nothing
 *  is known. */
export function imageMetaText(meta: {
  width?: number;
  height?: number;
  size?: number;
}): string {
  const parts: string[] = [];
  if (meta.width && meta.height) parts.push(`${meta.width} × ${meta.height}`);
  if (meta.size != null) parts.push(formatFileSize(meta.size));
  return parts.join(" · ");
}
