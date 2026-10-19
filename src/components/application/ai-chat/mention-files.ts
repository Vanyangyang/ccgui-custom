import { ipc, type FileIndexEntry } from "@/lib/ipc";
import {
  createRootCacheStore,
  type RootCache,
} from "@/components/application/ai-chat/create-root-cache-store";

/**
 * Workspace file index + fuzzy matcher for the composer's @-mention picker.
 *
 * Performance model (the old desktop-cc-gui queried the backend per
 * keystroke — this is the opposite):
 * - The whole tree is fetched ONCE per workspace root (a single bounded
 *   walk on the Rust side), then revalidated in the background after
 *   INDEX_TTL_MS while stale entries stay visible (stale-while-revalidate,
 *   via createRootCacheStore).
 * - Matching is pure JS over precomputed lowercase keys. A subsequence
 *   scan is O(rel length) per entry, so even a full 20k-entry index costs
 *   ~1ms per keystroke — no debouncing, no IPC, no workers needed.
 */

/** A file/dir in the picker, with match keys precomputed at index time. */
export interface MentionEntry {
  /** Workspace-relative path, "/" separators. */
  rel: string;
  /** Basename (dirs included). */
  name: string;
  isDir: boolean;
  /** Path depth (slash count); empty-query ordering is shallow-first. */
  depth: number;
  /** Lowercase rel — the match haystack. */
  key: string;
  /** Offset of the basename inside key (basename matches score higher). */
  nameStart: number;
}

export type RootIndex = RootCache<MentionEntry>;

const INDEX_TTL_MS = 60_000;

function buildEntries(raw: FileIndexEntry[]): MentionEntry[] {
  const entries = raw.map(({ rel, isDir }) => {
    const slash = rel.lastIndexOf("/");
    const name = slash >= 0 ? rel.slice(slash + 1) : rel;
    return {
      rel,
      name,
      isDir,
      depth: rel.split("/").length - 1,
      key: rel.toLowerCase(),
      nameStart: slash + 1,
    };
  });
  // Shallow-first, then alphabetical: a bare `@` lists root entries first.
  entries.sort(
    (a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return entries;
}

const { useStore: useMentionIndexStore, prune: pruneMentionIndex } =
  createRootCacheStore<MentionEntry>({
    fetch: (root) => ipc.listFileIndex(root).then(buildEntries),
    ttlMs: INDEX_TTL_MS,
  });

/** Drop one workspace root's cached index when its workspace is removed;
 * the per-root cache would otherwise accumulate every root ever opened. */
export { useMentionIndexStore, pruneMentionIndex };

/** Max rows the picker renders — caps DOM work regardless of match count. */
export const MENTION_MENU_LIMIT = 50;

/**
 * fzf-lite subsequence score for one entry; null when `q` is not a
 * subsequence of the entry's key. Bonuses: contiguous runs, segment starts
 * (after / - _ . space), basename matches; a length penalty prefers short
 * paths.
 */
function scoreEntry(entry: MentionEntry, q: string): number | null {
  const key = entry.key;
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let i = 0; i < key.length && qi < q.length; i++) {
    if (key.charCodeAt(i) !== q.charCodeAt(qi)) continue;
    score += 1;
    if (i === prevMatch + 1) score += 4;
    if (i === 0 || "/-_ .".includes(key[i - 1])) score += 8;
    if (i >= entry.nameStart) score += 3;
    prevMatch = i;
    qi++;
  }
  if (qi < q.length) return null;
  return score - key.length * 0.05;
}

/**
 * Top matches for a trigger query. `root` lets absolute-path queries
 * (`@/Users/me/proj/src/a` — a half-typed mention) match by stripping the
 * root prefix before scoring against relative keys.
 */
export function matchMentionEntries(
  entries: MentionEntry[],
  root: string,
  query: string,
  limit = MENTION_MENU_LIMIT,
): MentionEntry[] {
  // Normalize separators so Windows absolute queries (`@C:\Users\me\proj\src`)
  // strip the root the same way POSIX ones do; entry keys are `/`-joined.
  let q = query.replace(/\\/g, "/").toLowerCase();
  if (!q) return entries.slice(0, limit);
  const rootKey = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (q.startsWith("/") || /^[a-z]:\//.test(q)) {
    if (q === rootKey) return entries.slice(0, limit);
    if (!q.startsWith(rootKey + "/")) return [];
    q = q.slice(rootKey.length + 1);
  }
  const scored: Array<{ entry: MentionEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, q);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || a.entry.depth - b.entry.depth || (a.entry.key < b.entry.key ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
