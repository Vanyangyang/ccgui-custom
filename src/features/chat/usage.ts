/**
 * Denominator for the context gauge when nothing real is known: neither the
 * engine's own report nor the model catalog supplied a window.
 *
 * It is a last resort, not a default. Every engine that knows its window
 * reports it — Codex through its rollout/`debug models`, Claude through the
 * `modelUsage` map on its result line — so a value here means the engine said
 * nothing, and the gauge is a guess (pi, agy and dsh today).
 */
export const ASSUMED_CONTEXT_WINDOW = 200_000;

export interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Reasoning/thinking tokens when the engine reports them separately. */
  reasoning?: number;
  /** Engine-reported window (Codex `model_context_window`). */
  contextWindow?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(u: Record<string, unknown>, k: string): number {
  return typeof u[k] === "number" ? (u[k] as number) : 0;
}

function reportedWindow(...sources: Array<Record<string, unknown> | null>): number | undefined {
  for (const source of sources) {
    for (const key of ["model_context_window", "context_window", "contextWindow"]) {
      const raw = source?.[key];
      const match = typeof raw === "string" ? raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/) : null;
      const n = typeof raw === "number" ? raw : match
        ? Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2].toLowerCase()] ?? 1) : 0;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/** Window metadata is useful even before any tokens have been reported. */
export function reportedContextWindow(usage: unknown): number | undefined {
  const raw = asRecord(usage);
  const info = asRecord(raw?.info);
  return reportedWindow(raw, info, asRecord(raw?.last_token_usage), asRecord(info?.last_token_usage));
}

/** Engines whose cache counters sit *inside* `input_tokens`. Codex reports
 *  `cached_input_tokens` / `cache_write_input_tokens` as parts of the prompt
 *  it bills (`total_tokens` = input + output), while Claude and the pi family
 *  report `cache_read_input_tokens` / `cacheRead` outside it. */
function cacheInsideInput(u: Record<string, unknown>): boolean {
  // agy exposes the cache under both names; the claude-style key says it sits
  // outside `input_tokens` (see engine/agy_throughput.rs).
  return typeof u.cached_input_tokens === "number" && typeof u.cache_read_input_tokens !== "number";
}

/** Normalize the per-engine usage shapes (snake_case for claude/codex, bare
 * keys for pi/omp) into one token breakdown. Returns null when no tokens
 * were reported at all. */
export function parseUsage(usage: unknown): ParsedUsage | null {
  const raw = asRecord(usage);
  if (!raw) return null;
  // Codex token_count info: occupancy is last_token_usage; the sibling
  // total_token_usage is session-billed cumulative and must not fill the bar.
  const info = asRecord(raw.info) ?? raw;
  const nested = asRecord(info.last_token_usage);
  const u = nested ?? info;
  const reportedInput = num(u, "input_tokens") || num(u, "input");
  const output = num(u, "output_tokens") || num(u, "output");
  // Codex names its cache fields differently (cached_input_tokens /
  // cache_write_input_tokens): without them a codex report's cache hits land
  // in the ledger as zero.
  const cacheRead =
    num(u, "cache_read_input_tokens") || num(u, "cacheRead") || num(u, "cached_input_tokens");
  const cacheWrite =
    num(u, "cache_creation_input_tokens") ||
    num(u, "cacheWrite") ||
    num(u, "cache_write_input_tokens");
  // Fold codex's cache counters out of its input so the four parts never
  // overlap. Adding them on top inflated every total by the whole cache
  // volume (a cache-heavy codex turn counted ~3x its real prompt).
  const input = cacheInsideInput(u)
    ? Math.max(0, reportedInput - cacheRead - cacheWrite)
    : reportedInput;
  const total =
    num(u, "total_tokens") || num(u, "totalTokens") || input + output + cacheRead + cacheWrite;
  if (!total) return null;
  const reasoning =
    num(u, "thinking_tokens") || num(u, "reasoning_output_tokens") || num(u, "reasoning_tokens");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    ...(reasoning ? { reasoning } : {}),
    contextWindow: reportedContextWindow(raw),
  };
}

/**
 * Cursor 的 result.usage 把这一轮里每次模型调用的 token 加总，缓存已从 input 里拆出。
 * 一次调用的提示词不会超过所选窗口太多；超过窗口的合计不能当成当前占用。
 */
export function cursorContextOccupancyKnown(usage: unknown, maxTokens: number): boolean {
  const parsed = parseUsage(usage);
  if (!parsed || !(maxTokens > 0)) return false;
  const prompt = parsed.input + parsed.cacheRead + parsed.cacheWrite;
  return prompt <= maxTokens * 1.05;
}

export interface CursorContextCategory {
  id: string;
  tokens: number;
}

export interface CursorContextSelection {
  occupancyKnown: boolean;
  capacityKnown: boolean;
  max?: number;
  used?: number;
  pct?: number;
  categories: CursorContextCategory[];
}

const EMPTY_CURSOR_CONTEXT: CursorContextSelection = {
  occupancyKnown: false,
  capacityKnown: false,
  categories: [],
};

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * 【cursor上下文】优先用本机会话状态里的当前占用。没有这份读数时，不把整轮合计当成占用。
 */
export function selectCursorContext(usage: unknown, modelWindow?: number): CursorContextSelection {
  const raw = asRecord(usage);
  if (raw?.context_usage_kind !== "current_context") return EMPTY_CURSOR_CONTEXT;
  const context = asRecord(raw.context_usage);
  if (!context) return EMPTY_CURSOR_CONTEXT;
  const used = finiteCount(context.used_tokens);
  const reportedMax = reportedContextWindow(context);
  const fallbackMax = typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0
    ? Math.round(modelWindow)
    : undefined;
  const max = reportedMax ?? fallbackMax;
  if (used === undefined || max === undefined || used > max * 1.05) return EMPTY_CURSOR_CONTEXT;
  const categories: CursorContextCategory[] = [];
  if (Array.isArray(context.categories)) {
    for (const item of context.categories) {
      const category = asRecord(item);
      const id = typeof category?.id === "string" ? category.id : "";
      const tokens = finiteCount(category?.tokens);
      if (!/^[a-z0-9_]{1,40}$/.test(id) || tokens === undefined || tokens === 0 || tokens > used) continue;
      categories.push({ id, tokens });
      if (categories.length === 32) break;
    }
  }
  const summed = categories.reduce((sum, category) => sum + category.tokens, 0);
  // 【cursor上下文】分类对不上当前占用时，用一条对话占用兜住总数，避免进度条超过窗口。
  const parts = categories.length === 0
    ? (used > 0 ? [{ id: "conversation", tokens: used }] : [])
    : summed > used
      ? [{ id: "conversation", tokens: used }]
      : summed < used
        ? [...categories, { id: "uncategorized", tokens: used - summed }]
        : categories;
  return {
    occupancyKnown: true,
    capacityKnown: true,
    max,
    used,
    pct: Math.max(0, Math.min(100, Math.round((used / max) * 100))),
    categories: parts.filter((part) => part.tokens > 0),
  };
}

/** True when a usage payload carries non-zero token counts or a native context snapshot. */
export function hasReadableUsage(usage: unknown): boolean {
  const raw = asRecord(usage);
  return Boolean(raw && (parseUsage(raw) !== null || raw.context_usage != null));
}

/** Latest message usage snapshot on a page that actually reports occupancy.
 *  Falls back to the last non-null usage (e.g. window-only metadata) when no
 *  row has token counts yet. */
export function latestMessageUsage(messages: ReadonlyArray<{ usage?: unknown }>): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasReadableUsage(messages[i].usage)) return messages[i].usage ?? null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].usage != null) return messages[i].usage ?? null;
  }
  return null;
}

/** Keep a previously reported context window when a later snapshot omits it.
 *  【cursor/agy上下文】后到的计费合计或空快照如果没带当前占用，沿用上一份，避免仪表退回未知。 */
export function mergeUsage(next: unknown, prev: unknown): unknown {
  if (!next) return prev ?? null;
  const nextObj = asRecord(next);
  const prevObj = asRecord(prev);
  if (!nextObj || !prevObj) return next;
  // An all-zero placeholder (e.g. a locally generated error row or aborted turn)
  // carries no occupancy of its own and must not wipe a known token snapshot;
  // only a context window attached to it is worth forwarding.
  if (!hasReadableUsage(nextObj) && hasReadableUsage(prevObj)) {
    const nextWindow = reportedContextWindow(nextObj);
    return nextWindow ? { ...prevObj, model_context_window: nextWindow } : prev;
  }
  const window = reportedContextWindow(nextObj) ? undefined : reportedContextWindow(prevObj);
  const withWindow = window ? { ...nextObj, model_context_window: window } : nextObj;
  const nextHasCurrentContext =
    withWindow.context_usage_kind === "current_context" && withWindow.context_usage != null;
  const nextHasAnyContext =
    Boolean(withWindow.context_usage_kind) && withWindow.context_usage != null;
  if (
    nextHasCurrentContext ||
    prevObj.context_usage == null ||
    (nextHasAnyContext && prevObj.context_usage_kind !== "current_context")
  ) {
    return withWindow;
  }
  return {
    ...withWindow,
    context_usage_kind: prevObj.context_usage_kind,
    context_usage: prevObj.context_usage,
  };
}
