import type { Message, TodosPayload } from "@/lib/ipc";
import type { NativeActivity, NativeTask } from "@/lib/events";
import type { LiveLaunch } from "./live-follow-up";
import type { ThroughputState } from "../throughput";
import { normalizeEffortLevel } from "@/components/application/ai-chat/effort-levels";
import { encodedModelEffort } from "@/components/application/ai-chat/model-effort";

/**
 * Streaming buffers and bySession write helpers. Leaf module: functions are
 * generic over a minimal BySessionSlice so neither this file nor
 * engine-events needs a runtime import of the store itself (no cycles).
 */

export interface QueuedMessage {
  id: string;
  text: string;
  images: string[];
  queuedAt: number;
  /** Computer-use send: the flag rides the queue so the drained turn still
   *  mounts the driver instead of silently running text-only. */
  computerUse?: boolean;
  /** The live path already failed for this row (image load / pipe write): it
   *  waits for the final done like an ordinary queued message instead of
   *  retrying at every idle boundary. */
  noLive?: boolean;
  /** A rejected or unconfirmed native steer requires an explicit retry. */
  manualOnly?: boolean;
  /** Stable submission order for concurrent Codex inputs returned to queue. */
  steerOrder?: number;
}

/** Where a turn handed to Codex Desktop stands (see the backend's
 *  `codex_desktop`): delivering → waiting → running, or waiting on the
 *  user's approval / input inside Desktop. */
export interface HandoffState {
  stage: "delivering" | "waiting" | "running" | "approval" | "input";
  model: string | null;
  effort: string | null;
}

/** One step of queue reorder. Directions are relative to the queue card,
 *  which paints newest-first: "up" moves the row toward the top (= later in
 *  send order), "down" toward the composer (= sooner). */
export type QueueMoveDirection = "up" | "down";

export interface SessionState {
  /** A draft's first send is preparing or awaiting native launch. */
  draftLaunching?: string;
  messages: Message[];
  /** Older delegation metadata kept outside the paginated message window. */
  subagentHistory: Message[];
  nextBefore: number | null;
  loading: boolean;
  streaming: boolean;
  /** Native Claude task catalog: presence suppresses heuristic Agent rows.
   * Statuses are exclusively owned by native task events, including after done. */
  nativeTasks?: NativeTask[];
  nativeTaskRunId?: string;
  nativeTaskSeq?: number;
  nativeActivity?: NativeActivity | null;
  /** Retired catalog owners cannot replace the next run with delayed events. */
  retiredNativeRunIds?: string[];
  /** What the live CLI process was launched with (the CLI fixes model, effort,
   *  provider and permission at launch); a user message may only go straight
   *  into that process while the session still resolves to the same values.
   *  Unknown for a run this client did not launch. */
  liveLaunch?: LiveLaunch;
  /** Locally launched Codex transport owner; never inferred from telemetry. */
  codexRunId?: string;
  /** When a message was last handed to the live CLI while it idled. Guards the
   *  queue: one idle boundary emits two `waiting` events and must release one
   *  item. Cleared by the CLI's own next event; expires on its own because a
   *  CLI that never reacts emits nothing to clear it. */
  followUpAt?: number | null;
  /** The queue is parked by an explicit Stop that left the run alive (a kill
   *  parks through `interrupted` instead): nothing drains until the user sends. */
  queueParked?: boolean;
  /** When Stop interrupted the current reply and the CLI has not yet ended it. */
  interruptRequestedAt?: number | null;
  /** When Stop last interrupted this run's reply. Kept after acknowledgement
   *  to coalesce a second click on a CLI that already idles. */
  lastInterruptAt?: number | null;
  /** Epoch ms when the current streaming turn began; drives the tail
   * indicator's elapsed timer so it survives the indicator's unmount/remount
   * cycle (idle ↔ growing) instead of restarting from 0 every pause. */
  turnStartedAt: number | null;
  activeModel?: string | null;
  activeEffort?: string | null;
  claudeUltracode?: boolean;
  /** In-app channel this session runs; spawn injects its env. */
  activeProvider?: string | null;
  /** Whether the turn currently running was sent with 电脑操控; read by
   *  resendLastUser so a retry repeats the same kind of turn. */
  activeComputerUse?: boolean;
  /** Newest single report: the context meter reads occupancy from it. */
  usage: unknown;
  /** Running total of the reply in flight (sum of its reports), so the tail
   *  indicator counts this reply instead of showing one request's slice. */
  turnUsage: unknown;
  /** Ephemeral host sample for this run; never reconstructed from history. */
  throughput?: ThroughputState | null;
  /** Bounded terminal-run history; late events must not revive a finished turn. */
  settledRunIds?: string[];
  error: string | null;
  /** Live provider-retry progress for the running turn ("重试中 2/5"). The
   * CLI is backing off and will re-issue the request, so this is progress,
   * not a failure: it clears on the next content event or when the turn
   * settles. `null` when nothing is being retried. */
  retry: { attempt: number; max: number; message: string } | null;
  /** Context compaction in progress: set by the composer compact action
   *  (manual) or by the engine's compaction events (automatic, omp rpc-ui).
   *  Cleared when the compact turn settles or the engine reports the end. */
  compaction: { automatic: boolean; startedAt: number } | null;
  /** The running turn was handed to Codex Desktop, which holds the thread:
   *  the tail shows `stage`, and rows carry Desktop's own model and effort
   *  (null when unknown) instead of this tab's pick. Cleared when the turn
   *  settles. */
  handoff?: HandoffState | null;
  /** Messages typed while a turn streams; sent FIFO when the turn ends. */
  queue: QueuedMessage[];
  /** Set by interrupt(): the next "done" settles the turn but must not
   * auto-drain the queue — pressing stop is not "go on to the next". */
  interrupted: boolean;
  /** Deferred plan the user explicitly reopened from its timeline card
   *  (`"${planId}:${revision}"`): the approval dock mounts for it again.
   *  Pure UI state — the backend record stays `deferred` either way. */
  planReviewResume: string | null;
}

export const EMPTY_SESSION: SessionState = {
  messages: [],
  subagentHistory: [],
  nextBefore: null,
  loading: false,
  streaming: false,
  turnStartedAt: null,
  activeModel: null,
  activeEffort: null,
  activeProvider: null,
  usage: null,
  turnUsage: null,
  throughput: null,
  error: null,
  retry: null,
  compaction: null,
  queue: [],
  interrupted: false,
  planReviewResume: null,
};

/** The model one session runs with, most specific first:
 *
 *  1. the tab's own pick (an explicit choice for this session),
 *  2. what the engine reported running for this session,
 *  3. the model this session's history was written with,
 *  4. the engine default (new chats, sessions with no history yet).
 *
 * Per session on purpose: two omp sessions may run different models, so the
 * picker, the send, and the stamped rows must all read the session's model —
 * an engine-wide default would make one session's pick leak into the other.
 */
export function resolveSessionModel(
  tab: { engine: string; model?: string } | null | undefined,
  session: Pick<SessionState, "activeModel" | "messages"> | undefined,
  engineDefault?: string,
): string | undefined {
  if (!tab) return engineDefault;
  if (tab.model) return tab.model;
  if (session?.activeModel) return session.activeModel;
  const messages = session?.messages;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const model = messages[i].model;
      if (model) return model;
    }
  }
  return engineDefault;
}

/** The reasoning level one session runs with. A native session owns its level
 * in SessionState/database; only a not-yet-created tab may carry a starting
 * override. This prevents stale persisted tab fields from shadowing a newer
 * level recorded by another client. */
export function resolveSessionEffort(
  tab: { engine: string; sessionId?: string | null; effort?: string | null; model?: string } | null | undefined,
  session: Pick<SessionState, "activeEffort" | "activeModel" | "messages"> | undefined,
  engineDefault?: string,
  modelDefault?: string,
): string | undefined {
  if (!tab) return engineDefault;
  const model = resolveSessionModel(tab, session, modelDefault);
  if (model && encodedModelEffort(tab.engine, model)) return undefined;
  if (tab.sessionId === null && tab.effort) return normalizeEffortLevel(tab.engine, tab.effort);
  if (session?.activeEffort) return normalizeEffortLevel(tab.engine, session.activeEffort);
  const messages = session?.messages;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].model && encodedModelEffort(tab.engine, messages[i].model!)) return undefined;
      const effort = messages[i].effort;
      if (effort) return normalizeEffortLevel(tab.engine, effort);
    }
  }
  return normalizeEffortLevel(tab.engine, engineDefault);
}

/** Claude's launch switch is session-scoped; explicit false is a choice. */
export function resolveClaudeUltracode(
  tab: { engine: string; sessionId?: string | null; claudeUltracode?: boolean } | null | undefined,
  session: Pick<SessionState, "claudeUltracode"> | undefined,
  defaultValue = false,
): boolean {
  if (tab?.engine !== "claude") return false;
  if (tab.sessionId === null && tab.claudeUltracode !== undefined) return tab.claudeUltracode;
  return session?.claudeUltracode ?? defaultValue;
}

/** The in-app channel one session runs with. A native session owns it in
 * SessionState / session_providers; only a not-yet-created tab may carry a
 * starting override. There is no message-history scan: the transcript does
 * not record the channel. */
export function resolveSessionProvider(
  tab: { engine: string; sessionId?: string | null; provider?: string | null } | null | undefined,
  session: Pick<SessionState, "activeProvider"> | undefined,
  engineDefault?: string,
): string | undefined {
  if (!tab) return engineDefault;
  if (tab.sessionId === null && tab.provider) return tab.provider;
  if (session?.activeProvider) return session.activeProvider;
  return engineDefault;
}

/** Minimal store shape these helpers touch. */
export interface BySessionSlice {
  bySession: Record<string, SessionState>;
}

export type SetFn<T extends BySessionSlice> = (fn: (s: T) => Partial<T>) => void;

/** runId -> sessionKey routing for engine events. Entries are removed when
 * the run settles (done/error) or is interrupted — the map must not grow
 * monotonically over the app's lifetime. */
export const runRouting = new Map<string, string>();

export function rememberSettledRun(session: SessionState | undefined, runId: string): string[] {
  return [...(session?.settledRunIds ?? []).filter((id) => id !== runId), runId].slice(-32);
}
/** runId -> last activity (stamped at routing, refreshed on each routed
 * event). A run that dies without done/error (engine crash, killed process)
 * never gets its routing entry removed by the settling paths, so each newly
 * routed run sweeps entries silent for longer than the TTL — bounded, no
 * timer. Silence only requests a native registry check; it never proves
 * that a turn ended. Replacing records fences late registry responses. */
const runActivity = new Map<string, { seenAt: number; checkedAt: number; nativeBackgroundActive: boolean }>();
const RUN_ORPHAN_TTL_MS = 30 * 60_000;

/** Route a run and invalidate any pending check for its previous identity. */
export function routeRun(runId: string, key: string): void {
  runRouting.set(runId, key);
  runActivity.set(runId, { seenAt: Date.now(), checkedAt: 0, nativeBackgroundActive: runActivity.get(runId)?.nativeBackgroundActive ?? false });
}

/** Refresh a live run's activity stamp on each routed event. */
export function touchRun(runId: string) {
  const activity = runActivity.get(runId);
  if (activity) runActivity.set(runId, { ...activity, seenAt: Date.now() });
}

/** A native task catalog explicitly proves background work is still running.
 * Silence cannot end that work; real done/error/stop removes this entry. */
export function setNativeBackgroundActive(runId: string, active: boolean) {
  const activity = runActivity.get(runId);
  if (activity) runActivity.set(runId, { ...activity, nativeBackgroundActive: active });
}

/** Forget a settled run (its routing entry is dropped by the settling path). */
export function untrackRun(runId: string) {
  runActivity.delete(runId);
}

let orphanCheck: Promise<void> | undefined;
let orphanCheckRequested = false;

/** Coalesce routing-triggered checks. Missing/failed native queries preserve
 * candidates; only a confirmed absent, unchanged run may be settled. */
export function reconcileOrphanRuns(
  activeRunIds: (runIds: string[]) => Promise<string[]>,
  settle: (orphaned: Array<[string, string]>) => void,
): Promise<void> {
  orphanCheckRequested = true;
  if (orphanCheck) return orphanCheck;
  orphanCheck = Promise.resolve().then(async () => {
    while (orphanCheckRequested) {
      orphanCheckRequested = false;
      const now = Date.now();
      const candidates = [...runActivity].flatMap(([runId, activity]) => {
        const key = runRouting.get(runId);
        return key !== undefined && !activity.nativeBackgroundActive &&
          now - Math.max(activity.seenAt, activity.checkedAt) >= RUN_ORPHAN_TTL_MS
          ? [{ runId, key, activity }] : [];
      });
      for (let offset = 0; offset < candidates.length; offset += 256) {
        const batch = candidates.slice(offset, offset + 256);
        let active: Set<string>;
        try {
          const ids = await activeRunIds(batch.map(({ runId }) => runId));
          if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) continue;
          active = new Set(ids);
        } catch { continue; }
        const orphaned: Array<[string, string]> = [];
        for (const { runId, key, activity } of batch) {
          if (runActivity.get(runId) !== activity || runRouting.get(runId) !== key) continue;
          if (active.has(runId)) {
            runActivity.set(runId, { ...activity, checkedAt: Date.now() });
          } else {
            runActivity.delete(runId);
            runRouting.delete(runId);
            orphaned.push([runId, key]);
          }
        }
        if (orphaned.length) settle(orphaned);
      }
    }
  }).finally(() => { orphanCheck = undefined; });
  return orphanCheck;
}

/** One ordered stream chunk. Thinking and text deltas interleave within a
 * turn (extended thinking resumes between tool calls), so per-kind string
 * buffers would scramble their relative order; parts append in arrival order
 * and merge with the previous part when the kind matches. */
interface StreamPart {
  kind: "delta" | "thinking";
  text: string;
}
interface PendingStream {
  model: string | null;
  effort?: string | null;
  parts: StreamPart[];
}
/** sessionKey -> ordered stream chunks not yet flushed into rows */
const pendingStreams = new Map<string, PendingStream>();
let rafScheduled = false;
let fallbackScheduled = false;
let streamGeneration = 0;

export const adoptedDraftKeys = new Map<string, string>();

/** Resolve a pending draft key (`new:<engine>:<ws>`) that was adopted into a
 *  native session key (`<engine>/<sessionId>`), so a composer callback or
 *  store action whose closure still holds the pre-adoption key/tab before
 *  React re-renders routes to the adopted session instead of a dead key. */
export function resolveLiveSessionKey(
  key: string,
  openTabs?: ReadonlyArray<{ engine: string; sessionId: string | null; workspacePath: string }>,
): string {
  if (!key.startsWith("new:")) return key;
  if (
    openTabs?.some(
      (t) => t.sessionId === null && `new:${t.engine}:${t.workspacePath}` === key,
    )
  ) {
    return key;
  }
  const adopted = adoptedDraftKeys.get(key);
  if (!adopted) return key;
  if (!openTabs) return adopted;
  const slash = adopted.indexOf("/");
  const engine = slash > 0 ? adopted.slice(0, slash) : "";
  const sessionId = slash > 0 ? adopted.slice(slash + 1) : "";
  return openTabs.some((t) => t.engine === engine && t.sessionId === sessionId)
    ? adopted
    : key;
}

export function resolveLiveSessionTab<
  T extends { engine: string; sessionId: string | null; workspacePath: string },
>(
  tab: T | null | undefined,
  openTabs?: readonly T[],
): T | null {
  if (!tab) return null;
  if (tab.sessionId !== null) return tab;
  const key = `new:${tab.engine}:${tab.workspacePath}`;
  const resolvedKey = resolveLiveSessionKey(key, openTabs);
  if (resolvedKey === key) return tab;
  const slash = resolvedKey.indexOf("/");
  const sessionId = slash > 0 ? resolvedKey.slice(slash + 1) : null;
  if (!sessionId) return tab;
  return (
    openTabs?.find(
      (t) =>
        t.engine === tab.engine &&
        t.sessionId === sessionId &&
        t.workspacePath === tab.workspacePath,
    ) ?? { ...tab, sessionId }
  );
}

export interface StreamRuntimeCheckpoint {
  routes: Array<[string, string]>;
  activity: Array<[string, { seenAt: number; checkedAt: number; nativeBackgroundActive: boolean }]>;
  pending: Array<[string, PendingStream]>;
}

export function captureStreamRuntime(): StreamRuntimeCheckpoint {
  return { routes: [...runRouting], activity: [...runActivity], pending: [...pendingStreams] };
}

export function restoreStreamRuntime(snapshot: StreamRuntimeCheckpoint): void {
  streamGeneration++;
  rafScheduled = false;
  fallbackScheduled = false;
  runRouting.clear(); runActivity.clear(); pendingStreams.clear(); adoptedDraftKeys.clear();
  for (const [id, key] of snapshot.routes) runRouting.set(id, key);
  for (const [id, activity] of snapshot.activity) runActivity.set(id, activity);
  for (const [key, pending] of snapshot.pending) pendingStreams.set(key, pending);
}

/** Fold stream parts into the message list in place. omp interleaves the
 *  thinking and text channels within ONE assistant message (GLM emits
 *  reasoning deltas between text deltas), so each channel must grow a
 *  single row: appending to the last live row OF THAT ROLE — skipping the
 *  other channel's live row — instead of the last row overall. Text
 *  therefore stays one continuous markdown document (a mid-message split
 *  leaves `**`/backticks unclosed and renders literally) and thinking folds
 *  into one process section. A settled row ends its segment: tool starts
 *  and turn boundaries settle rows, so post-tool text correctly starts a
 *  fresh row. */
export function applyStreamParts(
  messages: Message[],
  parts: StreamPart[],
  model: string | null,
  effort: string | null = null,
): Message[] {
  let out = messages;
  for (const part of parts) {
    if (!part.text) continue;
    const role = part.kind === "thinking" ? "thinking" : "assistant";
    // Scan back over live rows (the other channel) to this channel's row;
    // stop at the first settled row — everything before it is history.
    let target = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      // Native steering may arrive in the middle of one agentMessage item.
      // Keep its Markdown/copy content continuous until an actual boundary.
      if (out[i].role === "user" && out[i].steer) continue;
      if (out[i].live) {
        if (out[i].role === role) {
          target = i;
          break;
        }
      } else {
        break;
      }
    }
    if (target >= 0) {
      if (out === messages) out = messages.slice();
      const last = out[target];
      out[target] = { ...last, text: last.text + part.text };
      continue;
    }
    const seq = out.length ? out[out.length - 1].seq + 1 : 1;
    if (out === messages) out = messages.slice();
    out.push({
      seq,
      role,
      text: part.text,
      ts: new Date().toISOString(),
      live: true,
      ...(role === "assistant" ? { model, effort } : {}),
    });
  }
  return out;
}

/** Clear the live flag on every row; identity-preserving when nothing is
 * live. Rows stop growing once their segment is over (tool start, turn end). */
export function settleLiveRows(messages: Message[]): Message[] {
  if (!messages.some((m) => m.live)) return messages;
  return messages.map((m) => (m.live ? { ...m, live: false } : m));
}

export function bufferStreamPart(
  key: string,
  kind: StreamPart["kind"],
  text: string,
  model: string | null,
  effort: string | null = null,
) {
  const pending = pendingStreams.get(key) ?? { model, effort, parts: [] };
  if (!pending.model && model) pending.model = model;
  if (!pending.effort && effort) pending.effort = effort;
  const last = pending.parts[pending.parts.length - 1];
  if (last?.kind === kind) last.text += text;
  else pending.parts.push({ kind, text });
  pendingStreams.set(key, pending);
}

export function updatePendingStreamModel(key: string, model: string, effort?: string | null) {
  const pending = pendingStreams.get(key);
  if (pending) {
    pending.model = model;
    if (effort !== undefined) pending.effort = effort;
  }
}

/** Pull one session's unflushed stream chunks out of the pending map. Any
 * structural path (tool row, done, error, interrupt) must fold these in —
 * otherwise chunks between the last flush and the structural event land
 * after it, out of order. */
export function drainPending(key: string): PendingStream | null {
  const pending = pendingStreams.get(key) ?? null;
  pendingStreams.delete(key);
  return pending;
}

/** Move unflushed stream chunks when a session's key changes (pending tab
 * adopts its native id), or the next flush resurrects the old key with
 * orphaned content. */
export function migratePendingStream(fromKey: string, toKey: string) {
  const pending = pendingStreams.get(fromKey);
  if (!pending) return;
  pendingStreams.delete(fromKey);
  const existing = pendingStreams.get(toKey);
  pendingStreams.set(
    toKey,
    existing
      ? {
          model: existing.model ?? pending.model,
          effort: existing.effort ?? pending.effort,
          parts: [...existing.parts, ...pending.parts],
        }
      : pending,
  );
}

/** Append a live tool-call row. Buffered stream chunks are folded in first
 * so an interleaved "thinking → text → tool → text" turn keeps chronological
 * order, and the rows they grew settle — the next delta starts a fresh row
 * below the tool call. */
export function appendToolMessage<T extends BySessionSlice>(
  set: SetFn<T>,
  key: string,
  text: string,
  model: string | null,
  path: string | null = null,
  todos: TodosPayload | null = null,
  args?: unknown,
  patch = false,
  result?: unknown,
) {
  appendToolMessages(set, key, [{ text, path, todos, args, patch, result }], model);
}

export interface ToolMessageInput {
  text: string;
  path?: string | null;
  todos?: TodosPayload | null;
  args?: unknown;
  patch?: boolean;
  result?: unknown;
}

function sameToolValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const seen = new WeakMap<object, object>();
  while (pending.length) {
    const [current, incoming] = pending.pop()!;
    if (Object.is(current, incoming)) continue;
    if (!current || !incoming || typeof current !== "object" || typeof incoming !== "object") return false;
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.getPrototypeOf(incoming)) return false;
    if (Array.isArray(current)) {
      if (current.length !== (incoming as unknown[]).length) return false;
    } else if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const previous = seen.get(current);
    if (previous) {
      if (previous !== incoming) return false;
      continue;
    }
    seen.set(current, incoming);
    const keys = Object.keys(current);
    if (keys.length !== Object.keys(incoming).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(incoming, key)) return false;
      pending.push([(current as Record<string, unknown>)[key], (incoming as Record<string, unknown>)[key]]);
    }
  }
  return true;
}

export function appendToolMessages<T extends BySessionSlice>(
  set: SetFn<T>,
  key: string,
  tools: ToolMessageInput[],
  model: string | null,
) {
  if (tools.length === 0) return;
  const pending = drainPending(key);
  set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    let messages = pending
      ? applyStreamParts(prev.messages, pending.parts, pending.model ?? model, pending.effort)
      : prev.messages;
    messages = settleLiveRows(messages);
    const emptyTools = new Map<string, { indices: number[]; cursor: number }>();
    const indicesBySeq = new Map<number, number[]>();
    const toolIndices: number[] = [];
    const resultTargets = new Map<string, { scanned: number; index: number }>();
    const indexMessage = (message: Message, index: number) => {
      const indices = indicesBySeq.get(message.seq);
      if (indices) indices.push(index);
      else indicesBySeq.set(message.seq, [index]);
      if (message.role !== "tool") return;
      toolIndices.push(index);
      if (message.args == null) {
        const queue = emptyTools.get(message.text);
        if (queue) queue.indices.push(index);
        else emptyTools.set(message.text, { indices: [index], cursor: 0 });
      }
    };
    messages.forEach(indexMessage);
    const writable = () => {
      if (messages === prev.messages) messages = messages.slice();
    };
    for (const tool of tools) {
      const { text, path, todos, args, patch, result } = tool;
      if (!patch) {
        const message: Message = {
          role: "tool",
          text,
          path: path ?? null,
          ts: new Date().toISOString(),
          seq: messages.length ? messages[messages.length - 1].seq + 1 : 1,
          ...(todos ? { todos } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(result !== undefined ? { result } : {}),
        };
        writable();
        indexMessage(message, messages.length);
        messages.push(message);
        continue;
      }
      let target = -1;
      if (result !== undefined) {
        const cached = resultTargets.get(text);
        target = cached?.index ?? -1;
        for (let offset = toolIndices.length - 1; offset >= (cached?.scanned ?? 0); offset--) {
          const index = toolIndices[offset];
          if (!text || messages[index].text.includes(text)) {
            target = index;
            break;
          }
        }
        resultTargets.set(text, { scanned: toolIndices.length, index: target });
      } else {
        const queue = emptyTools.get(text);
        if (queue) {
          while (queue.cursor < queue.indices.length && messages[queue.indices[queue.cursor]].args != null) {
            queue.cursor++;
          }
          target = queue.indices[queue.cursor] ?? -1;
        }
      }
      if (target < 0) continue;
      for (const index of indicesBySeq.get(messages[target].seq)!) {
        const message = messages[index];
        const patchFields = result !== undefined
          ? { result, ...(todos ? { todos } : {}) }
          : {
              path: path ?? message.path,
              ...(todos ? { todos } : {}),
              ...(args !== undefined ? { args } : {}),
            };
        if (Object.entries(patchFields).every(([field, value]) => sameToolValue(message[field as keyof Message], value))) continue;
        writable();
        messages[index] = { ...message, ...patchFields };
      }
    }
    if (messages === prev.messages) return s;
    return { bySession: { ...s.bySession, [key]: { ...prev, messages } } } as Partial<T>;
  });
}

export function patchSession<T extends BySessionSlice>(
  set: SetFn<T>,
  key: string,
  patch: Partial<SessionState>,
) {
  set((s) => ({
    bySession: {
      ...s.bySession,
      [key]: { ...(s.bySession[key] ?? EMPTY_SESSION), ...patch },
    },
  }) as Partial<T>);
}

export function flushPendingStreams<T extends BySessionSlice>(set: SetFn<T>) {
  if (pendingStreams.size === 0) return;
  set((s) => {
    const bySession = { ...s.bySession };
    for (const [key, pending] of pendingStreams) {
      const prev = bySession[key] ?? EMPTY_SESSION;
      bySession[key] = {
        ...prev,
        messages: applyStreamParts(prev.messages, pending.parts, pending.model, pending.effort),
      };
    }
    return { bySession } as Partial<T>;
  });
  pendingStreams.clear();
}

export function scheduleDeltaFlush<T extends BySessionSlice>(set: SetFn<T>) {
  const generation = streamGeneration;
  // rAF stalls while the webview is occluded or the tab is backgrounded;
  // the timer guarantees buffered deltas still land within ~100ms. The
  // structural paths (tool row / done / error) drain the map directly, so a
  // late fallback flush is a harmless no-op.
  if (!fallbackScheduled) {
    fallbackScheduled = true;
    setTimeout(() => {
      if (generation !== streamGeneration) return;
      fallbackScheduled = false;
      flushPendingStreams(set);
    }, 100);
  }
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    if (generation !== streamGeneration) return;
    rafScheduled = false;
    flushPendingStreams(set);
  });
}

/** Write one session's streaming flag into the flat map ChatPage subscribes.
 * Reference-stable when the flag does not actually flip, so selectors keyed
 * on the map only re-render on real start/stop transitions. */
export function setStreamingFlag(
  rec: Record<string, true>,
  key: string,
  on: boolean,
): Record<string, true> {
  const has = rec[key] === true;
  if (has === on) return rec;
  const next = { ...rec };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

/** Write one session's retrying flag into the flat map consumed by the
 * sidebar. Reference-stable when the flag does not actually flip, so retry
 * progress never makes the sidebar subscribe to per-token session writes. */
export function setRetryingFlag(
  rec: Record<string, true>,
  key: string,
  on: boolean,
): Record<string, true> {
  const has = rec[key] === true;
  if (has === on) return rec;
  const next = { ...rec };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

/** Carry the retrying flag across a pending-to-native session-key migration. */
export function moveRetryingFlag(
  rec: Record<string, true>,
  fromKey: string,
  toKey: string,
): Record<string, true> {
  if (rec[fromKey] !== true || fromKey === toKey) return rec;
  const next = { ...rec };
  delete next[fromKey];
  next[toKey] = true;
  return next;
}

/** Carry the streaming flag across a session-key migration. */
export function moveStreamingFlag(
  rec: Record<string, true>,
  fromKey: string,
  toKey: string,
): Record<string, true> {
  if (rec[fromKey] !== true || fromKey === toKey) return rec;
  const next = { ...rec };
  delete next[fromKey];
  next[toKey] = true;
  return next;
}
