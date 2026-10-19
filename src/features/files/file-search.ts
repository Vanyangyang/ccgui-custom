/**
 * FileSearchOverlay 的纯检索逻辑(与组件分离,便于单测):作用域前缀、
 * 目录作用域过滤、名称优先的分级匹配排序。原实现自 FileSearchOverlay.tsx
 * 原样迁出,行为零变化。
 */
import {
  MENTION_MENU_LIMIT,
  type MentionEntry,
} from "@/components/application/ai-chat/mention-files";

/**
 * Workspace-relative prefix of `absolute` inside `root`: `""` when `absolute`
 * IS the root, `null` when it is not inside the workspace (nothing to search).
 * Separators are normalized so Windows `\` and POSIX `/` roots compare equal.
 */
export function workspaceRelativePrefix(root: string, absolute: string): string | null {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = absolute.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return null;
  if (target === base) return "";
  if (!target.startsWith(base + "/")) return null;
  return target.slice(base.length + 1);
}

/**
 * Index entries that live inside the search root. The prefix test is
 * separator-aware on purpose: a bare `startsWith` would scope `src` to
 * `src-extra/` too.
 */
export function scopeEntries(
  entries: MentionEntry[],
  root: string,
  searchRoot: string,
): MentionEntry[] {
  const prefix = workspaceRelativePrefix(root, searchRoot);
  if (prefix === null) return [];
  if (prefix === "") return entries;
  return entries.filter(
    (entry) => entry.rel === prefix || entry.rel.startsWith(prefix + "/"),
  );
}

/** Match quality of one query against one entry; lower wins. */
const TIER = {
  /** The name IS the query (`readme` → `readme`). */
  NameExact: 0,
  /** The name starts with the query (`readme` → `readme.md`). */
  NamePrefix: 1,
  /** The query sits inside the name (`readme` → `my-readme.md`). */
  NameSubstring: 2,
  /** The query is a subsequence of the name (`rdm` → `readme.md`). */
  NameSubsequence: 3,
  /** Only the folder path matches — a weak result, ranked last. */
  PathSubsequence: 4,
} as const;
type MatchTier = (typeof TIER)[keyof typeof TIER];

interface RankedRow {
  entry: MentionEntry;
  tier: MatchTier;
  /** Where the match starts (in the name, or the path for the last tier). */
  offset: number;
}

/** Leftmost index of `needle` as a subsequence of `haystack`, or null. */
function subsequenceAt(haystack: string, needle: string): number | null {
  let qi = 0;
  let first = -1;
  for (let i = 0; i < haystack.length && qi < needle.length; i++) {
    if (haystack[i] !== needle[qi]) continue;
    if (qi === 0) first = i;
    qi++;
  }
  return qi === needle.length ? first : null;
}

function rankEntry(entry: MentionEntry, q: string): RankedRow | null {
  const name = entry.name.toLowerCase();
  if (name === q) return { entry, tier: TIER.NameExact, offset: 0 };
  if (name.startsWith(q)) return { entry, tier: TIER.NamePrefix, offset: 0 };
  const inName = name.indexOf(q);
  if (inName >= 0) return { entry, tier: TIER.NameSubstring, offset: inName };
  const inNameSub = subsequenceAt(name, q);
  if (inNameSub !== null) {
    return { entry, tier: TIER.NameSubsequence, offset: inNameSub };
  }
  // `entry.key` is the lower-cased relative path (mention-files buildEntries).
  const inPath = subsequenceAt(entry.key, q);
  if (inPath !== null) return { entry, tier: TIER.PathSubsequence, offset: inPath };
  return null;
}

/**
 * Rows the overlay shows for a query, best match first.
 *
 * Ranking is name-first: exact name, name prefix, query inside the name,
 * subsequence of the name, and only then a subsequence of the folder path.
 * Reusing the @-mention picker's scorer here was wrong — it scores the WHOLE
 * relative path, so for `readme` the workspace segment `open-reverselab`
 * matches `re…` and collects its own bonuses, which pushed the actual
 * `README.md` files below `DISCLAIMER.md`.
 *
 * Within a tier: earlier match first, then the shallower path, then
 * alphabetical. An empty query shows nothing rather than the first N scoped
 * entries — an arbitrary slice of a subtree reads as "these are the files";
 * browsing is the tree's job, this surface is search only.
 */
export function searchEntries(
  entries: MentionEntry[],
  root: string,
  searchRoot: string,
  query: string,
): MentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: RankedRow[] = [];
  for (const entry of scopeEntries(entries, root, searchRoot)) {
    const row = rankEntry(entry, q);
    if (row) ranked.push(row);
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.offset - b.offset ||
      a.entry.rel.length - b.entry.rel.length ||
      (a.entry.rel < b.entry.rel ? -1 : a.entry.rel > b.entry.rel ? 1 : 0),
  );
  return ranked.slice(0, MENTION_MENU_LIMIT).map((row) => row.entry);
}
