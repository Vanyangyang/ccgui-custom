import type { MarketPlugin } from "@/lib/ipc";

/**
 * Browsing helpers for the plugin hub. The central index carries no icon or
 * category field (see src-tauri/src/plugins/market.rs), so the hub derives a
 * stable avatar and a browse category locally — deterministic output keeps
 * rows from reshuffling between renders and is cheap to unit-test.
 */

export type PluginCategory = "dev" | "productivity" | "integration" | "appearance" | "other";

/** Section order in the market list. `other` always closes the page. */
export const PLUGIN_CATEGORIES: PluginCategory[] = [
  "dev",
  "productivity",
  "integration",
  "appearance",
  "other",
];

/** First matching rule wins; ids/names/descriptions are searched lowercase. */
const CATEGORY_RULES: Array<{ category: PluginCategory; pattern: RegExp }> = [
  {
    category: "dev",
    pattern:
      /代码|体检|重构|调试|构建|lint|doctor|test|调试|开发工具|wsl|shell|终端|git|index|索引/,
  },
  {
    category: "productivity",
    pattern: /命名|标题|title|token|速度|统计|usage|效率|翻译|总结|笔记|计时|提醒|定时/,
  },
  {
    category: "integration",
    pattern:
      /供应商|渠道|模型|provider|model|余额|balance|网关|gateway|账号|订阅|api|连接|集成|mcp|同步|登录/,
  },
  {
    category: "appearance",
    pattern: /彩虹|主题|外观|界面|样式|字体|rainbow|theme|dimmer|border|图标|icon|壁纸|动画/,
  },
];

export function categorizePlugin(entry: {
  id: string;
  name: string;
  description: string;
}): PluginCategory {
  const haystack = `${entry.id}\n${entry.name}\n${entry.description}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return "other";
}

/** Avatar glyph: uppercase Latin initials, CJK/emoji pass through. Uses the
 *  code-point array so a surrogate pair (emoji name) is not split. */
export function pluginInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  if (!first) return "?";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** Deterministic gradient per plugin id — same id, same colors on every
 *  machine and render. Eight hues, no hashing dependency. */
const AVATAR_PALETTE: Array<readonly [string, string]> = [
  ["#60a5fa", "#2563eb"],
  ["#34d399", "#059669"],
  ["#fbbf24", "#d97706"],
  ["#f472b6", "#db2777"],
  ["#a78bfa", "#7c3aed"],
  ["#22d3ee", "#0891b2"],
  ["#fb7185", "#e11d48"],
  ["#f97316", "#ea580c"],
];

export function pluginAvatarGradient(id: string): { from: string; to: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const [from, to] = AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
  return { from, to };
}

/** GitHub's username rules: alphanumerics and single hyphens, ≤ 39 chars,
 *  no leading/trailing hyphen. */
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** The GitHub account behind the developer column. The index stores the
 *  account on `author`; a manifest may carry a display name instead, in which
 *  case the repo owner (the account that published) is the real identity.
 *  Nothing recognizable yields null and the caller keeps the initial tile. */
export function githubLoginFor(entry: { author: string; repo?: string }): string | null {
  const author = entry.author.trim();
  if (GITHUB_LOGIN.test(author)) return author;
  const parts = entry.repo?.split("/") ?? [];
  const owner = parts.length === 2 ? parts[0]!.trim() : "";
  return GITHUB_LOGIN.test(owner) ? owner : null;
}

/** GitHub account that publishes the first-party plugins. */
export const OFFICIAL_PLUGIN_LOGIN = "zhukunpenglinyutong";

/** First-party plugin: the indexed `author`, or the repo owner when a manifest
 *  carries only a display name (`githubLoginFor`). GitHub logins are
 *  case-insensitive, so the comparison is too. */
export function isOfficialPlugin(entry: { author: string; repo?: string }): boolean {
  return githubLoginFor(entry)?.toLowerCase() === OFFICIAL_PLUGIN_LOGIN;
}

/** Real avatar from GitHub's username endpoint. 2× the CSS size keeps the
 *  chip crisp on retina; 460 is the largest size the endpoint accepts. */
export function githubAvatarUrl(login: string, cssSize: number): string {
  const size = Math.min(460, Math.max(1, Math.round(cssSize * 2)));
  return `https://github.com/${login}.png?size=${size}`;
}

/** Index `updatedAt` (RFC 3339 UTC) → Date. An absent or unparsable stamp
 *  yields null so the detail rail skips the row instead of printing
 *  "Invalid Date" — the index is off-machine data, never trusted blindly. */
export function indexUpdatedAt(raw?: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Downloads desc, then name; entries without a count trail the ranked ones
 *  and keep the incoming (index) order among themselves. */
export function sortByDownloads(entries: MarketPlugin[]): MarketPlugin[] {
  return [...entries].sort((a, b) => {
    if (a.downloads != null && b.downloads != null && a.downloads !== b.downloads) {
      return b.downloads - a.downloads;
    }
    if (a.downloads != null && b.downloads == null) return -1;
    if (a.downloads == null && b.downloads != null) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Toolbar orders. `smart` and `downloads` rank the whole index (uncounted
 *  entries keep the index order at the tail); `official` and `thirdParty` are
 *  audience views and keep only that kind — see `pluginMatchesAudience`. */
export type PluginSort = "smart" | "official" | "thirdParty" | "downloads";

/** Audience gate for the 官方 / 第三方 selections: those two show one kind
 *  only, the ranking orders keep everything. */
export function pluginMatchesAudience(entry: MarketPlugin, sort: PluginSort): boolean {
  if (sort === "official") return isOfficialPlugin(entry);
  if (sort === "thirdParty") return !isOfficialPlugin(entry);
  return true;
}

/** Rows in table order. The toolbar select mixes ranking with the audience
 *  split, so this narrows and then ranks by downloads — see `sortByDownloads`
 *  for the uncounted tail and the name tiebreak. Copies; callers keep their
 *  filtered array. */
export function sortPlugins(entries: MarketPlugin[], sort: PluginSort): MarketPlugin[] {
  return sortByDownloads(entries.filter((entry) => pluginMatchesAudience(entry, sort)));
}

/**
 * Counts for the category chips: the filter row shows the shape of the index
 * before anything is clicked. Empty categories are dropped (a chip reading 0
 * is a dead end), and `other` keeps its fixed position at the end.
 */
export function categoryCounts(
  entries: MarketPlugin[],
): Array<{ category: PluginCategory; count: number }> {
  const counts = new Map<PluginCategory, number>();
  for (const entry of entries) {
    const category = categorizePlugin(entry);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return PLUGIN_CATEGORIES.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [{ category, count }] : [];
  });
}

/** Case-insensitive match over the fields the market row shows. */
export function pluginMatchesQuery(entry: MarketPlugin, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.id, entry.name, entry.description, entry.author]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

const README_RAW_BASE = "https://raw.githubusercontent.com";
const README_SITE_BASE = "https://github.com";

/** Resolve one URL inside a plugin README (fetched verbatim from the repo's
 *  default branch): relative image paths must load from raw.githubusercontent
 *  (GitHub's blob pages are HTML), while relative links should open the
 *  rendered GitHub page. Absolute https URLs and mailto pass through;
 *  anchors stay local; every other scheme — and anything that resolves
 *  outside the repo — is blanked so react-markdown renders no target. */
export function resolveReadmeUrl(
  url: string,
  kind: "image" | "link",
  repo: string,
): string {
  const trimmed = url.trim().replace(/^<|>$/g, "");
  if (!trimmed) return "";
  if (/^https:/i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed) && kind === "link") return trimmed;
  if (trimmed.startsWith("#")) return kind === "link" ? trimmed : "";
  // Other schemes (http, javascript:, data:, …) and protocol-relative URLs
  // are dropped outright rather than resolved.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return "";
  const base =
    kind === "image"
      ? `${README_RAW_BASE}/${repo}/HEAD/`
      : `${README_SITE_BASE}/${repo}/blob/HEAD/`;
  try {
    const resolved = new URL(trimmed, base).toString();
    // `..` normalizes away in URL(); a path that escaped the repo root no
    // longer shares the base prefix and is refused.
    return resolved.startsWith(base) ? resolved : "";
  } catch {
    return "";
  }
}
