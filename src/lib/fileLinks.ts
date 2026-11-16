/**
 * File-path detection and file-link URLs for chat markdown.
 * Compact port of desktop-cc-gui's utils/remarkFileLinks.ts — inline code
 * spans and link targets that look like file paths render as green
 * dotted-underline links that open the file.
 *
 * Scheme is app-internal: `ccgui-file:<encodeURIComponent(path)>`.
 */

const FILE_LINK_PROTOCOL = "ccgui-file:";

const SPACED_POSIX_FILE_PATH_PATTERN = String.raw`\/(?:Users|Volumes|home|tmp|var|private)\/[^\r\n\`"'<>]*?\.[A-Za-z0-9]{1,12}(?:#[A-Za-z0-9:_-]+)?`;
const WINDOWS_ABSOLUTE_PATH_PATTERN = String.raw`[A-Za-z]:[\\/](?![\\/])[^\s\`"'<>\|]+`;
const FILE_PATH_PATTERN = new RegExp(
  String.raw`(${SPACED_POSIX_FILE_PATH_PATTERN}|${WINDOWS_ABSOLUTE_PATH_PATTERN}|\/[^\s\`"'<>]+|~\/[^\s\`"'<>]+|\.{1,2}\/[^\s\`"'<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)`,
);
const FILE_PATH_MATCH = new RegExp(`^${FILE_PATH_PATTERN.source}$`);
const WINDOWS_ABSOLUTE_PATH_MATCH = new RegExp(`^${WINDOWS_ABSOLUTE_PATH_PATTERN}$`);

// CJK ideographs/kana/full-width punctuation: prose characters that never
// appear in real file paths — a slash-joined CJK token is prose, not a path,
// unless its last segment carries a file extension.
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿＀-￯]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/;
const RELATIVE_ALLOWED_PREFIXES = [
  "src/",
  "src-tauri/",
  "app/",
  "lib/",
  "tests/",
  "test/",
  "packages/",
  "apps/",
  "docs/",
  "scripts/",
];

function isPathCandidate(value: string) {
  if (WINDOWS_ABSOLUTE_PATH_MATCH.test(value)) return true;
  if (!value.includes("/")) return false;
  if (value.startsWith("//")) return false;
  if (CJK_PATTERN.test(value) && !FILE_EXTENSION_PATTERN.test(value.split("/").pop() ?? "")) {
    return false;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  ) {
    // Slash-commands like /commit or /aimax:plan: single segment without a
    // file extension is a chat command, not a path.
    if (value.startsWith("/") && !value.slice(1).includes("/")) {
      const segment = value.slice(1);
      if (segment.includes(":") || !segment.includes(".")) return false;
    }
    return true;
  }
  const lastSegment = value.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return true;
  return RELATIVE_ALLOWED_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** True when an inline-code / link-target string is a plausible file path. */
export function isLinkableFilePath(value: string) {
  const trimmed = stripFileLocation(value.trim());
  if (!trimmed || !FILE_PATH_MATCH.test(trimmed)) return false;
  return isPathCandidate(trimmed);
}

export function toFileLink(path: string) {
  return `${FILE_LINK_PROTOCOL}${encodeURIComponent(path)}`;
}

export function isFileLinkUrl(url: string) {
  return url.startsWith(FILE_LINK_PROTOCOL);
}

export function decodeFileLink(url: string) {
  const raw = url.slice(FILE_LINK_PROTOCOL.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Decode a local file URL once. Keep the original URL until this boundary:
 * decoding it earlier would let raw-path handling decode percent signs again
 * or mistake an encoded filename ending in #L53 / :12 for a source location.
 * Network authorities, UNC paths and encoded separators are not local links. */
export function localFileUrlPath(value: string): string | null {
  if (!/^file:\/\/(?:localhost)?\//i.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.hostname || /%2f|%5c/i.test(url.pathname)) return null;
    const path = decodeURIComponent(url.pathname);
    if (path === "/" || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
    // URL pathname keeps the slash before a Windows drive; file IPC does not.
    return path.replace(/^\/(?=[A-Za-z]:\/)/, "");
  } catch {
    return null;
  }
}

/** Serialize a resolved filesystem path, not an already-encoded link target. */
export function toLocalFileUrl(path: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  try {
    if (/^[A-Za-z]:[\\/]/.test(path)) {
      const normalized = path.replace(/\\/g, "/");
      return `file:///${normalized.slice(0, 2)}${normalized.slice(2).split("/").map(encodeURIComponent).join("/")}`;
    }
    if (path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
      return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a markdown-sourced path to an absolute one. Relative paths anchor
 * at the session's workspace; slash-prefixed Windows drive paths are normalized.
 * Returns null for `~/` paths (home dir unknown to the frontend) and empties.
 *
 * Paths that arrive percent-encoded (a model or upstream tool URL-encoded a
 * CJK filename inside an otherwise plain path) are decoded first — the
 * filesystem never sees `%E7%BB%86…` as a literal name.
 */
export function resolveFilePath(path: string, workspacePath: string): string | null {
  if (/^file:/i.test(path.trim())) return localFileUrlPath(path.trim());
  // Strip the leading slash on `/D:/...` (Git-Bash / MSYS style drive prefix)
  // *before* stripping the `:line[:col]` suffix. Doing the location strip
  // first leaves the `/` in place only in odd inputs; normalizing the drive
  // prefix up-front keeps every downstream check (absolute detection, reveal,
  // open) operating on the real disk path.
  const deSlashed = path.trim().replace(/^\/+(?=[A-Za-z]:[\\/])/, "");
  const trimmed = percentDecodePath(stripFileLocation(deSlashed));
  if (!trimmed) return null;
  if (trimmed.startsWith("~/")) return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;
  const relative = trimmed.replace(/^\.\//, "");
  if (trimmed.startsWith("../")) return null; // escaping the workspace: don't guess
  const root = workspacePath.replace(/[/\\]+$/, "");
  return root ? `${root}/${relative}` : null;
}

/** Strip source locations before URL-decoding, preserving encoded filename
 * characters such as `%23L53` that are not navigation suffixes. */
function stripFileLocation(path: string): string {
  return path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, "");
}

/** Decode `%XX` sequences when they look like URL-encoding smuggled into a
 *  file path (CJK filenames pasted as links). A literal path with no `%`
 *  passes through untouched; a malformed sequence keeps the raw text. */
function percentDecodePath(path: string): string {
  if (!path.includes("%")) return path;
  try {
    const decoded = decodeURIComponent(path);
    // Only accept when decoding actually removed escapes; otherwise the `%`
    // was part of the real name (rare but legal).
    return decoded === path ? path : decoded;
  } catch {
    return path;
  }
}
