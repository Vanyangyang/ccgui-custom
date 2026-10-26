import type { ConversationSelection, ConversationSnapshot, HostConversationsApi, Disposer } from "@ccgui/plugin-sdk";
import type { SidechatState } from "@/features/sidechat/store";
import type { PluginStorageBackend } from "./context";
import { desktopConversationFacade, type HostConversationFacade } from "./conversation-facade";
import { runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import { plausibleSessionId } from "./task-facade";
import type { Message } from "@/lib/ipc";
import type { HostFixedInstructions } from "@ccgui/plugin-sdk";
import { validateFixedInstructions, sameFixedInstructions, fixedInstructionsIdentity } from "./fixed-instructions";

export const HOST_CONVERSATIONS_KEY_PREFIX = "__host_conversations_v1:";
const controllers = new Map<string, HostConversationsApi>();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id);
// Match engine::sidechat::is_safe_session_id before native can filter an invalid
// resume identity into None (which would accidentally start another branch).
const validNativeId = (engine: string, id: unknown): id is string => plausibleSessionId(engine, id) && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error("Invalid conversation fields");
  }
}
function selection(value: unknown): asserts value is ConversationSelection {
  object(value, ["engine", "model", "effort", "providerId"]);
  if (value.engine !== "claude" && value.engine !== "codex") throw new Error("Unsupported conversation engine");
  for (const field of ["model", "effort", "providerId"]) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !value[field] ||
      (value[field] as string).length > 256 || /[\u0000-\u001f]/.test(value[field] as string))) throw new Error(`Invalid ${field}`);
  }
}
const signature = (s: ConversationSelection) => JSON.stringify([s.engine, s.model ?? null, s.effort ?? null, s.providerId ?? null]);
interface Entry {
  snapshot: ConversationSnapshot;
  launchSelection: ConversationSelection;
  runId: string | null;
  cancelled: boolean;
  fixedInstructions?: HostFixedInstructions;
  fingerprint?: string;
  baseRevision?: number;
  state?: SidechatState;
  /** Durable intent only; never injected into SidechatStore before native send. */
  pendingUser?: Message;
  /** Rows at/before this fence are not proven successful extraction input.
   * Set on failed/cancelled turns; never removes or edits transcript rows. */
  memoryFloorSeq?: number;
}
function explicitSelection(value: unknown): asserts value is Required<ConversationSelection> {
  selection(value);
  if (!value.model?.trim() || !value.effort?.trim() || !value.providerId?.trim()) throw new Error("Explicit launch selection required");
}
function messages(value: unknown): asserts value is Message[] {
  if (!Array.isArray(value) || value.some((m) => !m || typeof m !== "object" || Array.isArray(m) ||
    !Number.isSafeInteger(m.seq) || m.seq < 0 || typeof m.role !== "string" || !m.role ||
    typeof m.text !== "string" || (m.ts !== null && typeof m.ts !== "string") ||
    (m.live !== undefined && typeof m.live !== "boolean") ||
    (m.images !== undefined && (!Array.isArray(m.images) || m.images.length > 8 ||
      m.images.some((img: unknown) => typeof img !== "string" || !img.trim() || img.length > 4096 || /[\u0000-\u001f]/.test(img)))))) throw new Error("Invalid conversation messages");
}
function validateImageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || value.some((id) => !validId(id))) {
    throw new Error("Invalid conversation send images");
  }
  return value.map((id) => id.trim());
}
function validateConversationFingerprint(raw: unknown, baseRevision: number, pendingUser?: Message, fixedInstructions?: HostFixedInstructions): void {
  if (typeof raw !== "string") throw new Error("Persisted conversation identity mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Persisted conversation identity mismatch"); }
  if (!Array.isArray(parsed)) throw new Error("Persisted conversation identity mismatch");
  const last = parsed.at(-1);
  if (last && typeof last === "object" && !Array.isArray(last)) {
    object(last, ["fixedInstructions"]);
    validateFixedInstructions(last.fixedInstructions);
    if (!last.fixedInstructions || !sameFixedInstructions(last.fixedInstructions, fixedInstructions)) throw new Error("Persisted conversation instructions mismatch");
    parsed.pop();
  }
  if (parsed.length !== 2 && parsed.length !== 3) {
    throw new Error("Persisted conversation identity mismatch");
  }
  const [rev, prompt, imgIds] = parsed;
  if (rev !== baseRevision || typeof prompt !== "string" || prompt.length > 120000) {
    throw new Error("Persisted conversation identity mismatch");
  }
  if (parsed.length === 2) {
    if (!prompt.trim() || pendingUser?.images !== undefined) {
      throw new Error("Persisted conversation identity mismatch");
    }
  } else {
    if (
      !Array.isArray(imgIds) ||
      imgIds.length < 1 ||
      imgIds.length > 8 ||
      imgIds.some((id) => !validId(id) || id.trim() !== id) ||
      (pendingUser !== undefined && (!Array.isArray(pendingUser.images) || pendingUser.images.length !== imgIds.length))
    ) {
      throw new Error("Persisted conversation identity mismatch");
    }
  }
  if (pendingUser !== undefined && pendingUser.text !== prompt.trim()) {
    throw new Error("Persisted conversation identity mismatch");
  }
}
function validateState(e: Entry, state: SidechatState): void {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
    typeof state.open !== "boolean" || typeof state.streaming !== "boolean" || typeof state.draft !== "string" ||
    (state.error !== null && typeof state.error !== "string") ||
    (state.startedAt !== null && (typeof state.startedAt !== "number" || !Number.isFinite(state.startedAt))) ||
    (state.usage !== null && (typeof state.usage !== "object" || Array.isArray(state.usage))) ||
    (state.runId !== null && (typeof state.runId !== "string" || !/^sidechat-[a-zA-Z0-9-]{1,128}$/.test(state.runId))) ||
    (state.streaming && !state.runId) || state.engine !== e.snapshot.selection.engine ||
    state.workspacePath !== e.snapshot.workspacePath || state.parentSessionId !== null ||
    (state.mode !== undefined && state.mode !== "read-only") ||
    (state.sideSessionId !== null && !validNativeId(state.engine, state.sideSessionId)) ||
    (e.snapshot.sessionRef && state.sideSessionId !== e.snapshot.sessionRef.sessionId)) {
    throw new Error("Invalid conversation state or ownership mismatch");
  }
  messages(state.messages);
}
export interface ConversationBridgeDependencies {
  facade(): Promise<HostConversationFacade>;
  /** Tests can supply an isolated coordinator. */
  checkpoint?: Pick<typeof runtimeCheckpoint, "assertAllowed" | "registerBlocker">;
}

/** Document singleton survives plugin reload; only SDK listeners are disposed.
 * Persistent records have one latest request per thread, never per-turn tombstones. */
export function createHostConversationBridge(pluginId: string, storage: PluginStorageBackend,
  dependencies?: ConversationBridgeDependencies): HostConversationsApi & { dispose: Disposer } {
  let controller = dependencies ? undefined : controllers.get(pluginId);
  if (!controller) {
    controller = createController(pluginId, storage, dependencies ?? { facade: desktopConversationFacade });
    if (!dependencies) controllers.set(pluginId, controller);
  }
  let disposed = false;
  const subscriptions = new Set<Disposer>();
  const live = () => { if (disposed) throw new Error("Conversation facade disposed"); return controller!; };
  return {
    catalog: () => live().catalog(), open: (r) => live().open(r), inspect: (id) => live().inspect(id),
    send: (r) => live().send(r), stop: (id) => live().stop(id),
    openFile: (id, path) => live().openFile(id, path),
    onEvent(callback) {
      const off = live().onEvent(callback);
      const dispose = () => { off(); subscriptions.delete(dispose); };
      subscriptions.add(dispose); return dispose;
    },
    dispose() { disposed = true; for (const off of subscriptions) off(); subscriptions.clear(); },
  };
}

function createController(pluginId: string, storage: PluginStorageBackend, deps: ConversationBridgeDependencies): HostConversationsApi {
  const checkpoint = deps.checkpoint ?? runtimeCheckpoint;
  const entries = new Map<string, Entry>();
  const loads = new Map<string, Promise<Entry | undefined>>();
  const opens = new Map<string, Promise<ConversationSnapshot>>();
  const listeners = new Set<(s: ConversationSnapshot) => void>();
  const preparing = new Set<string>();
  const submissions = new Map<string, { requestId: string; fingerprint: string; result: Promise<ConversationSnapshot> }>();
  // Document-only proof. A durable runId alone never means a native run is alive.
  const active = new Map<string, { runId: string; observed: boolean }>();
  const terminal = new Map<string, { error: string | null }>();
  const writers = new Map<string, { dirty: boolean; saving?: Promise<void>; timer?: ReturnType<typeof setTimeout>; saved?: string }>();
  let host: HostConversationFacade;
  let ready: Promise<HostConversationFacade> | undefined;
  const key = (id: string) => HOST_CONVERSATIONS_KEY_PREFIX + pluginId + ":" + id;
  const writer = (id: string) => {
    let value = writers.get(id);
    if (!value) { value = { dirty: false }; writers.set(id, value); }
    return value;
  };
  const capture = (e: Entry, requireLive = false) => {
    const state = host.read(key(e.snapshot.threadId));
    if (!state) {
      if (e.snapshot.sessionRef) throw new Error("Native conversation state is missing");
      if (requireLive && e.state?.sideSessionId) throw new Error("Native conversation state is missing");
      return;
    }
    validateState(e, state);
    const run = active.get(e.snapshot.threadId);
    if (run && state.streaming && state.runId !== run.runId) throw new Error("Native conversation run ownership mismatch");
    // Identity and projection come from the same validated state, including when
    // a stop arrives before send's spawn acknowledgement resolves.
    // Zustand rows are immutable; retain their reference until persistence/view
    // takes a JSON copy, rather than serializing the full history per token.
    e.state = state;
    if (state.sideSessionId) e.snapshot.sessionRef = {
      engine: e.snapshot.selection.engine, sessionId: state.sideSessionId, workspacePath: state.workspacePath,
    };
    if (run && state.runId === run.runId) {
      run.observed = true;
      e.pendingUser = undefined;
    }
    if (run?.observed && !state.streaming) {
      e.pendingUser = undefined;
      terminal.set(e.snapshot.threadId, { error: state.error });
    }
  };
  const project = (e: Entry) => [...(e.state?.messages ?? []), ...(e.pendingUser ? [e.pendingUser] : [])];
  const view = (e: Entry): ConversationSnapshot => {
    try { capture(e); }
    catch { e.snapshot.status = "unknown"; e.snapshot.error = "Native conversation ownership mismatch"; }
    return copy({ ...e.snapshot, messages: project(e) });
  };
  const emit = (e: Entry) => {
    for (const callback of listeners) { try { callback(view(e)); } catch { /* isolate plugin observers */ } }
  };
  const markUnknown = (e: Entry, error: string) => {
    e.snapshot.status = "unknown"; e.snapshot.error = error; emit(e);
  };
  // One in-flight write plus one dirty bit per thread. Token updates never append
  // unbounded promises. Immediate identity/terminal flushes supersede the timer.
  const flush = (e: Entry): Promise<void> => {
    const w = writer(e.snapshot.threadId);
    if (w.timer) { clearTimeout(w.timer); w.timer = undefined; }
    w.dirty = true;
    if (w.saving) return w.saving;
    w.saving = (async () => {
      let failure: unknown;
      while (w.dirty) {
        w.dirty = false;
        try {
          capture(e);
          const proof = terminal.get(e.snapshot.threadId);
          if (proof) {
            e.snapshot.status = e.cancelled ? "cancelled" : proof.error ? "failed" : "completed";
            if (e.snapshot.status !== "completed") e.memoryFloorSeq = Math.max(e.memoryFloorSeq ?? -1, e.state?.messages.at(-1)?.seq ?? -1);
            if (proof.error) e.snapshot.error = proof.error; else delete e.snapshot.error;
          }
          const record = copy({ ...e, snapshot: { ...e.snapshot, messages: [] } });
          const serialized = JSON.stringify(record);
          if (serialized !== w.saved) {
            await storage.set(pluginId, HOST_CONVERSATIONS_KEY_PREFIX + e.snapshot.threadId, record);
            w.saved = serialized;
          }
          failure = undefined;
        } catch (error) {
          failure = error;
          markUnknown(e, "Conversation persistence failed; sending is blocked");
        }
      }
      if (failure) throw new Error("Conversation persistence failed; sending is blocked", { cause: failure });
    })().finally(() => {
      w.saving = undefined;
      // A terminal event can arrive while an older progress write is awaiting
      // storage. Reconcile has already detached the run then, so no later native
      // event will publish the status finalized by the dirty-write loop. Notify
      // subscribers after it drains, with the write blocker already released.
      if (terminal.has(e.snapshot.threadId) && ["completed", "failed", "cancelled"].includes(e.snapshot.status)) emit(e);
    });
    return w.saving;
  };
  const schedule = (e: Entry, immediate: boolean) => {
    const w = writer(e.snapshot.threadId);
    if (immediate) { void flush(e).catch(() => undefined); return; }
    if (w.timer) return;
    w.timer = setTimeout(() => { w.timer = undefined; void flush(e).catch(() => undefined); }, 100);
  };
  const reconcile = (e: Entry) => {
    if (!active.has(e.snapshot.threadId)) return;
    const previousId = e.snapshot.sessionRef?.sessionId;
    const previousState = e.state;
    try { capture(e); }
    catch { markUnknown(e, "Native conversation ownership mismatch"); return; }
    const ended = terminal.has(e.snapshot.threadId);
    if (ended) { active.delete(e.snapshot.threadId); e.runId = null; }
    if (!ended && e.snapshot.status !== "unknown") e.snapshot.status = "running";
    if (ended || previousId !== e.snapshot.sessionRef?.sessionId || previousState !== e.state) {
      schedule(e, ended || previousId !== e.snapshot.sessionRef?.sessionId);
      emit(e);
    }
  };
  const ensure = () => {
    if (!ready) ready = deps.facade().then((facade) => {
      host = facade;
      host.subscribe(() => { for (const e of entries.values()) reconcile(e); });
      return facade;
    }).catch((error) => { ready = undefined; throw error; });
    return ready;
  };
  checkpoint.registerBlocker("conversations:" + pluginId, () => [...entries.values()].some((e) => {
    const id = e.snapshot.threadId;
    const run = active.get(id);
    const state = host?.read(key(id));
    return preparing.has(id) || !!writer(id).saving || !!run ||
      (!!e.runId && state?.streaming === true && state.runId === e.runId);
  }) ? ["native-discussion-in-flight"] : []);
  const validateEntry = (raw: unknown, id: string): Entry => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid persisted conversation");
    const e = copy(raw) as Entry;
    const s = e.snapshot;
    if (!s || s.threadId !== id || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      typeof s.workspacePath !== "string" || !s.workspacePath.trim() || typeof e.cancelled !== "boolean" ||
      (e.runId !== null && (typeof e.runId !== "string" || !/^sidechat-[a-zA-Z0-9-]{1,128}$/.test(e.runId))) ||
      !["idle", "starting", "running", "completed", "failed", "cancelled", "unknown"].includes(s.status) ||
      (s.error !== undefined && typeof s.error !== "string")) throw new Error("Invalid persisted conversation");
    selection(s.selection); explicitSelection(s.effectiveSelection); explicitSelection(e.launchSelection);
    validateFixedInstructions(e.fixedInstructions);
    messages(s.messages);
    if (e.launchSelection.engine !== s.selection.engine || s.effectiveSelection.engine !== s.selection.engine ||
      e.launchSelection.providerId !== s.effectiveSelection.providerId ||
      (s.lastRequestId !== undefined && (!validId(s.lastRequestId) || typeof e.fingerprint !== "string" ||
        !Number.isSafeInteger(e.baseRevision) || e.baseRevision! !== s.revision - 1)) ||
      (s.revision > 0 && !s.lastRequestId) ||
      (s.sessionRef !== null && (!s.sessionRef || s.sessionRef.engine !== s.selection.engine ||
        s.sessionRef.workspacePath !== s.workspacePath || !validNativeId(s.selection.engine, s.sessionRef.sessionId)))) {
      throw new Error("Persisted conversation identity mismatch");
    }
    if (e.pendingUser !== undefined) {
      messages([e.pendingUser]);
      if (e.pendingUser.role !== "user" || !s.lastRequestId) throw new Error("Invalid persisted user intent");
    }
    if (s.lastRequestId !== undefined) {
      validateConversationFingerprint(e.fingerprint, e.baseRevision!, e.pendingUser, e.fixedInstructions);
    }
    if (e.state !== undefined) validateState(e, e.state);
    if (e.memoryFloorSeq !== undefined && (!Number.isSafeInteger(e.memoryFloorSeq) || e.memoryFloorSeq < -1 ||
      e.memoryFloorSeq > (e.state?.messages.at(-1)?.seq ?? -1))) throw new Error("Invalid memory completion fence");
    if (s.sessionRef && !e.state) throw new Error("Persisted native conversation state is missing");
    if (e.state?.sideSessionId !== (s.sessionRef?.sessionId ?? null) && e.state) throw new Error("Persisted conversation identity mismatch");
    return e;
  };
  const load = async (id: string) => {
    if (!validId(id)) throw new Error("Invalid conversation threadId");
    await ensure();
    await host.claim(pluginId, id);
    if (entries.has(id)) return entries.get(id);
    let promise = loads.get(id);
    if (!promise) {
      promise = (async () => {
        const raw = await storage.get(pluginId, HOST_CONVERSATIONS_KEY_PREFIX + id);
        if (raw == null) return undefined;
        const e = validateEntry(raw, id);
        await host.workspace(e.snapshot.workspacePath);
        if (e.runId || e.snapshot.status === "starting" || e.snapshot.status === "running" || e.state?.streaming) {
          e.snapshot.status = "unknown";
          e.snapshot.error = "Previous native run has no confirmed terminal outcome";
          e.runId = null;
        }
        if (e.state) {
          const restored = { ...e.state, streaming: false, runId: null };
          host.restore(key(id), restored);
          e.state = restored;
        }
        entries.set(id, e);
        return e;
      })().finally(() => { loads.delete(id); });
      loads.set(id, promise);
    }
    return promise;
  };
  const required = async (id: string) => { const e = await load(id); if (!e) throw new Error("Conversation is not open"); return e; };
  const resolve = async (launch: ConversationSelection) => {
    explicitSelection(launch);
    const result = await host.resolveSelection(pluginId, copy(launch));
    explicitSelection(result);
    if (result.engine !== launch.engine || result.providerId !== launch.providerId ||
      /^(default|auto|automatic|latest|best)$/i.test(result.model) ||
      (result.engine === "claude" && /^(opus|sonnet|haiku|fable|opusplan)(\[1m\])?$/i.test(result.model))) {
      throw new Error("Native selection did not resolve an immutable launch identity");
    }
    return copy(result);
  };
  return {
    async catalog() { return copy(await (await ensure()).catalog()); },
    async open(request) {
      object(request, ["threadId", "workspacePath", "selection"]);
      if (!validId(request.threadId) || typeof request.workspacePath !== "string") throw new Error("Invalid conversation request");
      selection(request.selection);
      const input = copy(request);
      await load(input.threadId);
      const previous = opens.get(input.threadId);
      if (previous) await previous;
      const operation = (async () => {
        const workspacePath = await host.workspace(input.workspacePath);
        const existing = entries.get(input.threadId);
        if (existing) {
          if (existing.snapshot.workspacePath !== workspacePath || signature(existing.snapshot.selection) !== signature(input.selection)) throw new Error("Thread workspace and selection are immutable");
          return view(existing);
        }
        checkpoint.assertAllowed();
        const catalog = await host.catalog();
        const engine = catalog.engines.find((e) => e.id === input.selection.engine && e.available);
        if (!engine) throw new Error("Conversation engine is unavailable");
        const launch: ConversationSelection = { ...input.selection,
          model: input.selection.model ?? engine.defaultModel ?? undefined,
          effort: input.selection.effort ?? engine.defaultEffort ?? undefined,
          providerId: input.selection.providerId ?? engine.defaultProviderId };
        explicitSelection(launch);
        if (!engine.models.some((m) => m.id === launch.model)) throw new Error("Unknown conversation model");
        if (!engine.providers.some((p) => p.id === launch.providerId)) throw new Error("Unknown conversation provider");
        const effective = await resolve(launch);
        const e: Entry = { snapshot: { threadId: input.threadId, revision: 0, workspacePath,
          selection: input.selection, effectiveSelection: effective, sessionRef: null, status: "idle", messages: [] },
          launchSelection: launch, runId: null, cancelled: false, memoryFloorSeq: -1 };
        entries.set(input.threadId, e);
        await flush(e); emit(e); return view(e);
      })();
      opens.set(input.threadId, operation);
      try { return await operation; } finally { if (opens.get(input.threadId) === operation) opens.delete(input.threadId); }
    },
    async inspect(id) { return view(await required(id)); },
    async send(request) {
      object(request, ["threadId", "requestId", "expectedRevision", "prompt", "images", "fixedInstructions"]);
      validateFixedInstructions(request.fixedInstructions);
      const imageIds = validateImageIds(request.images);
      if (!validId(request.threadId) || !validId(request.requestId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
        typeof request.prompt !== "string" || (!request.prompt.trim() && imageIds.length === 0) || request.prompt.length > 120000) throw new Error("Invalid conversation send");
      const input = copy(request);
      const e = await required(input.threadId);
      const id = input.threadId;
      const fingerprint = JSON.stringify([input.expectedRevision, input.prompt, ...(imageIds.length > 0 ? [imageIds] : []),
        ...(input.fixedInstructions ? [{ fixedInstructions: fixedInstructionsIdentity(input.fixedInstructions) }] : [])]);
      const submitting = submissions.get(id);
      if (submitting && e.snapshot.lastRequestId !== input.requestId) {
        if (submitting.requestId !== input.requestId) throw new Error("Conversation is busy");
        if (submitting.fingerprint !== fingerprint) throw new Error("requestId was already used with different input");
        return submitting.result;
      }
      if (e.snapshot.lastRequestId === input.requestId) {
        if (e.fingerprint !== fingerprint) throw new Error("requestId was already used with different input");
        return view(e);
      }
      if (preparing.has(id) || active.has(id) || writer(id).saving || ["starting", "running", "unknown"].includes(e.snapshot.status)) throw new Error("Conversation is busy or unknown");
      if (input.expectedRevision !== e.snapshot.revision) throw new Error("Stale conversation revision");
      checkpoint.assertAllowed();
      capture(e, true);
      if (host.read(key(id))?.streaming) throw new Error("Conversation is busy");
      if (e.memoryFloorSeq === undefined || ["failed", "cancelled"].includes(e.snapshot.status)) {
        e.memoryFloorSeq = e.state?.messages.at(-1)?.seq ?? -1;
      }
      preparing.add(id);
      e.cancelled = false;
      const operation = (async () => {
      try {
        await host.workspace(e.snapshot.workspacePath);
        const catalog = await host.catalog();
        if ((input.fixedInstructions || e.fixedInstructions) && catalog.capabilities?.fixedInstructions !== true) throw new Error("Native fixed instructions are unavailable");
        const engine = catalog.engines.find((candidate) => candidate.id === e.launchSelection.engine && candidate.available);
        if (!engine || !engine.models.some((m) => m.id === e.launchSelection.model) ||
          !engine.providers.some((p) => p.id === e.launchSelection.providerId)) throw new Error("Conversation selection is no longer available");
        if (imageIds.length > 0 && engine.supportsImages !== true) throw new Error("Selected conversation engine does not support image attachments");
        const resolved = await resolve(e.launchSelection);
        if (signature(resolved) !== signature(e.snapshot.effectiveSelection)) throw new Error("Conversation selection changed; open a new thread");
        let resolvedImages: string[] = [];
        if (imageIds.length > 0) {
          checkpoint.assertAllowed();
          if (typeof host.resolveImages !== "function") throw new Error("Host conversation facade does not support image attachments");
          const paths = await host.resolveImages(pluginId, imageIds);
          if (!Array.isArray(paths) || paths.length !== imageIds.length || paths.some((p) => typeof p !== "string" || !p.trim())) {
            throw new Error("Failed to resolve conversation image attachments");
          }
          resolvedImages = paths;
        }
        checkpoint.assertAllowed();
        capture(e, true);
        const runId = "sidechat-" + crypto.randomUUID();
        if (input.fixedInstructions) e.fixedInstructions = fixedInstructionsIdentity(input.fixedInstructions);
        terminal.delete(id);
        e.runId = runId; e.fingerprint = fingerprint; e.baseRevision = input.expectedRevision;
        e.snapshot = { ...e.snapshot, revision: e.snapshot.revision + 1, status: "starting", lastRequestId: input.requestId };
        delete e.snapshot.error;
        e.pendingUser = {
          seq: (e.state?.messages.at(-1)?.seq ?? 0) + 1,
          role: "user",
          text: input.prompt.trim(),
          ts: new Date().toISOString(),
          ...(resolvedImages.length > 0 ? { images: resolvedImages } : {}),
        };
        await flush(e);
        if (e.cancelled) {
          e.runId = null; e.pendingUser = undefined; e.snapshot.status = "cancelled";
          await flush(e); emit(e); return view(e);
        }
        checkpoint.assertAllowed();
        // Recheck immediately before invocation, after any awaited durability work.
        capture(e, true);
        active.set(id, { runId, observed: false });
        e.snapshot.status = "running";
        const result = resolvedImages.length > 0
          ? host.send(key(id), e.snapshot.workspacePath, e.snapshot.effectiveSelection, input.prompt, runId, resolvedImages)
          : host.send(key(id), e.snapshot.workspacePath, e.snapshot.effectiveSelection, input.prompt, runId);
        emit(e);
        await result;
        reconcile(e);
        if (e.cancelled && active.has(id)) await host.stop(key(id), runId);
        await flush(e);
        return view(e);
      } catch (error) {
        // Validation before request acceptance leaves the existing revision intact.
        if (e.snapshot.lastRequestId === input.requestId) {
          markUnknown(e, error instanceof Error ? error.message : "Conversation launch could not be confirmed");
          // No blind retry after the mandatory start write failed. If native has
          // started, its later projection/terminal callbacks remain observed.
          if (active.has(id)) reconcile(e);
        }
        throw error;
      } finally { preparing.delete(id); }
      })();
      submissions.set(id, { requestId: input.requestId, fingerprint, result: operation });
      try { return await operation; } finally { submissions.delete(id); }
    },
    async stop(id) {
      const e = await required(id);
      if (!preparing.has(id) && !active.has(id)) return view(e);
      e.cancelled = true;
      const run = active.get(id);
      if (run) await host.stop(key(id), run.runId);
      await flush(e);
      return view(e);
    },
    async openFile(id, path) {
      if (typeof path !== "string" || !path.trim() || path.length > 4096 || /[\u0000-\u001f]/.test(path)) throw new Error("Invalid discussion file link");
      const e = await required(id);
      await host.workspace(e.snapshot.workspacePath);
      checkpoint.assertAllowed();
      await host.openFile(e.snapshot.workspacePath, path);
    },
    onEvent(callback) {
      if (typeof callback !== "function") throw new Error("Conversation callback required");
      listeners.add(callback); return () => { listeners.delete(callback); };
    },
  };
}
