import type {
  Disposer, HostTaskCatalog, HostTaskExcerpt, HostTaskExcerptQuery, HostTaskHistoryPage, HostTaskHistoryQuery,
  HostTaskPlan, HostTaskPlanErrorCode, HostTaskPlanRecord, HostTaskPlanRequest, HostTaskReceipt, HostTaskSlot,
  HostTaskStatus, HostTaskSubmission, HostTasksApi, HostTaskSelection,
} from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import { newId } from "@/lib/id";
import {
  cloneCheckpointValue, isRuntimeSubmissionPaused, registerRuntimeCheckpointBlocker,
  runtimeCheckpoint, whenRuntimeSubmissionResumed, type RuntimeCheckpoint, type RuntimeCheckpointParticipant,
} from "@/lib/runtime-checkpoint";
import type { PluginStorageBackend } from "./context";
import {
  desktopTaskFacade, plausibleSessionId, registeredWorkspace, TaskPreSpawnError,
  type HostTaskFacade, type TaskAck, type TaskLaunchChoices, type TaskSessionRef, type HostUserRowIdentity,
} from "./task-facade";
import { normalizeTaskWritePaths, sameTaskPath, taskScopesConflict, type TaskWriteScope } from "./task-paths";
import { decodePersistedTaskClaims } from "./task-claims";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import { validateFixedInstructions, sameFixedInstructions, fixedInstructionsIdentity, supportsFixedInstructions } from "./fixed-instructions";

/**
 * Host task bridge (`ctx.tasks`). Persist-before-ack and persist-before-spawn:
 * a request is durable before submit() resolves, and a durable "starting"
 * fence precedes every native send. A fenced request is never sent again;
 * after a reload without live or settled native proof it becomes "unknown"
 * and keeps holding its declared write lock until native run/session settlement.
 * The slot pointer only moves on native session evidence.
 */

export const HOST_TASKS_INDEX_KEY = "__host_tasks_v1:index";
export const HOST_TASKS_PLANS_KEY = "__host_tasks_v1:plans";
export const HOST_TASKS_KEY_PREFIX = "__host_tasks_v1:";
const textKey = (requestId: string) => `${HOST_TASKS_KEY_PREFIX}text:${requestId}`;

const MAX_ENTRIES = 512;
const MAX_PLANS = 128;
const MAX_TEXT = 65_536;
const MAX_PROMPT = 120_000;
const MAX_HANDOFF = 6_000;
const TEXT_FLUSH_MS = 1_500;
const PLANNER_ENGINES = new Set(["claude", "codex", "pi"]);
const SETTLED = new Set<HostTaskStatus>(["completed", "failed", "cancelled"]);
const ACTIVE = new Set<HostTaskStatus>(["starting", "executing", "awaiting_permission"]);
const HOLDING_LOCKS = new Set<HostTaskStatus>([...ACTIVE, "unknown"]);
const STATUSES = new Set<HostTaskStatus>(["queued", ...HOLDING_LOCKS, ...SETTLED]);

type Receipt = Omit<HostTaskReceipt, "text" | "truncated">;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Entry {
  receipt: Mutable<Receipt>;
  fingerprint: string;
  prompt: string;
  displayText?: string;
  fixedInstructions?: import("@ccgui/plugin-sdk").HostFixedInstructions;
  userRow?: HostUserRowIdentity;
  images?: string[];
  writePaths: string[] | null;
  /** Explicit engine from the submission (null = any engine for reuse). */
  requestedEngine: string | null;
  /** Engine for a new chat, frozen at acceptance. */
  newEngine: string;
  launch: TaskLaunchChoices;
  sessionMode: "auto" | "new";
  lastSeq: number;
  /** Engine the native turn runs on, frozen at the fence. */
  execEngine?: string;
  cancelRequested?: true;
  ack?: true;
  sessionProven?: true;
  identityMismatch?: true;
  forgotten?: true;
  hasExplicitHandoff?: true;
  rolloverHandoffApplied?: true;
  pendingTerminal?: { status: HostTaskStatus; error?: string };
  hasText?: true;
  /** Continuous coordinator/children scope survives the initial turn settling.
   * Native cold-start claim scanning must treat this as an unknown claim with
   * no initial runId: that run's done cannot release continuation ownership. */
  conversationHolding?: boolean;
  coordination?: true;
  /** A permanent exclusive session reservation, also granted to validated legacy attachments. */
  conversationOwner?: true;
  conversationSession?: TaskSessionRef;
}

interface Index { version: 1; entries: Entry[]; slots: HostTaskSlot[] }
interface PlanStore { version: 1; plans: Array<HostTaskPlanRecord & { fingerprint: string }> }
interface TaskBridgeCheckpoint {
  version: 1;
  pluginId: string;
  index: Index;
  plans: PlanStore;
  texts: Array<[string, { text: string; truncated: boolean }]>;
  fenced: boolean;
  conversations?: ReturnType<ReturnType<typeof createTaskConversationBridge>["capture"]>;
}
type CheckpointCoordinator = Pick<typeof runtimeCheckpoint, "register" | "isPaused" | "assertAllowed">;
interface RestoringTaskBridge { snapshot: TaskBridgeCheckpoint; owner: symbol; drain: Promise<void> }
const restoringBridges = new WeakMap<CheckpointCoordinator, Map<string, RestoringTaskBridge>>();
const activeCheckpointRegistrations = new WeakMap<CheckpointCoordinator, Map<string, Disposer>>();

function restorationCache(coordinator: CheckpointCoordinator): Map<string, RestoringTaskBridge> {
  let cache = restoringBridges.get(coordinator);
  if (!cache) { cache = new Map(); restoringBridges.set(coordinator, cache); }
  return cache;
}
function registrationMap(coordinator: CheckpointCoordinator): Map<string, Disposer> {
  let map = activeCheckpointRegistrations.get(coordinator);
  if (!map) { map = new Map(); activeCheckpointRegistrations.set(coordinator, map); }
  return map;
}

export function hostTaskCheckpointId(pluginId: string): string {
  return `host-task-bridge:${encodeURIComponent(pluginId)}`;
}

export function pendingHostTaskPluginIds(checkpoint: RuntimeCheckpoint): string[] {
  const ids: string[] = [];
  for (const [id, value] of Object.entries(checkpoint.participants)) {
    if (!id.startsWith("host-task-bridge:")) continue;
    const pluginId = (value as { pluginId?: unknown } | null)?.pluginId;
    if (typeof pluginId !== "string" || !pluginId || hostTaskCheckpointId(pluginId) !== id) {
      throw new Error("Invalid host task bridge checkpoint participant");
    }
    ids.push(pluginId);
  }
  return ids;
}

// --- cross-bridge coordination (scoped per host document facade) ------------

interface Claim extends TaskWriteScope {
  pluginId: string;
  runId: string;
  requestId: string;
  session: TaskSessionRef | null;
  status: HostTaskStatus;
  sessionProven?: boolean;
  identityMismatch?: boolean;
  cancelRequested?: boolean;
}
const claimsByFacade = new WeakMap<HostTaskFacade, Map<string, Claim>>();
const loadedClaimOwnersByFacade = new WeakMap<HostTaskFacade, Set<string>>();
const kickersByFacade = new WeakMap<HostTaskFacade, Set<() => void>>();

function facadeClaims(facade: HostTaskFacade): Map<string, Claim> {
  let map = claimsByFacade.get(facade);
  if (!map) { map = new Map(); claimsByFacade.set(facade, map); }
  return map;
}
function facadeKickers(facade: HostTaskFacade): Set<() => void> {
  let set = kickersByFacade.get(facade);
  if (!set) { set = new Set(); kickersByFacade.set(facade, set); }
  return set;
}

function loadedClaimOwners(facade: HostTaskFacade): Set<string> {
  let owners = loadedClaimOwnersByFacade.get(facade);
  if (!owners) { owners = new Set(); loadedClaimOwnersByFacade.set(facade, owners); }
  return owners;
}

/** Serializes each plugin's KV traffic across bridge instances (reload overlap). */
const storageChains = new Map<string, Promise<unknown>>();
const chained = <T>(pluginId: string, fn: () => Promise<T>): Promise<T> => {
  const result = (storageChains.get(pluginId) ?? Promise.resolve()).then(fn);
  storageChains.set(pluginId, result.catch(() => undefined));
  return result;
};

export class HostTaskPlanError extends Error {
  constructor(readonly code: HostTaskPlanErrorCode, message: string) { super(message); this.name = "HostTaskPlanError"; }
}
const PLAN_CODES = new Set<HostTaskPlanErrorCode>(["invalid_request", "planner_unavailable", "timeout", "bad_output", "failed", "cancelled"]);
function planError(error: unknown): HostTaskPlanError {
  if (error instanceof HostTaskPlanError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const match = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  if (match && PLAN_CODES.has(match[1] as HostTaskPlanErrorCode)) return new HostTaskPlanError(match[1] as HostTaskPlanErrorCode, match[2]);
  return new HostTaskPlanError("failed", text.slice(0, 1024));
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const label = (value: unknown, max = 256): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const selector = (value: unknown): value is string =>
  typeof value === "string" && !!value && value.length <= 512 && !value.startsWith("-") && !/[\s\u0000-\u001f]/.test(value);
function clip(text: string, limit: number): string {
  const prefix = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}
const refKey = (ref: TaskSessionRef) => `${ref.engine}/${ref.sessionId}`;
const slotId = (projectId: string, slotKey: string) => JSON.stringify([projectId, slotKey]);

export interface HostTaskBridgeDependencies {
  facade?: () => Promise<HostTaskFacade>;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  loadClaims?: () => Promise<unknown>;
  now?: () => number;
  runId?: () => string;
  paused?: () => boolean;
  whenResumed?: () => Promise<void>;
  registerBlocker?: (id: string, read: () => readonly string[]) => () => void;
  checkpoint?: CheckpointCoordinator;
  checkpointReady?: () => Promise<void>;
  resumed?: () => void;
}

export function createHostTaskBridge(pluginId: string, storage: PluginStorageBackend, deps: HostTaskBridgeDependencies):
  HostTasksApi & { dispose: Disposer; ready(): Promise<void> } {
  const now = deps.now ?? Date.now;
  const checkpoint = deps.checkpoint ?? runtimeCheckpoint;
  const paused = deps.paused ?? (() => checkpoint.isPaused() || isRuntimeSubmissionPaused());
  const whenResumed = deps.whenResumed ?? (() => whenRuntimeSubmissionResumed());
  const participantId = hostTaskCheckpointId(pluginId);
  const checkpointOwner = Symbol(participantId);
  let predecessorDrain: Promise<void> = Promise.resolve();
  const entries = new Map<string, Entry>();
  const conversationHolds = new Set<string>();
  const texts = new Map<string, { text: string; truncated: boolean }>();
  const slots = new Map<string, HostTaskSlot>();
  const plans = new Map<string, HostTaskPlanRecord & { fingerprint: string }>();
  const inflightPlans = new Map<string, Promise<HostTaskPlan>>();
  const inflightPlanMeta = new Map<string, { fingerprint: string; startedAt: number }>();
  const nativeStartedPlans = new Set<string>();
  const cancelledPlans = new Set<string>();
  const cancellingPlans = new Map<string, Promise<boolean>>();
  const listeners = new Set<(receipt: HostTaskReceipt) => void>();
  const inFlightStarts = new Set<string>();
  const reservations = new Set<string>();
  const opening = new Set<string>();
  const openFailed = new Set<string>();
  const dirtyTexts = new Set<string>();
  const disposers: Disposer[] = [];
  let facade: HostTaskFacade;
  let init: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let fenced = false;
  let kicking = false;
  let wake = false;
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeWaiting = false;
  let restored = false;
  let initializationFailure: unknown;

  const assertLive = () => { if (disposed) throw new Error("Host task bridge has been disposed"); };
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn);
    chain = result.catch(() => undefined);
    return result;
  };
  const view = (entry: Entry): HostTaskReceipt => {
    const text = entry.forgotten ? undefined : texts.get(entry.receipt.requestId);
    return {
      ...entry.receipt,
      ...(entry.receipt.requestedSelection ? { requestedSelection: { ...entry.receipt.requestedSelection } } : {}),
      ...(entry.receipt.effectiveSelection ? { effectiveSelection: { ...entry.receipt.effectiveSelection } } : {}),
      ...(entry.receipt.session ? { session: { ...entry.receipt.session } } : {}),
      ...(entry.receipt.blockedBy ? { blockedBy: [...entry.receipt.blockedBy] } : {}),
      ...(text ? { text: text.text, ...(text.truncated ? { truncated: true } : {}) } : {}),
    };
  };
  const emit = (entry: Entry) => {
    if (disposed) return;
    conversations.wake();
    const receipt = view(entry);
    for (const listener of [...listeners]) {
      try { listener(receipt); } catch { console.error("[plugins] host task receipt listener failed"); }
    }
  };
  const snapshot = (): Index => structuredClone({ version: 1, entries: [...entries.values()], slots: [...slots.values()] });
  // Writes are captured when enqueued and run in per-plugin order, so a
  // disposed predecessor's last transitions still land before a successor reads.
  const persistIndex = () => {
    if (disposed) return Promise.resolve();
    const value = snapshot();
    return chained(pluginId, async () => {
      await predecessorDrain;
      await storage.set(pluginId, HOST_TASKS_INDEX_KEY, value);
    });
  };
  const flushTexts = () => {
    textTimer = undefined;
    const ids = [...dirtyTexts];
    dirtyTexts.clear();
    for (const id of ids) {
      const value = texts.get(id);
      if (!value) continue;
      const copy = { ...value };
      void chained(pluginId, async () => {
        await predecessorDrain;
        await storage.set(pluginId, textKey(id), copy);
      }).catch(() => { console.error("[plugins] host task output could not be saved"); });
    }
  };
  const scheduleText = (id: string, immediate: boolean) => {
    dirtyTexts.add(id);
    if (immediate) { if (textTimer) clearTimeout(textTimer); flushTexts(); return; }
    textTimer ??= setTimeout(flushTexts, TEXT_FLUSH_MS);
  };
  const release = (entry: Entry) => {
    if (!facade) return;
    facadeClaims(facade).delete(`${pluginId}\u0000${entry.receipt.requestId}`);
  };
  const claim = (entry: Entry) => {
    if (!facade) return;
    facadeClaims(facade).set(`${pluginId}\u0000${entry.receipt.requestId}`, {
      pluginId,
      runId: entry.receipt.runId ?? "",
      requestId: entry.receipt.requestId,
      session: entry.receipt.session ? { ...entry.receipt.session } : null,
      status: entry.receipt.status,
      sessionProven: entry.sessionProven,
      identityMismatch: entry.identityMismatch,
      cancelRequested: entry.cancelRequested,
      workspacePath: entry.receipt.workspacePath,
      writePaths: entry.writePaths,
    });
  };
  const kickAll = () => {
    if (!facade) return;
    for (const fn of [...facadeKickers(facade)]) fn();
  };
  /** Durable transition. A failed write fences the bridge and retains the write lock. */
  const change = async (entry: Entry, patch: Partial<Receipt>, extra?: (entry: Entry) => void) => {
    if (disposed) return;
    entry.receipt = { ...entry.receipt, ...patch, updatedAt: now() };
    extra?.(entry);
    const settled = SETTLED.has(entry.receipt.status);
    if (settled) {
      release(entry);
      entry.pendingTerminal = undefined;
    } else if (HOLDING_LOCKS.has(entry.receipt.status)) {
      claim(entry);
    }
    try { await persistIndex(); }
    catch {
      fenced = true;
      entry.receipt = { ...entry.receipt, status: "unknown", error: "Task ledger update failed; execution will not be replayed", updatedAt: now() };
      claim(entry);
    }
    if (SETTLED.has(entry.receipt.status) && entry.hasText && !entry.forgotten) scheduleText(entry.receipt.requestId, true);
    emit(entry);
    if (SETTLED.has(entry.receipt.status) || entry.receipt.status === "unknown") kickAll();
  };
  const moveSlot = (entry: Entry) => {
    const session = entry.receipt.session;
    if (!session || !entry.sessionProven) return;
    if (entry.coordination || entry.conversationOwner) {
      if (entry.conversationSession && !sameSession(entry.conversationSession, session)) {
        entry.identityMismatch = true;
        entry.receipt = { ...entry.receipt, status: "unknown", error: "Coordinator native identity changed; not rebound" };
        return;
      }
      entry.conversationSession ??= { ...session };
    }
    slots.set(slotId(entry.receipt.projectId, entry.receipt.slotKey), {
      projectId: entry.receipt.projectId, slotKey: entry.receipt.slotKey,
      session: { ...session }, lastRequestId: entry.receipt.requestId, updatedAt: now(),
    });
  };

  // --- restoration & checkpoint ----------------------------------------------

  const validSelection = (value: unknown): value is HostTaskSelection => {
    const v = value as HostTaskSelection | null;
    return !!v && [v.engine, v.model, v.effort, v.providerId].every(selector) &&
      ["claude", "codex"].includes(v.engine);
  };
  const sameSelection = (a: HostTaskSelection, b: HostTaskSelection) =>
    a.engine === b.engine && a.model === b.model && a.effort === b.effort && a.providerId === b.providerId;
  const resolveSelection = async (selection: HostTaskSelection): Promise<HostTaskSelection> => {
    const resolved = await deps.invoke("plugin_task_resolve", { pluginId, selection: { ...selection } });
    if (!validSelection(resolved) || resolved.engine !== selection.engine || resolved.providerId !== selection.providerId) {
      throw new Error("Native task selection resolution is invalid");
    }
    return { ...resolved };
  };
  const resolveTaskImages = async (imageIds: readonly string[]): Promise<string[]> => {
    if (!imageIds.length) return [];
    const resolved = await deps.invoke("plugin_image_resolve", { pluginId, imageIds: [...imageIds] });
    if (
      !Array.isArray(resolved) ||
      resolved.length !== imageIds.length ||
      resolved.some((p) => typeof p !== "string" || !p.trim())
    ) {
      throw new Error("Native task image attachments could not be resolved");
    }
    return resolved.map((p) => p.trim());
  };
  const verifySelection = async (entry: Entry) => {
    if (!entry.receipt.requestedSelection) return;
    try {
      const resolved = await resolveSelection(entry.receipt.requestedSelection);
      if (!entry.receipt.effectiveSelection || !sameSelection(resolved, entry.receipt.effectiveSelection)) {
        throw new Error("Task channel/model mapping changed since acceptance");
      }
    } catch (error) {
      throw new TaskPreSpawnError(`Task selection could not be verified; nothing was sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const validateEntrySelection = (raw: Entry) => {
    const requested = raw.receipt.requestedSelection;
    const effective = raw.receipt.effectiveSelection;
    const launch = raw.launch;
    let fingerprint: unknown;
    try { fingerprint = JSON.parse(raw.fingerprint); } catch { throw new Error("Invalid host task fingerprint"); }
    const extension = Array.isArray(fingerprint) && fingerprint.length > 12 && fingerprint.at(-1) && typeof fingerprint.at(-1) === "object" && !Array.isArray(fingerprint.at(-1))
      ? fingerprint.pop() as { coordination?: unknown; displayText?: unknown; fixedInstructions?: unknown } : undefined;
    validateFixedInstructions(raw.fixedInstructions);
    validateFixedInstructions(extension?.fixedInstructions);
    if ((raw.coordination !== undefined && raw.coordination !== true) || (raw.conversationOwner !== undefined && raw.conversationOwner !== true) ||
      (raw.conversationHolding !== undefined && typeof raw.conversationHolding !== "boolean") ||
      extension?.coordination !== raw.coordination || (raw.coordination && raw.sessionMode !== "new") ||
      (extension && Object.keys(extension).some(k => !["coordination", "displayText", "fixedInstructions"].includes(k))) ||
      !sameFixedInstructions(extension?.fixedInstructions, raw.fixedInstructions) ||
      extension?.displayText !== raw.displayText || (raw.displayText !== undefined && (typeof raw.displayText !== "string" || raw.displayText.length > MAX_PROMPT)) ||
      (raw.userRow && (!Number.isSafeInteger(raw.userRow.seq) || typeof raw.userRow.text !== "string" || raw.userRow.runId !== raw.receipt.runId || (raw.userRow.ts !== null && typeof raw.userRow.ts !== "string"))) ||
      (raw.conversationSession && (!raw.receipt.session || !sameSession(raw.conversationSession, raw.receipt.session)))) throw new Error("Invalid exclusive coordinator record");
    if (!Array.isArray(fingerprint) || ![12, 13, 14].includes(fingerprint.length) ||
      !launch || typeof launch !== "object" || !selector(raw.newEngine) ||
      (raw.requestedEngine !== null && !selector(raw.requestedEngine)) ||
      !["auto", "new"].includes(raw.sessionMode) ||
      [launch.model, launch.effort, launch.providerId].some((v) => v !== undefined && !selector(v)) ||
      [launch.defaultModel, launch.defaultEffort, launch.defaultProvider].some((v) => v !== undefined && v !== null && !selector(v))) {
      throw new Error("Invalid host task launch record");
    }
    const hasImages = raw.images !== undefined;
    if (
      hasImages &&
      (!Array.isArray(raw.images) ||
        raw.images.length < 1 ||
        raw.images.length > 8 ||
        raw.images.some((id) => !validId(id)))
    ) {
      throw new Error("Invalid host task images record");
    }
    const fpHasPinned = typeof fingerprint[12] === "string";
    const fpImages = Array.isArray(fingerprint[12])
      ? fingerprint[12]
      : fpHasPinned && Array.isArray(fingerprint[13])
        ? fingerprint[13]
        : undefined;
    const expectedLen = 12 + (fpHasPinned ? 1 : 0) + (fpImages !== undefined ? 1 : 0);
    if (
      fingerprint.length !== expectedLen ||
      hasImages !== (fpImages !== undefined) ||
      (hasImages && (!fpImages!.every(validId) || !sameList(raw.images, fpImages!)))
    ) {
      throw new Error("Invalid host task launch record");
    }
    if (requested !== undefined || effective !== undefined || launch.providerId !== undefined || fpHasPinned) {
      if (!validSelection(requested) || !validSelection(effective) ||
        requested.engine !== effective.engine || requested.providerId !== effective.providerId ||
        raw.newEngine !== effective.engine || raw.requestedEngine !== requested.engine ||
        (raw.execEngine !== undefined && raw.execEngine !== effective.engine) ||
        (raw.receipt.session != null && raw.receipt.session.engine !== effective.engine) ||
        launch.model !== effective.model || launch.effort !== effective.effort || launch.providerId !== effective.providerId ||
        !fpHasPinned || fingerprint[9] !== requested.engine || fingerprint[10] !== requested.model ||
        fingerprint[11] !== requested.effort || fingerprint[12] !== requested.providerId) {
        throw new Error("Invalid pinned host task selection record");
      }
    } else if ((fingerprint[9] ?? null) !== raw.requestedEngine ||
      (fingerprint[10] ?? undefined) !== launch.model || (fingerprint[11] ?? undefined) !== launch.effort) {
      throw new Error("Host task launch differs from accepted submission");
    }
  };

  const loadIndex = (value: unknown) => {
    const index = value as Index | null;
    if (!index) return;
    if (index.version !== 1 || !Array.isArray(index.entries) || !Array.isArray(index.slots) || index.entries.length > MAX_ENTRIES) {
      throw new Error("Invalid host task ledger");
    }
    for (const raw of index.entries) {
      const r = raw?.receipt;
      if (!r || !validId(r.requestId) || entries.has(r.requestId) || !STATUSES.has(r.status) || typeof raw.prompt !== "string" ||
        typeof raw.fingerprint !== "string" || typeof r.workspacePath !== "string" || !Number.isInteger(raw.lastSeq)) {
        throw new Error("Invalid host task ledger");
      }
      validateEntrySelection(raw);
      entries.set(r.requestId, structuredClone(raw));
      if (raw.conversationHolding === true) conversationHolds.add(r.requestId);
    }
    for (const slot of index.slots) {
      if (slot && typeof slot.projectId === "string" && typeof slot.slotKey === "string" && slot.session &&
        plausibleSessionId(slot.session.engine, slot.session.sessionId)) {
        slots.set(slotId(slot.projectId, slot.slotKey), structuredClone(slot));
      }
    }
  };

  const loadPlanStore = (value: unknown) => {
    const store = value as PlanStore | null;
    if (!store) return;
    if (store.version !== 1 || !Array.isArray(store.plans) || store.plans.length > MAX_PLANS) {
      throw new Error("Invalid host task plan ledger");
    }
    for (const record of store.plans) {
      if (!record || !validId(record.requestId) || typeof record.fingerprint !== "string") continue;
      plans.set(record.requestId, record.status === "running"
        ? { ...record, status: "failed", error: { code: "failed", message: "Planner stopped when the host reloaded" }, updatedAt: now() }
        : structuredClone(record));
    }
  };

  const settleFromNativeProof = (entry: Entry): Partial<Receipt> | null => {
    if (entry.identityMismatch || !entry.receipt.runId) return null;
    const settled = facade.settledRun?.(entry.receipt.runId, entry.receipt.session);
    if (!settled) return null;
    if (!entry.sessionProven && settled.status === "completed" && !entry.cancelRequested) return null;
    if (settled.status === "failed") {
      return { status: "failed", error: settled.error ?? "Native engine failed" };
    }
    if (settled.status === "cancelled" || entry.cancelRequested) {
      return {
        status: "cancelled",
        error: entry.cancelRequested ? "Cancelled by the requester" : (settled.error ?? "Original GUI turn was interrupted"),
      };
    }
    return { status: "completed", error: undefined };
  };

  const reconcileRestored = () => {
    // Sync this plugin's claims in the shared facade table to the authoritative ledger.
    for (const key of [...facadeClaims(facade).keys()]) {
      if (key.startsWith(`${pluginId}\u0000`)) facadeClaims(facade).delete(key);
    }
    const changed: Entry[] = [];
    for (const entry of entries.values()) {
      if (entry.conversationHolding) {
        facadeClaims(facade).set(`${pluginId}\u0000conversation:${entry.receipt.requestId}`, {
          pluginId, requestId: entry.receipt.requestId, runId: "", session: entry.receipt.session ?? null,
          status: "unknown", sessionProven: entry.sessionProven, workspacePath: entry.receipt.workspacePath, writePaths: entry.writePaths,
        });
      }
      if (SETTLED.has(entry.receipt.status)) {
        release(entry);
        continue;
      }
      if (!HOLDING_LOCKS.has(entry.receipt.status)) continue;
      if (entry.identityMismatch) {
        claim(entry);
        continue;
      }
      const live = entry.receipt.runId ? facade.liveRun(entry.receipt.runId) : null;
      const engine = entry.execEngine ?? entry.receipt.session?.engine ?? entry.newEngine;
      if (live) {
        entry.ack = true;
        if (!live.startsWith("new:")) {
          const sessionId = live.slice(engine.length + 1);
          if (!live.startsWith(`${engine}/`) || !plausibleSessionId(engine, sessionId) ||
            (entry.receipt.session && entry.receipt.session.sessionId !== sessionId)) {
            entry.identityMismatch = true;
            entry.receipt = { ...entry.receipt, status: "unknown", updatedAt: now(), error: "Restored task routes to a different chat; not rebound" };
            claim(entry);
            changed.push(entry);
            continue;
          }
          if (!entry.receipt.session) entry.receipt = { ...entry.receipt, session: { engine, sessionId, workspacePath: entry.receipt.workspacePath } };
          entry.sessionProven = true;
          moveSlot(entry);
        }
        if (entry.receipt.status === "unknown" || entry.receipt.status === "starting") {
          entry.receipt = { ...entry.receipt, status: "executing", error: undefined, updatedAt: now() };
          changed.push(entry);
        }
        if (entry.cancelRequested && entry.receipt.runId) {
          void facade.interrupt(entry.receipt.runId).catch(() => false);
        }
        claim(entry);
        continue;
      }
      const settledPatch = settleFromNativeProof(entry);
      if (settledPatch) {
        entry.receipt = { ...entry.receipt, ...settledPatch, updatedAt: now() };
        entry.pendingTerminal = undefined;
        moveSlot(entry);
        release(entry);
        changed.push(entry);
        continue;
      }
      if (entry.receipt.status !== "unknown") {
        entry.receipt = { ...entry.receipt, status: "unknown", updatedAt: now(),
          error: "Task had started before the host reloaded; its outcome could not be confirmed and it was not replayed" };
        changed.push(entry);
      }
      // Unknown is not proof of termination: keep holding the write lock.
      claim(entry);
    }
    return changed;
  };

  function captureCheckpoint(): TaskBridgeCheckpoint {
    return cloneCheckpointValue({
      version: 1,
      pluginId,
      index: snapshot(),
      plans: { version: 1, plans: [...plans.values()] },
      texts: [...texts.entries()],
      fenced,
      conversations: conversations.capture(),
    } satisfies TaskBridgeCheckpoint);
  }

  function restoreCheckpoint(value: unknown) {
    if (inFlightStarts.size || disposed) throw new Error("Cannot replace a live host task bridge");
    const cut = cloneCheckpointValue(value) as TaskBridgeCheckpoint;
    if (!cut || cut.version !== 1 || cut.pluginId !== pluginId || typeof cut.fenced !== "boolean" ||
      !Array.isArray(cut.texts)) {
      throw new Error("Invalid host task bridge checkpoint");
    }
    entries.clear();
    conversationHolds.clear();
    slots.clear();
    plans.clear();
    texts.clear();
    loadIndex(cut.index);
    loadPlanStore(cut.plans);
    if (cut.conversations) conversations.restore(cut.conversations);
    for (const pair of cut.texts) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" ||
        !pair[1] || typeof pair[1].text !== "string") {
        throw new Error("Invalid host task bridge checkpoint text");
      }
      texts.set(pair[0], { text: clip(pair[1].text, MAX_TEXT), truncated: pair[1].truncated === true });
    }
    fenced = cut.fenced;
    restored = true;
    const previous = restorationCache(checkpoint).get(participantId);
    predecessorDrain = previous?.drain ?? Promise.resolve();
    restorationCache(checkpoint).set(participantId, { snapshot: captureCheckpoint(), owner: checkpointOwner, drain: predecessorDrain });
  }

  // Runs on the serial chain: native events that arrive while the ledger loads
  // queue behind it instead of meeting an empty ledger.
  const ensure = () => init ??= serial(async () => {
    try {
      assertLive();
      facade = await (deps.facade ?? desktopTaskFacade)();
      assertLive();
      await facade.ready();
      if (deps.loadClaims) {
        const savedClaims = decodePersistedTaskClaims(await deps.loadClaims());
        assertLive();
        for (const saved of savedClaims) {
          if (saved.pluginId === pluginId || loadedClaimOwners(facade).has(saved.pluginId)) continue;
          const key = `${saved.pluginId}\u0000${saved.requestId}`;
          if (!facadeClaims(facade).has(key)) facadeClaims(facade).set(key, saved);
        }
      }
      const off = await facade.listen((events) => { void serial(async () => { if (!disposed) await onEvents(events); }); });
      if (disposed) { off(); throw new Error("Host task bridge has been disposed"); }
      disposers.push(off, facade.subscribe(() => kick()));
      if (!restored) {
        const [index, planStore] = await chained(pluginId, () => Promise.all([
          storage.get(pluginId, HOST_TASKS_INDEX_KEY), storage.get(pluginId, HOST_TASKS_PLANS_KEY),
        ]));
        assertLive();
        loadIndex(index);
        loadPlanStore(planStore);
        for (const entry of entries.values()) {
          if (!entry.hasText || entry.forgotten) continue;
          const value = await chained(pluginId, () => storage.get(pluginId, textKey(entry.receipt.requestId))) as { text?: unknown; truncated?: unknown } | null;
          if (value && typeof value.text === "string") texts.set(entry.receipt.requestId, { text: clip(value.text, MAX_TEXT), truncated: value.truncated === true });
        }
        assertLive();
        const changed = reconcileRestored();
        if (changed.length || index) await persistIndex();
      } else {
        const changed = reconcileRestored();
        if (changed.length) await persistIndex();
      }
      facadeKickers(facade).add(kick);
      loadedClaimOwners(facade).add(pluginId);
      void conversations.ready().then(() => conversations.wake()).catch(() => { fenced = true; });
      disposers.push(() => facadeKickers(facade).delete(kick));
      kick();
    } catch (error) {
      initializationFailure = error;
      throw error;
    }
  });

  async function ready() {
    await ensure();
    for (;;) { const observed = chain; await observed; assertLive(); if (observed === chain) break; }
  }

  // --- dispatch ----------------------------------------------------------------

  const blockersFor = (entry: Entry): string[] => {
    const scope: TaskWriteScope = { workspacePath: entry.receipt.workspacePath, writePaths: entry.writePaths };
    const blockers: string[] = [];
    let earlier = true;
    for (const other of entries.values()) {
      if (other === entry) { earlier = false; continue; }
      if (conversationHolds.has(other.receipt.requestId) && other.receipt.projectId === entry.receipt.projectId && other.receipt.slotKey === entry.receipt.slotKey) {
        blockers.push(other.receipt.requestId); continue;
      }
      // Earlier requests keep acceptance order when writes conflict; later ones
      // block once holding locks (active or unknown). Same-slot disjoint tasks
      // do not block here so they can run in parallel sessions.
      if (!conversationHolds.has(other.receipt.requestId) && (SETTLED.has(other.receipt.status) || (!earlier && !HOLDING_LOCKS.has(other.receipt.status)))) continue;
      if (taskScopesConflict(scope, { workspacePath: other.receipt.workspacePath, writePaths: other.writePaths })) {
        blockers.push(other.receipt.requestId);
      }
    }
    for (const [key, other] of facadeClaims(facade)) {
      if (other.pluginId === pluginId) continue; // own requests are covered above
      if (!other.identityMismatch && other.runId && !facade.liveRun(other.runId)) {
        const settled = facade.settledRun?.(other.runId, other.session);
        if (settled && (other.sessionProven || settled.status !== "completed" || other.cancelRequested)) {
          facadeClaims(facade).delete(key);
          continue;
        }
      }
      if (taskScopesConflict(scope, other)) blockers.push(other.requestId);
    }
    return blockers;
  };

  const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
    (a?.length ?? 0) === b.length && b.every((value, i) => a?.[i] === value);

  function sameSession(a: TaskSessionRef, b: TaskSessionRef) {
    return a.engine === b.engine && a.sessionId === b.sessionId && sameTaskPath(a.workspacePath, b.workspacePath);
  }
  const exclusiveOwner = (ref: TaskSessionRef, except?: Entry) => [...entries.values()].find(other => other !== except &&
    (other.coordination || other.conversationOwner) && (other.conversationSession ?? other.receipt.session) && sameSession((other.conversationSession ?? other.receipt.session)!, ref));

  async function reconcileUnknownEntries() {
    for (const entry of [...entries.values()]) {
      if (disposed || fenced) break;
      if (entry.receipt.status !== "unknown" || entry.identityMismatch || !entry.receipt.runId) continue;
      if (facade.liveRun(entry.receipt.runId)) continue;
      const settledPatch = settleFromNativeProof(entry);
      if (settledPatch) {
        await change(entry, settledPatch, moveSlot);
      }
    }
  }

  function kick() {
    // Before initialization, ensure() itself kicks once the ledger is loaded.
    if (disposed || fenced || !init) return;
    // Foreign scope claims may settle without a new chat-store event (for
    // example a pre-spawn refusal). Wake the attached durable inbox as well.
    conversations.wake();
    if (paused()) {
      if (!resumeWaiting) {
        resumeWaiting = true;
        void whenResumed().then(() => { resumeWaiting = false; kick(); }, () => { resumeWaiting = false; });
      }
      return;
    }
    if (kicking) { wake = true; return; }
    kicking = true;
    void serial(async () => {
      await ensure();
      await reconcileUnknownEntries();
      for (const entry of [...entries.values()]) {
        if (disposed || fenced || paused()) break;
        if (entry.receipt.status !== "queued") continue;
        const blockers = blockersFor(entry);
        if (blockers.length) {
          if (!sameList(entry.receipt.blockedBy, blockers)) await change(entry, { blockedBy: blockers });
          continue;
        }
        await dispatch(entry);
      }
    }).catch((error: unknown) => {
      fenced = true;
      console.error("[plugins] host task dispatch stopped", error);
    }).finally(() => {
      kicking = false;
      if (wake) { wake = false; kick(); }
    });
  }

  async function applyRolloverHandoff(entry: Entry, slot: HostTaskSlot): Promise<boolean> {
    if (entry.hasExplicitHandoff || entry.rolloverHandoffApplied) return true;
    const fallback = `Handoff source: ${slot.session.engine}:${slot.session.sessionId} (${slot.session.workspacePath}); previous request ${slot.lastRequestId}.\nThe prior summary is unavailable or does not fit. Consult this original source on demand; do not assume its contents or verification.`;
    let handoff = fallback;
    try {
      const prevEntry = entries.get(slot.lastRequestId);
      handoff = (prevEntry && !prevEntry.forgotten && texts.get(slot.lastRequestId)?.text
        ? await handoffNote({ handoffFrom: { requestId: slot.lastRequestId } } as HostTaskSubmission, entry.receipt.workspacePath)
        : await handoffNote({ handoffFrom: { session: slot.session } } as HostTaskSubmission, entry.receipt.workspacePath)) || fallback;
    } catch {
      // Keep an explicit original-source link when history cannot be read.
    }
    if (entry.prompt.length + 2 + handoff.length > 131_072) handoff = fallback;
    if (entry.prompt.length + 2 + handoff.length > 131_072) {
      await change(entry, { status: "failed", error: "Task and required handoff exceed the prompt budget; no conversation was started" });
      return false;
    }
    entry.prompt = `${entry.prompt}\n\n${handoff}`;
    entry.rolloverHandoffApplied = true;
    return true;
  }

  async function dispatch(entry: Entry) {
    const requestId = entry.receipt.requestId;
    const slot = slots.get(slotId(entry.receipt.projectId, entry.receipt.slotKey));
    const canConsiderSlot =
      entry.sessionMode === "auto" &&
      !!slot &&
      !conversations.attachedTo(slot.session) &&
      !exclusiveOwner(slot.session, entry) &&
      !openFailed.has(requestId) &&
      sameTaskPath(slot.session.workspacePath, entry.receipt.workspacePath) &&
      (!entry.requestedEngine || entry.requestedEngine === slot.session.engine) &&
      facade.known(slot.session) &&
      facade.engines().some((e) => e.id === slot.session.engine && e.available && e.enabled);

    let route: { decision: "reused"; target: TaskSessionRef } | { decision: "new"; engine: string; rolloverFrom?: HostTaskSlot };
    if (canConsiderSlot && slot) {
      const status = facade.inspect(slot.session);
      if (status === null) {
        if (!opening.has(requestId)) {
          opening.add(requestId);
          const target = { ...slot.session };
          void facade.openBackground(target).then(() => { if (facade.inspect(target) === null) openFailed.add(requestId); },
            () => { openFailed.add(requestId); }).finally(() => { opening.delete(requestId); kick(); });
        }
        return;
      }
      const explicit = entry.launch.model !== undefined || entry.launch.effort !== undefined || entry.launch.providerId !== undefined;
      if ((explicit && facade.selectionMatches?.(slot.session, entry.launch) !== true) || facade.sessionShouldRollover?.(slot.session) === true) {
        route = { decision: "new", engine: entry.newEngine, rolloverFrom: slot };
      } else if (status === "idle" && !reservations.has(refKey(slot.session))) {
        route = { decision: "reused", target: { ...slot.session } };
      } else {
        // When the same logical slot (or its chat) is currently executing a
        // known disjoint task, spin up a parallel background chat instead of
        // serializing behind the slot.
        const slotBusyWithDisjointTask =
          entry.writePaths !== null &&
          [...entries.values()].some(
            (other) =>
              other !== entry &&
              ACTIVE.has(other.receipt.status) &&
              other.writePaths !== null &&
              ((other.receipt.projectId === entry.receipt.projectId && other.receipt.slotKey === entry.receipt.slotKey) ||
                (other.receipt.session && refKey(other.receipt.session) === refKey(slot.session))),
          );
        if (slotBusyWithDisjointTask) {
          route = { decision: "new", engine: entry.newEngine };
        } else {
          if (entry.receipt.blockedBy?.length) await change(entry, { blockedBy: undefined });
          return;
        }
      }
    } else {
      route = { decision: "new", engine: entry.newEngine };
    }

    let reservation: string;
    if (route.decision === "reused") {
      if (entry.receipt.blockedBy?.length) await change(entry, { blockedBy: undefined });
      reservation = refKey(route.target);
      if (reservations.has(reservation)) return;
    } else {
      reservation = `new:${route.engine}:${entry.receipt.workspacePath}`;
      const draftBusyByTask =
        reservations.has(reservation) ||
        [...entries.values()].some(
          (other) =>
            other !== entry &&
            ACTIVE.has(other.receipt.status) &&
            other.receipt.sessionDecision === "new" &&
            !other.receipt.session &&
            (other.execEngine ?? other.newEngine) === route.engine &&
            sameTaskPath(other.receipt.workspacePath, entry.receipt.workspacePath),
        );
      if (draftBusyByTask) {
        if (entry.receipt.blockedBy?.length) await change(entry, { blockedBy: undefined });
        return;
      }
      if (
        !facade.openDraft(route.engine, entry.receipt.workspacePath, entry.launch) ||
        !facade.draftReady(route.engine, entry.receipt.workspacePath, entry.launch)
      ) {
        if (!sameList(entry.receipt.blockedBy, ["user-draft"])) {
          await change(entry, { blockedBy: ["user-draft"] });
        }
        return;
      }
      if (route.rolloverFrom) {
        if (!await applyRolloverHandoff(entry, route.rolloverFrom)) return;
      }
    }

    reservations.add(reservation);
    const runId = deps.runId?.() ?? `run-${newId()}`;
    inFlightStarts.add(runId);
    const target = route.decision === "reused" ? route.target : null;
    const engine = route.decision === "reused" ? route.target.engine : route.engine;
    let sent = false;
    try {
      await change(entry, { status: "starting", runId, sessionDecision: route.decision, session: target, blockedBy: undefined }, (e) => {
        e.execEngine = engine; e.lastSeq = -1; e.ack = undefined; e.sessionProven = undefined; e.identityMismatch = undefined;
        claim(e);
      });
      if (entry.receipt.status !== "starting" || disposed || fenced) return;
      const revert = async (blockedBy?: readonly string[]) => {
        await change(entry, { status: "queued", runId: null, sessionDecision: null, session: null, blockedBy: blockedBy ? [...blockedBy] : undefined }, (e) => {
          e.execEngine = undefined;
          release(e);
        });
      };
      if (paused()) { await revert(); return; }
      const ready = target
        ? facade.inspect(target) === "idle"
        : facade.draftReady(engine, entry.receipt.workspacePath, entry.launch);
      if (!ready) {
        if (target) await change(entry, { status: "failed", error: "Exact host task chat is no longer idle; nothing was sent" });
        else await revert(["user-draft"]);
        return;
      }
      const assertPendingSend = () => {
        if (disposed || fenced || paused()) throw new TaskPreSpawnError("Task owner is no longer available; nothing was sent");
        if (entry.cancelRequested || entry.receipt.status !== "starting" || entry.receipt.runId !== runId) {
          throw new TaskPreSpawnError("Task was cancelled or its delivery changed; nothing was sent");
        }
        if (target && exclusiveOwner(target, entry)) throw new TaskPreSpawnError("Exact session is reserved by an exclusive coordinator");
      };
      let resolvedImagePaths: string[] | undefined;
      const verifyEngineImageSupport = () => {
        if (!entry.images?.length) return;
        const liveEngine = facade.engines().find((e) => e.id === engine && e.available && e.enabled);
        if (!liveEngine || liveEngine.supportsImages !== true) {
          throw new TaskPreSpawnError(`Engine ${engine} does not support image attachments; nothing was sent`);
        }
      };
      const resolveImagesForSend = async () => {
        if (!entry.images?.length) return;
        try {
          resolvedImagePaths = await resolveTaskImages(entry.images);
        } catch (error) {
          throw new TaskPreSpawnError(`Task images could not be resolved; nothing was sent: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      const beforeSend = async () => {
        assertPendingSend();
        verifyEngineImageSupport();
        await verifySelection(entry);
        assertPendingSend();
        await resolveImagesForSend();
        verifyEngineImageSupport();
        // Both native resolution and the chat's asynchronous preparation can
        // yield to cancellation, teardown or runtime fencing. Check the same
        // request again at the last synchronous boundary before native delivery.
        assertPendingSend();
      };
      try { await beforeSend(); } catch (error) {
        await change(entry, { status: entry.cancelRequested ? "cancelled" : "failed", error: (error as Error).message });
        return;
      }
      sent = true;
      const onUserRow = entry.displayText === undefined ? undefined : async (row: HostUserRowIdentity) => {
        assertPendingSend();
        if (row.runId !== runId) throw new TaskPreSpawnError("Native user row belongs to another run");
        entry.userRow = structuredClone(row); await persistIndex(); assertPendingSend();
      };
      const send = target
        ? (onUserRow ? facade.sendExisting(target, entry.prompt, runId, entry.launch, beforeSend, resolvedImagePaths, onUserRow) : resolvedImagePaths?.length
            ? facade.sendExisting(target, entry.prompt, runId, entry.launch, beforeSend, resolvedImagePaths)
            : facade.sendExisting(target, entry.prompt, runId, entry.launch, beforeSend))
        : (onUserRow ? facade.sendNew(engine, entry.receipt.workspacePath, entry.prompt, runId, entry.launch, beforeSend, resolvedImagePaths, onUserRow) : resolvedImagePaths?.length
            ? facade.sendNew(engine, entry.receipt.workspacePath, entry.prompt, runId, entry.launch, beforeSend, resolvedImagePaths)
            : facade.sendNew(engine, entry.receipt.workspacePath, entry.prompt, runId, entry.launch, beforeSend));
      void send.then((ack) => serial(() => onAck(entry, runId, ack)), (error: unknown) => serial(() => onSendError(entry, runId, error)))
        .finally(() => { inFlightStarts.delete(runId); reservations.delete(reservation); kick(); });
    } finally {
      if (!sent) { inFlightStarts.delete(runId); reservations.delete(reservation); }
    }
  }

  async function onAck(entry: Entry, runId: string, ack: TaskAck) {
    if (disposed || entry.receipt.runId !== runId || SETTLED.has(entry.receipt.status)) return;
    const engine = entry.execEngine!;
    const target = entry.receipt.session;
    if (ack.runId !== runId || (ack.sessionId !== null && (!plausibleSessionId(engine, ack.sessionId) ||
      (entry.receipt.sessionDecision === "reused" && target && ack.sessionId !== target.sessionId) ||
      (entry.receipt.sessionDecision === "new" && target && ack.sessionId !== target.sessionId)))) {
      await change(
        entry,
        { status: "unknown", error: `Native send ACK identity mismatch: ${clip(JSON.stringify({ runId: ack.runId, sessionId: ack.sessionId }), 512)}` },
        (e) => { e.identityMismatch = true; },
      );
      return;
    }
    entry.ack = true;
    let patch: Partial<Receipt> = {};
    if (ack.sessionId) {
      entry.sessionProven = true;
      if (!target) patch = { session: { engine, sessionId: ack.sessionId, workspacePath: entry.receipt.workspacePath } };
    }
    const terminal = entry.pendingTerminal;
    if (terminal) {
      await change(entry, entry.sessionProven ? { ...patch, ...terminal } :
        { ...patch, status: "unknown", error: "Turn finished without native session evidence" }, moveSlot);
      return;
    }
    await change(entry, { ...patch, status: entry.receipt.status === "starting" ? "executing" : entry.receipt.status }, moveSlot);
    if (entry.cancelRequested) await facade.interrupt(runId).catch(() => false);
  }

  async function onSendError(entry: Entry, runId: string, error: unknown) {
    if (disposed || entry.receipt.runId !== runId || SETTLED.has(entry.receipt.status)) return;
    if (error instanceof TaskPreSpawnError && !entry.ack) {
      if (entry.cancelRequested) {
        await change(entry, { status: "cancelled", error: "Cancelled before delivery" });
      } else {
        await change(entry, { status: "failed", error: `Task was not sent: ${error.message}` });
      }
      return;
    }
    await change(entry, { status: "unknown", error: "Native send failed without a conclusive acknowledgement; not replayed" });
  }

  async function onEvents(events: EngineEventPayload[]) {
    const changed = new Set<Entry>();
    const texted = new Set<Entry>();
    const update = (entry: Entry, patch: Partial<Receipt>) => { entry.receipt = { ...entry.receipt, ...patch, updatedAt: now() }; changed.add(entry); };
    const settle = (entry: Entry, result: { status: HostTaskStatus; error?: string }) => {
      if (entry.ack && (entry.sessionProven || result.status !== "completed" || entry.cancelRequested)) {
        update(entry, result);
      } else if (entry.ack) {
        update(entry, { status: "unknown", error: "Turn finished without native session evidence" });
      } else {
        entry.pendingTerminal = result;
      }
    };
    const interrupted = (entry: Entry) => entry.cancelRequested
      ? { status: "cancelled" as const, error: "Cancelled by the requester" }
      : { status: "failed" as const, error: "Original GUI turn was interrupted" };
    for (const event of events) {
      if (!event.runId) continue;
      const entry = [...entries.values()].find((e) => e.receipt.runId === event.runId);
      if (
        !entry ||
        !HOLDING_LOCKS.has(entry.receipt.status) ||
        entry.identityMismatch ||
        entry.pendingTerminal ||
        event.engine !== entry.execEngine ||
        !Number.isInteger(event.seq) ||
        event.seq <= entry.lastSeq
      ) {
        continue;
      }
      const session = entry.receipt.session;
      const announced = event.kind === "session" ? event.data : event.sessionId;
      if (announced !== null && announced !== undefined) {
        if (!plausibleSessionId(event.engine, announced) || (session && announced !== session.sessionId)) {
          entry.identityMismatch = true;
          update(entry, { status: "unknown", error: "Native session identity differs from the task's chat; not rebound" });
          continue;
        }
        if (!session) update(entry, { session: { engine: event.engine, sessionId: announced, workspacePath: entry.receipt.workspacePath } });
        if (!entry.sessionProven) { entry.sessionProven = true; changed.add(entry); }
      }
      entry.ack = true;
      entry.lastSeq = event.seq;
      if ((entry.receipt.status === "starting" || entry.receipt.status === "unknown") && entry.ack) {
        update(entry, { status: "executing", error: undefined });
      }
      const data = event.data;
      switch (event.kind as string) {
        case "delta":
          if (typeof data === "string") { append(entry, data); texted.add(entry); }
          break;
        case "message": {
          const message = data as { role?: string; text?: string } | null;
          if (message?.role === "assistant" && typeof message.text === "string") { append(entry, message.text); texted.add(entry); }
          break;
        }
        case "question": case "permission_denied":
          update(entry, { status: "awaiting_permission" }); break;
        case "plan_review": {
          const status = (data as { status?: string } | null)?.status;
          if (status === "awaiting_review" || status === "deferred" || status === "submitting") update(entry, { status: "awaiting_permission" });
          else if (status === "approved") update(entry, { status: "executing" });
          break;
        }
        case "question_settled":
          update(entry, { status: "executing" }); break;
        case "error":
          settle(entry, { status: "failed", error: typeof data === "string" ? clip(data, 1024) : "Native engine failed" }); changed.add(entry); break;
        case "turn_complete":
          if ((data as { interrupted?: unknown } | null)?.interrupted === true) { settle(entry, interrupted(entry)); changed.add(entry); }
          break;
        case "done": {
          const ref = entry.receipt.session;
          settle(entry, ref && facade.wasInterrupted(ref) ? interrupted(entry) : { status: "completed", error: undefined });
          changed.add(entry);
          break;
        }
      }
    }
    for (const entry of texted) scheduleText(entry.receipt.requestId, false);
    if (!changed.size) { for (const entry of texted) emit(entry); return; }
    for (const entry of changed) {
      moveSlot(entry);
      if (SETTLED.has(entry.receipt.status)) {
        release(entry);
        entry.pendingTerminal = undefined;
      } else if (HOLDING_LOCKS.has(entry.receipt.status)) {
        claim(entry);
      }
    }
    try { await persistIndex(); }
    catch {
      fenced = true;
      for (const entry of changed) {
        entry.receipt = { ...entry.receipt, status: "unknown", error: "Task ledger update failed; execution will not be replayed", updatedAt: now() };
        claim(entry);
      }
    }
    for (const entry of new Set([...changed, ...texted])) {
      if (SETTLED.has(entry.receipt.status) && entry.hasText && !entry.forgotten) scheduleText(entry.receipt.requestId, true);
      emit(entry);
    }
    if ([...changed].some((e) => SETTLED.has(e.receipt.status) || e.receipt.status === "unknown")) kickAll();
  }

  function append(entry: Entry, chunk: string) {
    if (entry.forgotten) return;
    const id = entry.receipt.requestId;
    const previous = texts.get(id) ?? { text: "", truncated: false };
    if (previous.truncated) return;
    const combined = previous.text + chunk;
    texts.set(id, { text: clip(combined, MAX_TEXT), truncated: combined.length > MAX_TEXT });
    if (!entry.hasText) entry.hasText = true;
  }

  // --- submission ------------------------------------------------------------

  async function handoffNote(request: HostTaskSubmission, workspacePath: string): Promise<string> {
    const from = request.handoffFrom;
    if (!from) return "";
    if ("requestId" in from) {
      const previous = entries.get(from.requestId);
      if (!previous) throw new Error("handoffFrom.requestId is not a task of this plugin");
      const text = texts.get(from.requestId)?.text ?? "";
      const where = previous.receipt.session ? `${previous.receipt.session.engine}:${previous.receipt.session.sessionId} in ${previous.receipt.session.workspacePath}` : "no chat yet";
      const body = text ? clip(text.slice(-MAX_HANDOFF), MAX_HANDOFF) : "(no recorded output)";
      return `Handoff from task request ${from.requestId} (${previous.receipt.status}; ${where}). Its recorded output, last ${MAX_HANDOFF} characters at most:\n${body}`;
    }
    if (!("session" in from) || !from.session) throw new Error("Invalid handoffFrom");
    const excerptValue = await excerpt({ ...from.session, maxChars: MAX_HANDOFF, limit: 20 });
    const lines = excerptValue.messages.map((m) => `${m.role}: ${m.text}`).join("\n\n");
    void workspacePath;
    return `Handoff from chat ${from.session.engine}:${from.session.sessionId} in ${from.session.workspacePath} (recent excerpt${excerptValue.truncated ? ", truncated" : ""}; open that chat for full history):\n${lines || "(no text)"}`;
  }

  function composePrompt(request: HostTaskSubmission, workspacePath: string, writePaths: string[] | null, handoff: string): string {
    const scope = writePaths === null ? "not declared — treat the whole workspace as in scope and coordinate before broad changes"
      : writePaths.length === 0 ? "read-only — do not modify files" : writePaths.join(", ");
    const userPrompt = request.prompt.trimEnd() || "(See attached image(s))";
    const lines = [
      userPrompt, "", "---",
      `[CC GUI task · request ${request.requestId} · task ${request.taskId}]`,
      `Execution workspace: ${workspacePath}`,
      `Declared write scope: ${scope}. This is a coordination declaration, not an OS sandbox; do not write outside it.`,
    ];
    if (request.contextRefs?.length) lines.push("References to consult on demand (not expanded here):", ...request.contextRefs.map((r) => `- ${r}`));
    if (handoff) lines.push("", handoff);
    return lines.join("\n");
  }

  function validateSubmission(request: HostTaskSubmission) {
    validateFixedInstructions(request?.fixedInstructions);
    if (request?.fixedInstructions && (!request.engine || !supportsFixedInstructions(request.engine))) throw new Error("Fixed instructions require an explicit supported engine");
    if (!request || !validId(request.requestId)) throw new Error("Invalid task requestId ([A-Za-z0-9._:-]{1,128})");
    if (!label(request.taskId) || !label(request.slotKey) || !label(request.projectId)) throw new Error("taskId, slotKey and projectId must be non-empty single-line text up to 256 characters");
    if (
      request.images !== undefined &&
      (!Array.isArray(request.images) ||
        request.images.length > 8 ||
        request.images.some((id) => !validId(id)))
    ) {
      throw new Error("Task images must be at most 8 valid attachment IDs");
    }
    const hasImages = Array.isArray(request.images) && request.images.length > 0;
    if (typeof request.prompt !== "string" || (!request.prompt.trim() && !hasImages) || request.prompt.length > MAX_PROMPT) throw new Error("Task prompt must be non-empty text up to 120000 characters");
    if (request.displayText !== undefined && (typeof request.displayText !== "string" || request.displayText.length > MAX_PROMPT)) throw new Error("Invalid task displayText");
    if (request.sessionMode !== "auto" && request.sessionMode !== "new") throw new Error("sessionMode must be \"auto\" or \"new\"");
    if (request.coordination !== undefined && request.coordination !== true) throw new Error("coordination must be true when specified");
    if (request.coordination && request.sessionMode !== "new") throw new Error("A coordinator requires sessionMode new");
    if (typeof request.workspacePath !== "string" || !request.workspacePath.trim()) throw new Error("workspacePath is required");
    for (const [field, value] of [["engine", request.engine], ["model", request.model], ["effort", request.effort], ["providerId", request.providerId]] as const) {
      if (value !== undefined && !selector(value)) throw new Error(`Invalid task ${field}`);
    }
    if (request.providerId !== undefined && (!request.engine || !request.model || !request.effort)) {
      throw new Error("providerId requires explicit engine, model and effort");
    }
    if (request.effort !== undefined && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(request.effort)) {
      throw new Error("Task effort must be one of low, medium, high, xhigh, max, ultra");
    }
    if (request.contextRefs !== undefined && (!Array.isArray(request.contextRefs) || request.contextRefs.length > 32 ||
      request.contextRefs.some((r) => !label(r, 1024)))) throw new Error("contextRefs must be at most 32 single-line references");
    const from = request.handoffFrom;
    if (from !== undefined && !(from && (("requestId" in from && validId(from.requestId)) ||
      ("session" in from && from.session && typeof from.session.engine === "string" && typeof from.session.sessionId === "string" && typeof from.session.workspacePath === "string")))) {
      throw new Error("Invalid handoffFrom");
    }
  }

  async function submit(request: HostTaskSubmission): Promise<HostTaskReceipt> {
    validateSubmission(request);
    request = structuredClone(request);
    const imageIds = request.images?.length ? request.images.map((id) => id.trim()) : undefined;
    await ensure();
    assertLive();
    const fingerprint = JSON.stringify([request.taskId, request.slotKey, request.projectId, request.workspacePath, request.prompt,
      request.writePaths ?? null, request.contextRefs ?? null, request.sessionMode, request.handoffFrom ?? null,
      request.engine ?? null, request.model ?? null, request.effort ?? null,
      ...(request.providerId !== undefined ? [request.providerId] : []),
      ...(imageIds ? [imageIds] : []), ...(request.coordination || request.displayText !== undefined || request.fixedInstructions ? [{ ...(request.coordination ? { coordination: true } : {}), ...(request.displayText !== undefined ? { displayText: request.displayText } : {}), ...(request.fixedInstructions ? { fixedInstructions: fixedInstructionsIdentity(request.fixedInstructions) } : {}) }] : [])]);
    const previous = entries.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("Task requestId already belongs to a different submission");
      return view(previous);
    }
    if (request.fixedInstructions && !await facade.fixedInstructionsSupported?.()) throw new Error("Native fixed instructions are unavailable");
    const workspace = registeredWorkspace(facade, request.workspacePath);
    if (!workspace || workspace.remote || workspace.archived) throw new Error("workspacePath must be a registered, local, non-archived workspace");
    const writePaths = normalizeTaskWritePaths(request.writePaths, workspace.path);
    const engines = facade.engines();
    const newEngine = request.engine ?? facade.activeEngine();
    const info = engines.find((e) => e.id === newEngine);
    if (!info?.available || !info.enabled) throw new Error(`Engine ${newEngine} is not available for tasks`);
    if (imageIds && info.supportsImages !== true) throw new Error(`Engine ${newEngine} does not support image attachments`);
    const requestedSelection: HostTaskSelection | undefined = request.providerId !== undefined
      ? { engine: request.engine!, model: request.model!, effort: request.effort!, providerId: request.providerId } : undefined;
    const effectiveSelection = requestedSelection ? await resolveSelection(requestedSelection) : undefined;
    if (imageIds) {
      await resolveTaskImages(imageIds);
      assertLive();
    }
    const frozenLaunch: TaskLaunchChoices = {
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      defaultModel: info.defaultModel ?? null,
      defaultEffort: info.defaultEffort ?? null,
      defaultProvider: info.defaultProvider ?? null,
      ...(effectiveSelection ? { model: effectiveSelection.model, effort: effectiveSelection.effort, providerId: effectiveSelection.providerId } : {}),
    };
    const handoff = await handoffNote(request, workspace.path);
    const prompt = composePrompt(request, workspace.path, writePaths, handoff);
    if (prompt.length > 131_072) throw new Error("Task prompt with its host note exceeds 131072 characters");
    return serial(async () => {
      assertLive();
      const again = entries.get(request.requestId);
      if (again) {
        if (again.fingerprint !== fingerprint) throw new Error("Task requestId already belongs to a different submission");
        return view(again);
      }
      checkpoint.assertAllowed();
      if (fenced) throw new Error("Task ledger is fenced after an ambiguous storage failure");
      if (entries.size >= MAX_ENTRIES) throw new Error("Task ledger capacity reached");
      const at = now();
      const entry: Entry = {
        receipt: {
          requestId: request.requestId, taskId: request.taskId, executionId: `exec-${newId()}`, projectId: request.projectId,
          slotKey: request.slotKey, workspacePath: workspace.path, status: "queued", sessionDecision: null, session: null,
          runId: null, acceptedAt: at, updatedAt: at,
          ...(requestedSelection ? { requestedSelection, effectiveSelection } : {}),
        },
        fingerprint,
        ...(request.coordination ? { coordination: true as const, conversationOwner: true as const, conversationHolding: true } : {}),
        prompt,
        ...(request.displayText !== undefined ? { displayText: request.displayText } : {}),
        ...(request.fixedInstructions ? { fixedInstructions: fixedInstructionsIdentity(request.fixedInstructions) } : {}),
        ...(imageIds ? { images: imageIds } : {}),
        writePaths,
        requestedEngine: request.engine ?? null,
        newEngine,
        launch: frozenLaunch,
        sessionMode: request.sessionMode,
        lastSeq: -1,
        ...(request.handoffFrom ? { hasExplicitHandoff: true } : {}),
      };
      entries.set(request.requestId, entry);
      if (entry.coordination) {
        conversationHolds.add(request.requestId);
        facadeClaims(facade).set(`${pluginId}\u0000conversation:${request.requestId}`, { pluginId, requestId: request.requestId, runId: "", session: null, status: "unknown", workspacePath: workspace.path, writePaths });
      }
      try { await persistIndex(); }
      catch { entries.delete(request.requestId); conversationHolds.delete(request.requestId); facadeClaims(facade).delete(`${pluginId}\u0000conversation:${request.requestId}`); fenced = true; throw new Error("Task acceptance could not be persisted; nothing was started"); }
      emit(entry);
      kick();
      return view(entry);
    });
  }

  async function cancel(requestId: string): Promise<HostTaskReceipt | null> {
    await ensure();
    return serial(async () => {
      assertLive();
      const entry = entries.get(requestId);
      if (!entry) return null;
      const status = entry.receipt.status;
      if (status === "queued") {
        await change(entry, { status: "cancelled", error: "Cancelled before delivery", blockedBy: undefined });
      } else if ((ACTIVE.has(status) || status === "unknown") && !entry.identityMismatch) {
        if (!entry.cancelRequested) {
          entry.cancelRequested = true;
          await change(entry, {});
        }
        if ((entry.ack || status === "unknown") && entry.receipt.runId) {
          const stopped = await facade.interrupt(entry.receipt.runId).catch(() => false);
          if (!stopped && !facade.liveRun(entry.receipt.runId)) {
            const settledPatch = settleFromNativeProof(entry);
            if (settledPatch) {
              await change(entry, settledPatch, moveSlot);
            }
          }
        }
      }
      return view(entry);
    });
  }

  // --- planning --------------------------------------------------------------

  const savePlanRecord = (
    nextRecord: HostTaskPlanRecord & { fingerprint: string },
    fallbackRecord: (HostTaskPlanRecord & { fingerprint: string }) | null,
  ): Promise<void> => {
    if (disposed) return Promise.reject(new HostTaskPlanError("failed", "Host task bridge has been disposed"));
    return chained(pluginId, async () => {
      if (disposed) throw new HostTaskPlanError("failed", "Host task bridge has been disposed");
      plans.set(nextRecord.requestId, structuredClone(nextRecord));
      const value: PlanStore = structuredClone({ version: 1, plans: [...plans.values()] });
      try {
        await predecessorDrain;
        await storage.set(pluginId, HOST_TASKS_PLANS_KEY, value);
      } catch (error) {
        if (fallbackRecord) plans.set(nextRecord.requestId, structuredClone(fallbackRecord));
        else plans.delete(nextRecord.requestId);
        throw error;
      }
    });
  };

  async function plan(request: HostTaskPlanRequest): Promise<HostTaskPlan> {
    if (!request || !validId(request.requestId)) throw new HostTaskPlanError("invalid_request", "Invalid plan requestId");
    if (!Array.isArray(request.projects)) throw new HostTaskPlanError("invalid_request", "projects must be an array");
    await ensure();
    assertLive();
    const projects = request.projects.map((p) => {
      const workspace = p && typeof p.workspacePath === "string" ? registeredWorkspace(facade, p.workspacePath) : undefined;
      if (!workspace || workspace.remote || workspace.archived) {
        throw new HostTaskPlanError("invalid_request", `Candidate ${String(p?.id)} is not a registered local workspace`);
      }
      return { id: p.id, label: p.label, workspacePath: workspace.path, ...(p.description !== undefined ? { description: p.description } : {}) };
    });
    const explicitPlanner = request.planner
      ? {
          engine: request.planner.engine,
          model: request.planner.model ?? null,
          effort: request.planner.effort ?? null,
          providerId: request.planner.providerId ?? null,
        }
      : null;
    const fingerprint = JSON.stringify([request.goal, projects, request.context ?? null, explicitPlanner]);
    const existing = plans.get(request.requestId);
    const inflightMeta = inflightPlanMeta.get(request.requestId);
    const knownFingerprint = existing?.fingerprint ?? inflightMeta?.fingerprint;
    if (knownFingerprint !== undefined && knownFingerprint !== fingerprint) {
      throw new HostTaskPlanError("invalid_request", "Plan requestId already belongs to a different request");
    }
    const running = inflightPlans.get(request.requestId);
    if (running) return running;
    if (existing) {
      if (existing.plan && (existing.status === "ready" || existing.status === "needs_clarification")) {
        return structuredClone(existing.plan);
      }
      if (existing.status === "failed" || existing.status === "cancelled") {
        throw new HostTaskPlanError(
          existing.error?.code ?? (existing.status === "cancelled" ? "cancelled" : "failed"),
          existing.error?.message ?? "Plan failed",
        );
      }
      throw new HostTaskPlanError("failed", "Plan result could not be persisted; request will not be replayed");
    }
    const totalOccupied = new Set([...plans.keys(), ...inflightPlans.keys()]).size;
    if (totalOccupied >= MAX_PLANS) {
      throw new HostTaskPlanError("invalid_request", "Plan ledger capacity reached");
    }
    if (paused() || checkpoint.isPaused()) {
      throw new HostTaskPlanError("failed", "Runtime handoff has paused new submissions");
    }
    const engine = request.planner?.engine ?? facade.activeEngine();
    if (!PLANNER_ENGINES.has(engine)) {
      throw new HostTaskPlanError("planner_unavailable", `The active engine ${engine} has no isolated planner; pass planner with claude, codex or pi`);
    }
    const info = facade.engines().find((e) => e.id === engine);
    const model = request.planner?.model ?? info?.defaultModel ?? "";
    const effort = request.planner?.effort ?? info?.defaultEffort ?? undefined;
    const providerId = request.planner?.providerId ?? undefined;
    const normalized = {
      requestId: request.requestId,
      goal: request.goal,
      projects,
      ...(request.context !== undefined ? { context: request.context } : {}),
      planner: {
        engine,
        model,
        ...(effort ? { effort } : {}),
        ...(providerId ? { providerId } : {}),
      },
    };
    const startedAt = now();
    const runningRecord: HostTaskPlanRecord & { fingerprint: string } = {
      requestId: request.requestId,
      fingerprint,
      status: "running",
      updatedAt: startedAt,
    };
    inflightPlanMeta.set(request.requestId, { fingerprint, startedAt });
    const promise = (async () => {
      try {
        try {
          await savePlanRecord(runningRecord, null);
        } catch {
          throw new HostTaskPlanError("failed", "Plan acceptance could not be persisted; planner was not started");
        }
        let planValue: HostTaskPlan;
        try {
          if (cancelledPlans.has(request.requestId)) {
            throw new HostTaskPlanError("cancelled", "The plan was cancelled");
          }
          if (disposed || paused() || checkpoint.isPaused()) {
            throw new HostTaskPlanError("failed", "Planner was stopped before launch");
          }
          nativeStartedPlans.add(request.requestId);
          const result = await deps.invoke("plugin_task_plan", { pluginId, request: normalized }) as HostTaskPlan;
          const pendingCancel = cancellingPlans.get(request.requestId);
          if (pendingCancel && (await pendingCancel)) {
            cancelledPlans.add(request.requestId);
          }
          if (cancelledPlans.has(request.requestId)) {
            throw new HostTaskPlanError("cancelled", "The plan was cancelled");
          }
          if (!result || result.requestId !== request.requestId || (result.status !== "ready" && result.status !== "needs_clarification")) {
            throw new HostTaskPlanError("bad_output", "Planner response is malformed");
          }
          planValue = structuredClone(result);
        } catch (error) {
          const pendingCancel = cancellingPlans.get(request.requestId);
          if (pendingCancel && (await pendingCancel)) {
            cancelledPlans.add(request.requestId);
          }
          const rawFailure = planError(error);
          const failure = cancelledPlans.has(request.requestId)
            ? new HostTaskPlanError("cancelled", rawFailure.code === "cancelled" ? rawFailure.message : "The plan was cancelled")
            : rawFailure;
          if (!disposed) {
            try {
              await savePlanRecord(
                {
                  requestId: request.requestId,
                  fingerprint,
                  status: failure.code === "cancelled" ? "cancelled" : "failed",
                  error: { code: failure.code, message: failure.message },
                  updatedAt: now(),
                },
                runningRecord,
              );
            } catch {
              // Retain runningRecord in plans/storage so this requestId cannot be replayed.
            }
          }
          throw failure;
        }
        if (disposed) {
          throw new HostTaskPlanError("failed", "Host task bridge has been disposed");
        }
        try {
          await savePlanRecord(
            {
              requestId: request.requestId,
              fingerprint,
              status: planValue.status,
              plan: planValue,
              updatedAt: now(),
            },
            runningRecord,
          );
        } catch {
          throw new HostTaskPlanError("failed", "Plan result could not be persisted; request will not be replayed");
        }
        return planValue;
      } finally {
        inflightPlans.delete(request.requestId);
        inflightPlanMeta.delete(request.requestId);
        nativeStartedPlans.delete(request.requestId);
        cancelledPlans.delete(request.requestId);
        cancellingPlans.delete(request.requestId);
      }
    })();
    inflightPlans.set(request.requestId, promise);
    return promise;
  }

  // --- history ---------------------------------------------------------------

  function localWorkspace(path: unknown) {
    const workspace = typeof path === "string" ? registeredWorkspace(facade, path) : undefined;
    if (!workspace || workspace.remote) throw new Error("workspacePath must be a registered local workspace");
    return workspace;
  }

  async function history(query: HostTaskHistoryQuery): Promise<HostTaskHistoryPage> {
    await ensure();
    const workspace = localWorkspace(query?.workspacePath);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("history offset/limit out of range");
    const rows = facade.sessions()
      .filter((m) => !m.remote && !m.auxiliaryKind && sameTaskPath(m.workspacePath, workspace.path))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const branches = await facade.leaderBranches().catch(() => []);
    const parents = new Map<string, { engine: string; sessionId: string }>();
    const children = new Map<string, number>();
    for (const branch of branches) {
      if (!branch.sessionId) continue;
      parents.set(`${branch.engine}/${branch.sessionId}`, { engine: branch.parentEngine, sessionId: branch.parentSessionId });
      const parentKey = `${branch.parentEngine}/${branch.parentSessionId}`;
      children.set(parentKey, (children.get(parentKey) ?? 0) + 1);
    }
    const items = rows.slice(offset, offset + limit).map((m) => {
      const ref = { engine: m.engine, sessionId: m.sessionId, workspacePath: m.workspacePath };
      const status = facade.inspect(ref);
      const key = refKey(ref);
      return {
        ...ref, title: clip(m.customTitle || m.title || "", 200), preview: clip(m.preview ?? "", 160),
        createdAt: m.createdAt, updatedAt: m.updatedAt, messageCount: m.messageCount, pinned: m.pinned,
        model: m.model ?? null, effort: m.effort ?? null, open: status !== null, status: status ?? "closed" as const,
        parent: parents.get(key) ?? null, childCount: children.get(key) ?? 0,
        taskRequestIds: [...entries.values()].filter((e) => e.receipt.session && refKey(e.receipt.session) === key).map((e) => e.receipt.requestId),
      };
    });
    return { items, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
  }

  async function excerpt(query: HostTaskExcerptQuery): Promise<HostTaskExcerpt> {
    await ensure();
    const workspace = localWorkspace(query?.workspacePath);
    const ref = { engine: query.engine, sessionId: query.sessionId, workspacePath: workspace.path };
    if (typeof ref.engine !== "string" || !plausibleSessionId(ref.engine, ref.sessionId) || !facade.known(ref)) {
      throw new Error("Chat is not a saved local chat in this workspace");
    }
    const limit = query.limit ?? 20;
    const maxChars = query.maxChars ?? 12_000;
    const before = query.before ?? null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 40 || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 24_000 ||
      (before !== null && !Number.isInteger(before))) throw new Error("excerpt limit/maxChars/before out of range");
    const page = await facade.loadPage(ref, limit, before);
    const rows = page.messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim());
    const picked: HostTaskExcerpt["messages"][number][] = [];
    let budget = maxChars;
    let truncated = false;
    for (let i = rows.length - 1; i >= 0 && budget > 0; i--) {
      const row = rows[i];
      const allowance = Math.min(budget, 4_000);
      const text = clip(row.text, allowance);
      const clipped = text.length < row.text.length;
      truncated ||= clipped;
      picked.unshift({ seq: row.seq, role: row.role as "user" | "assistant", text, truncated: clipped });
      budget -= text.length;
    }
    const dropped = rows.length - picked.length;
    if (dropped > 0) truncated = true;
    const nextBefore = dropped > 0 ? picked[0]?.seq ?? page.nextBefore : page.nextBefore;
    return { messages: picked, nextBefore, truncated };
  }

  async function catalog(options?: { includeModels?: boolean }): Promise<HostTaskCatalog> {
    await ensure();
    const fixedInstructions = await facade.fixedInstructionsSupported?.() === true;
    const workspaces = facade.workspaces().map((w) => ({ ...w, executable: !w.remote && !w.archived }));
    const engines = await Promise.all(facade.engines().map(async (e) => ({
      ...e, supportsImages: e.supportsImages === true, supportsFixedInstructions: fixedInstructions && supportsFixedInstructions(e.id), planner: PLANNER_ENGINES.has(e.id) && e.available && e.enabled,
      ...(options?.includeModels ? { models: e.available && e.enabled ? await facade.models(e.id).catch(() => null) : null } : {}),
    })));
    const projects = (await facade.projects().catch(() => [])).map((p) => ({
      id: p.id, name: p.name, defaultPath: p.defaultPath, sourcePluginId: p.sourcePluginId ?? null,
      members: p.members.map((m) => ({ id: m.id, path: m.path, label: m.label, role: m.role, status: m.status,
        registered: workspaces.some((w) => sameTaskPath(w.path, m.path)) })),
    }));
    return { defaultEngine: facade.activeEngine(), engines, workspaces, projects, capabilities: { nativeCoordination: true, images: true, continuousCoordination: true, fixedInstructions } };
  }

  // --- registration ----------------------------------------------------------

  const conversations = createTaskConversationBridge({
    pluginId, storage, now, runId: deps.runId, paused,
    coordinators: () => [...entries.values()].filter(e => e.coordination || e.conversationOwner).map(e => e.receipt.requestId),
    facade: async () => { await ensure(); return facade; },
    owned: async (id) => {
      await ensure(); const entry = entries.get(id);
      if (!entry || entry.forgotten) throw new Error("Unknown owned task request");
      if (entry.identityMismatch) throw new Error("Task native identity is ambiguous");
      const ref = entry.receipt.session;
      if (ref && entry.sessionProven) {
        const ordered = [...entries.values()];
        const newer = ordered.slice(ordered.indexOf(entry) + 1).some(other => other.receipt.session && sameSession(other.receipt.session, ref) &&
          (other.sessionProven || other.ack || HOLDING_LOCKS.has(other.receipt.status)));
        if (newer || exclusiveOwner(ref, entry) || (entry.conversationSession && !sameSession(entry.conversationSession, ref))) throw new Error("The exact session has a newer or different exclusive owner");
        if (!entry.coordination && !entry.conversationOwner) {
          await facade.openBackground(ref);
          const live = facade.conversationState?.(ref);
          if (!live || (live.status !== "idle" && (!live.runId || (live.runId !== entry.receipt.runId && facade.liveRun(live.runId))))) throw new Error("Legacy task is not the current exclusive native run owner");
        }
        if (!entry.conversationOwner || !entry.conversationSession) {
          entry.conversationOwner = true; entry.conversationSession = { ...ref };
          await persistIndex();
        }
      }
      return { receipt: view(entry), proven: entry.sessionProven === true, launch: entry.launch, displayText: entry.displayText, userRow: entry.userRow, fixedInstructions: entry.fixedInstructions };
    },
    resolveImages: resolveTaskImages,
    verify: async (id) => { const entry = entries.get(id); if (!entry) throw new TaskPreSpawnError("Unknown owned coordinator"); await verifySelection(entry); },
    blocked: (id) => { const entry = entries.get(id); return !entry || blockersFor(entry).length > 0; },
    cancelInitial: cancel,
    async hold(id, holding) {
      const entry = entries.get(id); if (!entry || !facade) return;
      const key = `${pluginId}\u0000conversation:${id}`;
      if (holding) {
        conversationHolds.add(id);
        facadeClaims(facade).set(key, { pluginId, requestId: id, runId: "", session: entry.receipt.session ?? null,
          status: "unknown", sessionProven: entry.sessionProven, workspacePath: entry.receipt.workspacePath, writePaths: entry.writePaths });
      } else { conversationHolds.delete(id); facadeClaims(facade).delete(key); }
      if (entry.conversationHolding !== holding) {
        entry.conversationHolding = holding;
        await persistIndex();
        if (!holding) kickAll();
      }
    },
  });

  const unregisterBlocker = (deps.registerBlocker ?? registerRuntimeCheckpointBlocker)(
    participantId,
    () => inFlightStarts.size ? ["task-start-unpublished"] : [],
  );

  const participant: RuntimeCheckpointParticipant = {
    id: participantId,
    capture: captureCheckpoint,
    restore: restoreCheckpoint,
    readiness: () => {
      const reasons: string[] = [];
      if (initializationFailure) reasons.push("ledger-initialization-failed");
      if (fenced) reasons.push("ledger-ambiguous");
      if (inFlightStarts.size) reasons.push("task-start-unpublished");
      return reasons;
    },
    async ready() {
      await ready();
      await conversations.ready();
      await conversations.drain();
      await deps.checkpointReady?.();
      await ready();
    },
    resumed() {
      const cache = restorationCache(checkpoint);
      if (cache.get(participantId)?.owner === checkpointOwner) cache.delete(participantId);
      resumeWaiting = false;
      kick();
      conversations.wake();
      deps.resumed?.();
    },
  };
  const registrations = registrationMap(checkpoint);
  registrations.get(participantId)?.();
  const rawUnregisterCheckpoint = checkpoint.register(participant);
  const unregisterCheckpoint: Disposer = () => {
    if (registrations.get(participantId) === unregisterCheckpoint) {
      registrations.delete(participantId);
    }
    rawUnregisterCheckpoint();
  };
  registrations.set(participantId, unregisterCheckpoint);
  const inherited = restorationCache(checkpoint).get(participantId);
  if (!restored && checkpoint.isPaused() && inherited) restoreCheckpoint(inherited.snapshot);

  return {
    conversation: conversations.conversation,
    sendMessage: conversations.sendMessage,
    messageReceipt: conversations.messageReceipt,
    cancelMessage: conversations.cancelMessage,
    stopConversation: conversations.stopConversation,
    conversationAction: conversations.conversationAction,
    onConversationEvent: conversations.onConversationEvent,
    ready,
    catalog,
    history,
    excerpt,
    plan,
    async getPlan(requestId) {
      await ensure();
      if (cancelledPlans.has(requestId)) {
        const current = plans.get(requestId);
        if (!current || current.status === "running") {
          return {
            requestId,
            status: "cancelled",
            error: { code: "cancelled", message: "The plan was cancelled" },
            updatedAt: current?.updatedAt ?? inflightPlanMeta.get(requestId)?.startedAt ?? now(),
          };
        }
      }
      const record = plans.get(requestId);
      if (record) {
        const { fingerprint: _fingerprint, ...rest } = record;
        return structuredClone(rest);
      }
      const meta = inflightPlanMeta.get(requestId);
      if (meta) {
        return { requestId, status: "running", updatedAt: meta.startedAt };
      }
      return null;
    },
    async cancelPlan(requestId) {
      await ensure();
      if (!inflightPlans.has(requestId)) return false;
      if (!nativeStartedPlans.has(requestId)) {
        cancelledPlans.add(requestId);
        return true;
      }
      let cancelling = cancellingPlans.get(requestId);
      if (!cancelling) {
        cancelling = Promise.resolve(deps.invoke("plugin_task_plan_cancel", { pluginId, requestId }))
          .then((res) => res === true, () => false);
        cancellingPlans.set(requestId, cancelling);
      }
      const cancelled = await cancelling;
      if (cancelled) {
        cancelledPlans.add(requestId);
      }
      return cancelled;
    },
    submit,
    async receipt(requestId) { await ensure(); return serial(async () => { const entry = entries.get(requestId); return entry ? view(entry) : null; }); },
    async list(query) {
      await ensure();
      return serial(async () => [...entries.values()].filter((e) =>
        (!query?.projectId || e.receipt.projectId === query.projectId) &&
        (!query?.slotKey || e.receipt.slotKey === query.slotKey) &&
        (!query?.taskId || e.receipt.taskId === query.taskId)).map(view));
    },
    cancel,
    async open(requestId) {
      await ensure();
      const entry = entries.get(requestId);
      if (!entry) throw new Error("Unknown task request");
      if (entry.receipt.session) { await facade.focus(entry.receipt.session); return; }
      if (entry.receipt.sessionDecision === "new" && entry.execEngine && ACTIVE.has(entry.receipt.status)) {
        await facade.focusDraft(entry.execEngine, entry.receipt.workspacePath);
        return;
      }
      throw new Error("This task has no conversation yet");
    },
    async forget(requestId) {
      await ensure();
      return serial(async () => {
        assertLive();
        const entry = entries.get(requestId);
        // Never allow forgetting unknown or active tasks, and preserve the
        // non-replayable idempotency fingerprint + receipt identity as a tombstone.
        if (!entry || !SETTLED.has(entry.receipt.status) || entry.forgotten || conversationHolds.has(requestId)) return false;
        texts.delete(requestId);
        dirtyTexts.delete(requestId);
        entry.hasText = undefined;
        entry.prompt = "";
        entry.forgotten = true;
        entry.receipt = { ...entry.receipt, updatedAt: now() };
        await persistIndex();
        await chained(pluginId, () => storage.delete(pluginId, textKey(requestId))).catch(() => undefined);
        return true;
      });
    },
    async slots(projectId) {
      await ensure();
      return [...slots.values()].filter((s) => !projectId || s.projectId === projectId).map((s) => structuredClone(s));
    },
    onEvent(callback) {
      assertLive();
      listeners.add(callback);
      void ensure().catch(() => { console.error("[plugins] host task receipt subscription unavailable"); });
      return () => { listeners.delete(callback); };
    },
    dispose() {
      if (disposed) return;
      if (textTimer) clearTimeout(textTimer);
      flushTexts();
      const cache = restorationCache(checkpoint);
      if (restored && checkpoint.isPaused() && cache.get(participantId)?.owner === checkpointOwner) {
        const drain = Promise.allSettled([predecessorDrain, init ?? Promise.resolve(), chain]).then(() => undefined);
        cache.set(participantId, { snapshot: captureCheckpoint(), owner: checkpointOwner, drain });
      }
      for (const requestId of inflightPlans.keys()) void deps.invoke("plugin_task_plan_cancel", { pluginId, requestId }).catch(() => undefined);
      disposed = true;
      conversations.dispose();
      // Active and unknown tasks keep their write claims in facadeClaims until
      // a verified native terminal state settles them.
      unregisterBlocker();
      unregisterCheckpoint();
      listeners.clear();
      for (const off of disposers.splice(0)) off();
      kickAll();
    },
  };
}
