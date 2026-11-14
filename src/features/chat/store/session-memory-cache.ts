import type { Message, SessionMeta } from "@/lib/ipc";
import { runRouting, type SessionState } from "./stream";
import { sessionKey } from "./persistence";
import type { LoadHistoryPage, StoreGet, StoreSet, StoreSubscribe } from "./context";
import { askLoops } from "./ask-loop";

// Evidence belongs to these immutable arrays, not to a session id: a new live
// row invalidates it automatically. Weak keys cannot retain evicted histories.
const historySources = new WeakMap<Message[], Message[]>();
const estimatedArrays = new WeakMap<Message[], number>();
const localRowArrays = new WeakMap<Message[], boolean>();

function hasLocalRows(messages: Message[]): boolean {
  const cached = localRowArrays.get(messages);
  if (cached !== undefined) return cached;
  const result = messages.some(message => message.live === true || message.seq < 0 ||
    !!message.question || !!message.grant || !!message.planReview || !!message.internalSource ||
    message.role === "question" || message.role === "grant");
  localRowArrays.set(messages, result);
  return result;
}

export function markReloadableHistory(messages: Message[], subagentHistory: Message[]): void {
  if (!hasLocalRows(messages) && !hasLocalRows(subagentHistory)) historySources.set(messages, subagentHistory);
}

export function hasReloadableHistory(session: Pick<SessionState, "messages" | "subagentHistory">): boolean {
  return historySources.get(session.messages) === session.subagentHistory;
}

/** An estimate for cache admission, not a JS heap measurement. Avoid allocating
 * a second full JSON string just to decide whether a large payload can leave. */
function estimateArray(messages: Message[]): number {
  const cached = estimatedArrays.get(messages);
  if (cached !== undefined) return cached;
  const seen = new Set<object>();
  const size = (value: unknown): number => {
    if (typeof value === "string") return 24 + value.length * 2;
    if (value === null || typeof value !== "object") return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    let bytes = 32;
    for (const [key, child] of Object.entries(value)) bytes += key.length * 2 + 8 + size(child);
    return bytes;
  };
  const bytes = size(messages);
  estimatedArrays.set(messages, bytes);
  return bytes;
}

export function estimatedHistoryBytes(session: Pick<SessionState, "messages" | "subagentHistory">): number {
  return estimateArray(session.messages) + estimateArray(session.subagentHistory);
}

/** All payload fields participate. Only the settled display marker live:false
 * is equivalent to its absence in native history; no text/seq/time truncation. */
function sameHistoryValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left), other = Object.keys(right);
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && sameHistoryValue(left[key], right[key]));
}

function sameHistoryRow(a: Message, b: Message): boolean {
  const settled = (row: Message) => {
    if (row.live !== false) return row;
    const { live: _live, ...rest } = row;
    return rest;
  };
  return sameHistoryValue(settled(a), settled(b));
}

type Candidate = { key: string; session: SessionState; bytes: number; touched: number };
type ProofRetry = { messages: number; subagents: number; source: string; attempts: number; after: number };
export interface SessionMemoryCache {
  schedule(): void;
  touch(key: string): void;
  forget(key: string): void;
  connect(subscribe: StoreSubscribe): () => void;
  dispose(): void;
}

/** Reclaim only inactive, reloadable history. Control/identity/usage fields stay
 * in a shell so releasing a cache cannot undo Stop or revive an old run. The
 * limits are a warm-cache target: active or unproven content may exceed them. */
export function createSessionMemoryCache(deps: {
  get: StoreGet;
  set: StoreSet;
  loadHistoryPage: LoadHistoryPage;
  paused?: () => boolean;
  maxEntries?: number;
  maxBytes?: number;
  delayMs?: number;
  retryMs?: number;
}): SessionMemoryCache {
  const maxEntries = deps.maxEntries ?? 10, maxBytes = deps.maxBytes ?? 64 * 1024 * 1024;
  const delayMs = deps.delayMs ?? 1_000, retryMs = deps.retryMs ?? 30_000;
  const touches = new Map<string, { version?: number; at: number; interacted?: boolean }>();
  const versions = new WeakMap<object, number>();
  let nextVersion = 0;
  const versionOf = (value: object): number => {
    let version = versions.get(value);
    if (version === undefined) { version = ++nextVersion; versions.set(value, version); }
    return version;
  };
  const retries = new Map<string, ProofRetry>();
  let tick = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;
  let off: (() => void) | undefined;
  let flight: Candidate | undefined;
  let previousOpen = new Set<string>();
  let previousTabs = deps.get()?.openTabs;
  let previousActive = deps.get()?.active;

  const paused = () => disposed || deps.paused?.() || !deps.get().initialized;
  function candidates(): Candidate[] {
    const state = deps.get();
    const open = new Set(state.openTabs.map(tab => sessionKey(tab.engine, tab.sessionId, tab.workspacePath)));
    if (state.active) open.add(sessionKey(state.active.engine, state.active.sessionId, state.active.workspacePath));
    const routed = new Set(runRouting.values());
    const result: Candidate[] = [];
    for (const [key, session] of Object.entries(state.bySession)) {
      if (key.startsWith("new:") || state.archivedSessionKeys[key] || open.has(key) || routed.has(key) || askLoops.has(key) || session.loading || session.draftLaunching ||
        session.streaming || state.streamingByKey[key] || state.retryingByKey[key] || session.retry || session.compaction ||
        session.error || session.failedTurn || session.queue.length || session.interrupted || session.queueParked || session.handoff ||
        session.interruptRequestedAt != null || session.followUpAt != null || session.nativeActivity ||
        session.hostTaskOrigin && !session.hostTaskOrigin.sessionId ||
        session.nativeTasks?.some(task => !["completed", "failed", "stopped"].includes(task.status)) ||
        hasLocalRows(session.messages) || hasLocalRows(session.subagentHistory) ||
        !session.messages.length && !session.subagentHistory.length) continue;
      result.push({ key, session, bytes: estimatedHistoryBytes(session), touched: touches.get(key)?.at ?? 0 });
    }
    return result.sort((a, b) => a.touched - b.touched);
  }

  const overBudget = (rows: Candidate[]) => rows.length > maxEntries || rows.reduce((sum, row) => sum + row.bytes, 0) > maxBytes;
  function release(row: Candidate): boolean {
    if (paused() || !hasReloadableHistory(row.session)) return false;
    let released = false;
    deps.set(state => {
      // Repeat eligibility at commit: opening a tab, a new run, or an approval
      // may have arrived while a native history proof was being read.
      if (state.bySession[row.key] !== row.session || !candidates().some(candidate => candidate.key === row.key)) return {};
      released = true;
      return { bySession: { ...state.bySession, [row.key]: {
        ...row.session, messages: [], subagentHistory: [], historyReloadRequired: true, historyReloadError: undefined,
      } } };
    });
    if (released) retries.delete(row.key);
    return released;
  }

  function catalogFor(row: Candidate): SessionMeta | undefined {
    const matches = deps.get().sessions.filter(meta => sessionKey(meta.engine, meta.sessionId, meta.workspacePath) === row.key);
    // The ordinary loader knows local and plugin/remote sources. No guessed
    // workspace or optimistic (not yet discovered) source may prove durability.
    return matches.length === 1 && (matches[0].remote ? !!matches[0].remotePath : !!matches[0].filePath) ? matches[0] : undefined;
  }

  const sourceSignature = (meta: SessionMeta): string => JSON.stringify([
    meta.engine, meta.sessionId, meta.workspacePath, meta.remote === true,
    meta.filePath, meta.remotePath, meta.fileSize, meta.fileMtimeMs,
  ]);
  function retryFor(row: Candidate, meta: SessionMeta): ProofRetry {
    const messages = versionOf(row.session.messages), subagents = versionOf(row.session.subagentHistory);
    const source = sourceSignature(meta), previous = retries.get(row.key);
    if (previous?.messages === messages && previous.subagents === subagents && previous.source === source) return previous;
    // Numeric weak identities and a small source fingerprint cannot retain
    // old text. Catalog object churn alone must not reset exhausted attempts.
    const retry = { messages, subagents, source, attempts: 0, after: 0 };
    retries.set(row.key, retry);
    return retry;
  }

  async function prove(row: Candidate, meta: SessionMeta): Promise<boolean> {
    const source = sourceSignature(meta);
    const current = () => {
      const currentMeta = catalogFor(row);
      return !paused() && flight === row && deps.get().bySession[row.key] === row.session &&
        !!currentMeta && sourceSignature(currentMeta) === source && candidates().some(candidate => candidate.key === row.key);
    };
    let cursor = row.session.messages.length - 1;
    let before: number | null | undefined;
    const seenPages = new Set<number>();
    // A proof is bounded work, not an eager full-history loader. Very large or
    // differently represented transcripts remain resident instead of losing data.
    for (let pageIndex = 0; pageIndex < 20 && current(); pageIndex++) {
      const page = await deps.loadHistoryPage(meta.engine, meta.sessionId, meta.workspacePath, 100, before, meta);
      if (!current()) return false;
      if (pageIndex === 0 && !sameHistoryValue(row.session.subagentHistory, page.subagentHistory)) return false;
      for (let index = page.messages.length - 1; index >= 0 && cursor >= 0; index--) {
        if (sameHistoryRow(row.session.messages[cursor], page.messages[index])) cursor--;
      }
      if (cursor < 0) return true;
      if (page.nextBefore === null || seenPages.has(page.nextBefore) || before != null && page.nextBefore >= before) return false;
      seenPages.add(page.nextBefore);
      before = page.nextBefore;
    }
    return false;
  }

  function arm(delay: number) {
    if (disposed || timer !== undefined && timerAt <= Date.now() + delay) return;
    if (timer !== undefined) clearTimeout(timer);
    timerAt = Date.now() + delay;
    timer = setTimeout(() => { timer = undefined; sweep(); }, delay);
  }
  function sweep() {
    if (paused()) return;
    // Whole-store work is batched here, never in the per-delta subscription.
    // Restored/unobserved histories begin oldest; explicit access/close order
    // wins over this approximate once-per-sweep activity recency.
    const state = deps.get();
    for (const key of touches.keys()) if (!state.bySession[key]) { touches.delete(key); retries.delete(key); }
    for (const [key, session] of Object.entries(state.bySession)) {
      const prior = touches.get(key);
      const version = versionOf(session);
      // Only numeric identities survive the sweep. Recency bookkeeping must
      // not itself keep an old message array alive until another timer fires.
      touches.set(key, { version, at: prior
        ? prior.version !== version && !prior.interacted ? ++tick : prior.at
        : 0 });
    }
    let rows = candidates();
    for (const row of rows) {
      if (!overBudget(rows)) break;
      if (hasReloadableHistory(row.session) && release(row)) rows = rows.filter(item => item !== row);
    }
    if (!overBudget(rows) || flight) return;
    const now = Date.now();
    for (const row of rows) {
      const meta = catalogFor(row);
      if (!meta) continue;
      const retry = retryFor(row, meta);
      // A representation mismatch cannot be repaired by polling forever. Three
      // attempts accommodate a delayed flush; later work needs new content or
      // a genuinely changed source file before any more history IPC is spent.
      if (retry.attempts >= 3 || retry.after > now) continue;
      flight = row;
      retry.attempts++;
      retry.after = now + retryMs;
      void prove(row, meta).then(proven => {
        if (proven && !paused() && flight === row && deps.get().bySession[row.key] === row.session) {
          markReloadableHistory(row.session.messages, row.session.subagentHistory);
          if (overBudget(candidates())) release(row);
        }
      }).catch(() => { /* Missing/late native history is not permission to drop live content. */ }).finally(() => {
        if (flight === row) flight = undefined;
        if (!disposed) arm(delayMs);
      });
      return;
    }
    const next = rows.reduce((at, row) => {
      const retry = retries.get(row.key);
      return retry && retry.attempts < 3 && retry.after > now ? Math.min(at, retry.after) : at;
    }, Infinity);
    if (Number.isFinite(next)) arm(Math.max(delayMs, next - now));
  }
  const schedule = () => arm(delayMs);
  const touch = (key: string) => { touches.set(key, { ...touches.get(key), at: ++tick, interacted: true }); };
  function observe() {
    const state = deps.get();
    if (state.openTabs !== previousTabs) {
      const open = new Set(state.openTabs.map(tab => sessionKey(tab.engine, tab.sessionId, tab.workspacePath)));
      for (const key of open) if (!previousOpen.has(key)) touch(key);
      previousOpen = open; previousTabs = state.openTabs;
    }
    if (state.active !== previousActive) {
      if (state.active) touch(sessionKey(state.active.engine, state.active.sessionId, state.active.workspacePath));
      previousActive = state.active;
    }
    schedule();
  }
  function dispose() {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    off?.(); off = undefined;
    flight = undefined; touches.clear(); retries.clear(); previousOpen.clear(); previousActive = null;
  }
  return {
    schedule,
    touch,
    forget(key) { touches.delete(key); retries.delete(key); },
    connect(subscribe) { off?.(); off = subscribe(observe); observe(); return dispose; },
    dispose,
  };
}
