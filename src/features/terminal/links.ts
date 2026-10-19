import type { IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { isPathUnder, pathExistsOnDisk } from "@/features/chat/file-link-resolution";
import { isMacPlatform } from "@/features/shortcuts/shortcuts";

/**
 * Absolute-path links for the terminal dock. Build tools print artifact
 * paths one per line ("Finished 2 bundles at: …"); turning those into
 * modifier-click-to-reveal links is the point. Unlike chat markdown — which
 * anchors relative paths at the workspace index — a shell prints arbitrary
 * prose, so only absolute POSIX / Windows-drive paths are considered.
 *
 * Spaces are allowed inside a candidate ("CC GUI 项目/…"), so the regex
 * deliberately over-captures trailing prose; the existence probe then trims
 * segment-by-segment from the right until what remains is real. Probes are
 * confined to paths under the terminal's cwd: listDir rejects paths outside
 * the registered workspaces with a grant dialog, and hovering a link must
 * never pop one. Outside-cwd candidates link only their no-space prefix,
 * unprobed.
 */

// One absolute-path candidate: drive/root prefix, a non-space run, then any
// number of space-separated continuations (over-capture on purpose, see the
// header comment). Excludes characters that never appear unquoted in real
// shell output paths.
const PATH_CANDIDATE = /(?:[A-Za-z]:[\\/](?![\\/])|\/)[^\s`"'<>|]+(?: [^\s`"'<>|]+)*/g;

// Sentence punctuation a printed path picks up at end of line
// ("…/CC GUI.app.tar.gz)" in the bundler output). `.` stays: trailing dots
// are stripped by the probe's space-trim loop failing, and real extensions
// end in one.
const TRAILING_NOISE = /[,;:!?)\]}"']+$/;

const MAX_LINKS_PER_LINE = 16;
const MAX_PROBE_STEPS = 8;
const MAX_LOGICAL_ROWS = 10;
const MAX_CACHE_ENTRIES = 500;

interface LogicalRow {
  /** 1-based buffer row. */
  y: number;
  /** Offset of this row's first character in the joined logical line. */
  start: number;
  /** Row length in JS string units (blank padding included). */
  length: number;
}

interface LogicalLine {
  text: string;
  rows: LogicalRow[];
}

// Existence probing is a parent-dir listing per candidate; results are
// cached so xterm re-asking for links on every render costs nothing after
// the first hover. Keyed by cwd + candidate so tabs in different workspaces
// never share a verdict.
const probeCache = new Map<string, Promise<string | null>>();

async function probe(raw: string, cwd: string): Promise<string | null> {
  let candidate = raw.replace(TRAILING_NOISE, "");
  if (!candidate || !isPathUnder(candidate, cwd)) {
    // Outside the workspace: probing would risk a grant dialog, so only the
    // no-space prefix (no trailing-prose ambiguity) is linkable at all.
    const prefix = candidate.split(" ")[0];
    return prefix && !prefix.includes(" ") ? prefix : null;
  }
  for (let step = 0; step < MAX_PROBE_STEPS && candidate; step += 1) {
    if (await pathExistsOnDisk(candidate)) return candidate;
    const cut = candidate.lastIndexOf(" ");
    if (cut < 0) break;
    candidate = candidate.slice(0, cut).replace(TRAILING_NOISE, "");
  }
  return null;
}

function resolveCandidate(raw: string, cwd: string): Promise<string | null> {
  const key = `${cwd}\n${raw}`;
  let cached = probeCache.get(key);
  if (!cached) {
    if (probeCache.size >= MAX_CACHE_ENTRIES) probeCache.clear();
    cached = probe(raw, cwd);
    probeCache.set(key, cached);
  }
  return cached;
}

/**
 * Join soft-wrapped buffer rows into one logical line. Long artifact paths
 * wrap across rows at narrow dock widths; matching row-by-row would see a
 * truncated path that fails the existence probe and never links. Blank
 * padding is kept (translateToString(false)) so string offsets stay aligned
 * with cell columns.
 */
function logicalLineAt(term: Terminal, y: number): LogicalLine | null {
  const buffer = term.buffer.active;
  let first = y - 1;
  let line = buffer.getLine(first);
  if (!line) return null;
  while (line.isWrapped && first > 0) {
    first -= 1;
    const prev = buffer.getLine(first);
    if (!prev) break;
    line = prev;
  }
  const rows: LogicalRow[] = [];
  let text = "";
  let rowIndex = first;
  while (rows.length < MAX_LOGICAL_ROWS) {
    const row = buffer.getLine(rowIndex);
    if (!row) break;
    const rowText = row.translateToString(false);
    rows.push({ y: rowIndex + 1, start: text.length, length: rowText.length });
    text += rowText;
    const next = buffer.getLine(rowIndex + 1);
    if (!next?.isWrapped) break;
    rowIndex += 1;
  }
  return { text: text.trimEnd(), rows };
}

// xterm positions links in cells; translateToString returns JS string
// indices. Wide chars (CJK in "CC GUI 项目") occupy two cells, so a naive
// string index shifts the hover/click span left of the real text. This is
// wcwidth-lite: the wide ranges xterm itself uses, minus zero-width marks
// (combining chars / ZWJ are vanishingly rare in printed paths).
function cellWidth(text: string): number {
  let cells = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    cells +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return cells;
}

function locate(log: LogicalLine, index: number): { x: number; y: number } {
  let row = log.rows[0];
  for (const candidate of log.rows) {
    if (index < candidate.start + candidate.length) {
      row = candidate;
      break;
    }
    row = candidate;
  }
  return { x: cellWidth(log.text.slice(row.start, index)) + 1, y: row.y };
}

/**
 * Reveal-in-file-manager is a modifier gesture: a plain click lands on
 * printed output far too easily — selecting text, clicking back into the
 * window — to let it throw open a Finder window. macOS uses Option (the
 * terminal already treats Option as meta); Windows and Linux use Ctrl,
 * matching Windows Terminal and GNOME Terminal. Without the modifier the
 * link still underlines on hover, so the target stays visible before
 * committing to the click.
 */
export function holdsRevealModifier(
  event: Pick<MouseEvent, "altKey" | "ctrlKey">,
  mac: boolean = isMacPlatform(),
): boolean {
  return mac ? event.altKey : event.ctrlKey;
}

/**
 * Link provider: every visible row is scanned for absolute-path candidates;
 * each candidate resolves (async, cached) to its longest on-disk prefix and
 * becomes a modifier-click-to-reveal link spanning that prefix only.
 */
export function createPathLinkProvider(options: {
  term: Terminal;
  cwd: string;
  onActivate: (path: string) => void;
}): ILinkProvider {
  const { term, cwd, onActivate } = options;
  return {
    provideLinks(y, callback) {
      const log = logicalLineAt(term, y);
      if (!log || !log.text.includes("/")) {
        callback(undefined);
        return;
      }
      const matches: { start: number; raw: string }[] = [];
      PATH_CANDIDATE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PATH_CANDIDATE.exec(log.text)) !== null) {
        if (matches.length >= MAX_LINKS_PER_LINE) break;
        // Skip URL tails ("https://host/a" — preceded by ':' or '/') and
        // relative tokens glued to a word ("github.com/foo/bar").
        const before = match.index > 0 ? log.text[match.index - 1] : "";
        if (before === "/" || before === ":" || /[\w.]/.test(before)) continue;
        if (match[0].startsWith("//")) continue;
        matches.push({ start: match.index, raw: match[0] });
      }
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(matches.map((m) => resolveCandidate(m.raw, cwd))).then((resolved) => {
        const links: ILink[] = [];
        resolved.forEach((path, i) => {
          if (!path) return;
          // IBufferRange end is the inclusive last cell; locating the last
          // character directly keeps a path ending at a wrapped row boundary
          // on its own row (the index-after-end would land on the next row).
          const start = locate(log, matches[i].start);
          const end = locate(log, matches[i].start + path.length - 1);
          const range: IBufferRange = { start, end };
          links.push({
            range,
            text: path,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              if (holdsRevealModifier(event)) onActivate(path);
            },
          });
        });
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
