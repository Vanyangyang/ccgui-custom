import type { Disposer, HostTaskConversationsApi, HostTaskConversationSnapshot, HostTaskMessageReceipt, HostTaskMessageRequest, HostTaskReceipt, HostTaskConversationChild } from "@ccgui/plugin-sdk";
import { newId } from "@/lib/id";
import type { PluginStorageBackend } from "./context";
import { TaskPreSpawnError, type HostTaskFacade, type TaskLaunchChoices, type TaskSessionRef, type HostUserRowIdentity } from "./task-facade";
import { sameTaskPath } from "./task-paths";
import type { HostFixedInstructions } from "@ccgui/plugin-sdk";
import { validateFixedInstructions, sameFixedInstructions, fixedInstructionsIdentity, supportsFixedInstructions } from "./fixed-instructions";

const KEY = "__host_tasks_v1:conversations";
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const CHILD_TERMINAL = new Set(["completed", "failed", "stopped", "reclaimed"]);
const RECEIPT_STATUS = new Set(["queued", "starting", "received", "completed", "failed", "cancelled", "unknown"]);
type Owned = { receipt: HostTaskReceipt; proven: boolean; launch?: TaskLaunchChoices; displayText?: string; userRow?: HostUserRowIdentity; fixedInstructions?: HostFixedInstructions };
interface Input { receipt: HostTaskMessageReceipt; fingerprint: string; prompt: string; images: string[]; fenceSeq?: number; resumeStopEpoch?: number; displayText?: string; userRow?: HostUserRowIdentity; fixedInstructions?: HostFixedInstructions }
interface RecordState {
  requestId: string; revision: number; inputRevision: number; sessionRef: TaskSessionRef | null;
  stopping: boolean; stopRunId?: string | null; inputs: Input[];
  fixedInstructions?: HostFixedInstructions;
  stopped?: boolean;
  stopEpoch?: number;
  ownershipError?: string;
  children?: Array<HostTaskConversationChild & { parentRef: TaskSessionRef }>;
}
interface Persisted { version: 1; records: RecordState[] }
export interface TaskConversationDependencies {
  pluginId: string; storage: PluginStorageBackend;
  owned(id: string): Promise<Owned>;
  coordinators?(): string[];
  facade(): Promise<HostTaskFacade>;
  resolveImages(ids: string[]): Promise<string[]>;
  verify?(id: string): Promise<void>;
  blocked?(id: string): boolean;
  hold(id: string, holding: boolean): void | Promise<void>;
  cancelInitial?(id: string): Promise<unknown>;
  paused?(): boolean;
  now?(): number;
  runId?(): string;
}
const owners = new WeakMap<PluginStorageBackend, Map<string, symbol>>();
const chains = new WeakMap<PluginStorageBackend, Map<string, Promise<unknown>>>();
const writes = new WeakMap<PluginStorageBackend, Map<string, Promise<unknown>>>();
function mapFor<T>(map: WeakMap<PluginStorageBackend, Map<string, T>>, key: PluginStorageBackend) {
  let value = map.get(key); if (!value) { value = new Map(); map.set(key, value); } return value;
}
const sameRef = (a: TaskSessionRef, b: TaskSessionRef) => a.engine === b.engine && a.sessionId === b.sessionId && sameTaskPath(a.workspacePath, b.workspacePath);
const validRef = (value: TaskSessionRef | null | undefined): value is TaskSessionRef => !!value &&
  [value.engine, value.sessionId, value.workspacePath].every(v => typeof v === "string" && v.length > 0 && v.length <= 4096);
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const preview = (text?: string) => (text ?? "").slice(0, 280).replace(/[\uD800-\uDBFF]$/, "");
const fingerprintOf = (root: string, id: string, revision: number, prompt: string, images: string[], displayText?: string, fixedInstructions?: HostFixedInstructions) => JSON.stringify([root, id, revision, prompt, images, ...(displayText !== undefined ? [displayText] : []), ...(fixedInstructions ? [{ fixedInstructions: fixedInstructionsIdentity(fixedInstructions) }] : [])]);

/** A bounded durable inbox attached to an already-owned, identity-proven task.
 * The native chat store remains the only transcript and delivery authority. */
export function createTaskConversationBridge(deps: TaskConversationDependencies): HostTaskConversationsApi & {
  ready(): Promise<void>; drain(): Promise<void>; capture(): Persisted; restore(value: unknown): void; wake(): void; dispose(): void; attachedTo(ref: TaskSessionRef): boolean;
} {
  const records = new Map<string, RecordState>();
  const snapshots = new Map<string, HostTaskConversationSnapshot>();
  const messageCopies = new WeakMap<object, { displayText?: string; copy: unknown }>();
  const sequences = new Map<string, number>();
  const listeners = new Set<(snapshot: HostTaskConversationSnapshot) => void>();
  const token = Symbol(deps.pluginId);
  const ownerMap = mapFor(owners, deps.storage);
  const chainMap = mapFor(chains, deps.storage);
  const writeMap = mapFor(writes, deps.storage);
  const cancelledInputs = new Set<string>();
  const stopRequests = new Set<string>();
  ownerMap.set(deps.pluginId, token);
  const now = deps.now ?? Date.now;
  let facade: HostTaskFacade;
  let initialized: Promise<void> | undefined;
  let off: Disposer | undefined;
  let offEvents: Disposer | undefined;
  let disposed = false;
  let restored = false;
  let scheduled = false;
  let wakeAgain = false;
  let fault: string | undefined;
  const assertOwner = () => { if (disposed || ownerMap.get(deps.pluginId) !== token) throw new Error("Conversation owner is unavailable"); };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = (chainMap.get(deps.pluginId) ?? Promise.resolve()).then(() => { assertOwner(); return work(); });
    chainMap.set(deps.pluginId, result.catch(() => undefined)); return result;
  };
  const capture = (): Persisted => structuredClone({ version: 1, records: [...records.values()] });
  const restore = (raw: unknown) => {
    const value = raw as Persisted;
    if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 512) throw new Error("Invalid conversation checkpoint");
    const next = new Map<string, RecordState>();
    for (const r of value.records) {
      validateFixedInstructions(r?.fixedInstructions);
      if (!r || !validId(r.requestId) || next.has(r.requestId) || !Number.isSafeInteger(r.revision) || r.revision < 0 ||
        !Number.isSafeInteger(r.inputRevision) || r.inputRevision < 0 || typeof r.stopping !== "boolean" ||
        !Array.isArray(r.inputs) || r.inputs.length > 160 || (r.sessionRef &&
          [r.sessionRef.engine, r.sessionRef.sessionId, r.sessionRef.workspacePath].some(x => typeof x !== "string" || !x))) throw new Error("Invalid conversation record");
      const ids = new Set<string>();
      for (const i of r.inputs) {
        validateFixedInstructions(i?.fixedInstructions);
        const p = i?.receipt;
        if (!p || !validId(p.requestId) || ids.has(p.requestId) || p.conversationRequestId !== r.requestId || !RECEIPT_STATUS.has(p.status) ||
          !Number.isSafeInteger(p.inputRevision) || p.inputRevision < 1 || p.inputRevision > r.inputRevision ||
          (p.runId !== null && (typeof p.runId !== "string" || !p.runId || p.runId.length > 256)) ||
          ![null, "queued", "turn", "steer", "live"].includes(p.delivery) ||
          (i.fenceSeq !== undefined && (!Number.isSafeInteger(i.fenceSeq) || i.fenceSeq < -1)) ||
          !Number.isFinite(p.acceptedAt) || !Number.isFinite(p.updatedAt) || typeof i.prompt !== "string" || i.prompt.length > 120000 ||
          !Array.isArray(i.images) || i.images.length > 8 || i.images.some(x => !validId(x)) ||
          (i.displayText !== undefined && (typeof i.displayText !== "string" || i.displayText.length > 120000)) ||
          (p.preview !== undefined && p.preview !== preview(i.displayText)) ||
          (i.userRow && (!Number.isSafeInteger(i.userRow.seq) || typeof i.userRow.text !== "string" || i.userRow.runId !== p.runId || (i.userRow.ts !== null && typeof i.userRow.ts !== "string"))) ||
          typeof i.fingerprint !== "string" || i.fingerprint !== fingerprintOf(r.requestId, p.requestId, p.inputRevision - 1, i.prompt, i.images, i.displayText, i.fixedInstructions)) throw new Error("Invalid conversation input fence");
        if (p.sessionRef && (!r.sessionRef || !sameRef(p.sessionRef, r.sessionRef))) throw new Error("Conversation input identity mismatch");
        ids.add(p.requestId);
      }
      if ((r.stopEpoch !== undefined && (!Number.isSafeInteger(r.stopEpoch) || r.stopEpoch < 0)) ||
        r.inputs.some(i => i.resumeStopEpoch !== undefined && (!Number.isSafeInteger(i.resumeStopEpoch) || i.resumeStopEpoch < 0))) throw new Error("Invalid conversation stop epoch");
      if (r.ownershipError !== undefined && (typeof r.ownershipError !== "string" || !r.ownershipError || r.ownershipError.length > 512)) throw new Error("Invalid conversation ownership fence");
      if (r.children !== undefined && (!Array.isArray(r.children) || r.children.length > 4096 || new Set(r.children.map(c => c?.id)).size !== r.children.length ||
        r.children.some(c => !c || !validId(c.id) || typeof c.title !== "string" || typeof c.state !== "string" || !validRef(c.parentRef) || (c.sessionRef !== null && !validRef(c.sessionRef))))) throw new Error("Invalid retained child ownership");
      const restored = structuredClone(r); for (const input of restored.inputs) input.receipt.preview = preview(input.displayText);
      next.set(r.requestId, { ...restored, stopping: r.stopping || r.stopped === true });
    }
    records.clear(); for (const [id, r] of next) records.set(id, r); restored = true;
  };
  const persist = async () => {
    assertOwner();
    const cut = capture();
    const write = (writeMap.get(deps.pluginId) ?? Promise.resolve()).then(() => deps.storage.set(deps.pluginId, KEY, cut));
    writeMap.set(deps.pluginId, write.catch(() => undefined));
    try { await write; }
    catch {
      fault = "Conversation persistence failed; no delivery will be replayed";
      for (const r of records.values()) {
        for (const i of r.inputs) if (!TERMINAL.has(i.receipt.status)) i.receipt = { ...i.receipt, status: "unknown", error: fault, updatedAt: now() };
        await deps.hold(r.requestId, true);
      }
      throw new Error(fault);
    }
  };
  const ensure = () => initialized ??= serial(async () => {
    facade = await deps.facade(); await facade.ready();
    await writeMap.get(deps.pluginId);
    if (!restored) { const saved = await deps.storage.get(deps.pluginId, KEY); if (saved != null) restore(saved); }
    seedCoordinators();
    for (const r of records.values()) {
      for (const input of r.inputs) {
        if (["starting", "received"].includes(input.receipt.status)) {
          // Presence of a run is not proof that this particular input arrived.
          if (input.receipt.status === "starting" || !input.receipt.runId || (!facade.liveRun(input.receipt.runId) && !facade.settledRun(input.receipt.runId, r.sessionRef))) {
            input.receipt = { ...input.receipt, status: "unknown", error: "Delivery outcome could not be confirmed after recovery; not replayed", updatedAt: now() };
          }
        }
      }
    }
    if (records.size) await persist();
    off = facade.subscribe(wake);
    if (facade.listen) offEvents = await facade.listen(events => {
      for (const e of events) {
        const seq = Math.max(sequences.get(e.runId) ?? -1, e.seq);
        sequences.delete(e.runId); sequences.set(e.runId, seq);
        while (sequences.size > 512) sequences.delete(sequences.keys().next().value!);
      }
      void serial(async () => {
        let changed = false;
        for (const event of events) {
          if (event.kind !== "turn_complete") continue;
          for (const r of records.values()) for (const i of r.inputs) {
            if (i.receipt.status !== "received" || i.receipt.runId !== event.runId || !r.sessionRef ||
              event.engine !== r.sessionRef.engine || event.sessionId !== r.sessionRef.sessionId || event.seq <= (i.fenceSeq ?? -1)) continue;
            const interrupted = !!event.data && typeof event.data === "object" && "interrupted" in event.data && event.data.interrupted === true;
            i.receipt = { ...i.receipt, status: interrupted ? "cancelled" : "completed", updatedAt: now() }; changed = true;
          }
        }
        if (changed) await persist();
      }).then(wake).catch(() => {});
    });
  });
  function seedCoordinators() {
    for (const id of deps.coordinators?.() ?? []) if (!records.has(id)) records.set(id, { requestId: id, revision: 0, inputRevision: 0, sessionRef: null, stopping: false, inputs: [] });
  }
  const ownedRecord = async (id: string): Promise<{ record: RecordState; owned: Owned }> => {
    if (!validId(id)) throw new Error("Invalid conversation request id");
    let record = records.get(id);
    let owned: Owned;
    try { owned = await deps.owned(id); }
    catch (error) { if (record) await fenceOwnership(record); throw error; }
    if (!record) {
      if (records.size >= 512) throw new Error("Conversation attachment limit reached");
      record = { requestId: id, revision: 0, inputRevision: 0, sessionRef: null, stopping: false, inputs: [] };
      records.set(id, record);
    }
    if (record.sessionRef && (!owned.proven || !owned.receipt.session || !sameRef(record.sessionRef, owned.receipt.session))) {
      await fenceOwnership(record);
      throw new Error("Immutable conversation identity is no longer proven");
    }
    if (!record.sessionRef && owned.proven && owned.receipt.session) {
      if ([...records.values()].some(other => other !== record && other.sessionRef && sameRef(other.sessionRef, owned.receipt.session!))) throw new Error("Native coordinator is already attached to another initial request");
      record.sessionRef = { ...owned.receipt.session };
    }
    return { record, owned };
  };
  async function fenceOwnership(r: RecordState) {
    const error = "Coordinator identity could not be confirmed; original inputs will not be replayed";
    let changed = r.ownershipError !== error;
    r.ownershipError = error;
    for (const input of r.inputs) if (!TERMINAL.has(input.receipt.status) && input.receipt.status !== "unknown") {
      input.receipt = { ...input.receipt, status: "unknown", error, updatedAt: now() };
      changed = true;
    }
    await deps.hold(r.requestId, true);
    if (!changed) return;
    const previous = snapshots.get(r.requestId);
    r.revision++;
    await persist();
    if (previous) {
      const view = freeze({ ...previous, revision: r.revision, status: "unknown" as const, canSend: false, canChangeSelection: false,
        deliveries: r.inputs.map(input => structuredClone(input.receipt)), error });
      snapshots.set(r.requestId, view);
      for (const callback of listeners) { try { callback(view); } catch { console.error("[plugins] conversation listener failed"); } }
    }
  }
  async function nativeChildren(ref: TaskSessionRef | null, remembered: RecordState["children"] = []) {
    if (!ref) return [];
    const branches = await facade.leaderBranches(true);
    for (const prior of remembered) {
      const current = branches.find(b => b.id === prior.id);
      if (current && (!sameRef(prior.parentRef, { engine: current.parentEngine, sessionId: current.parentSessionId, workspacePath: current.parentWorkspacePath ?? current.workspacePath }) ||
        (prior.sessionRef && current.sessionId && !sameRef(prior.sessionRef, { engine: current.engine, sessionId: current.sessionId, workspacePath: current.workspacePath })))) throw new Error("Native child identity or ownership changed");
    }
    // Retained, natively proven child identities preserve descendant reachability
    // when an intermediate branch is absent from a later snapshot.
    const pending = [ref, ...remembered.flatMap(c => c.sessionRef && c.state !== "reclaimed" ? [c.sessionRef] : [])];
    const parents = new Set<string>();
    const result: Array<{ branch: (typeof branches)[number]; parent: TaskSessionRef }> = [];
    const seen = new Set<string>();
    for (let at = 0; at < pending.length; at++) {
      const parent = pending[at];
      const parentKey = JSON.stringify([parent.engine, parent.sessionId, parent.workspacePath]);
      if (parents.has(parentKey)) continue;
      parents.add(parentKey);
      for (const branch of branches.filter(b => b.parentEngine === parent.engine && b.parentSessionId === parent.sessionId &&
        sameTaskPath(b.parentWorkspacePath ?? b.workspacePath, parent.workspacePath))) {
        if (!branch.id || seen.has(branch.id)) throw new Error("Invalid native child ownership graph");
        seen.add(branch.id); result.push({ branch, parent });
        if (branch.sessionId && branch.state !== "reclaimed") pending.push({ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath });
      }
    }
    return result;
  }
  async function children(r: RecordState): Promise<HostTaskConversationChild[]> {
    const current: NonNullable<RecordState["children"]> = (await nativeChildren(r.sessionRef, r.children)).map(({ branch: b, parent }) => {
      if (!b.id) throw new Error("Native child identity is unavailable");
      return { id: b.id, title: b.title ?? b.id, state: b.state as string, parentRef: { ...parent },
        sessionRef: b.sessionId ? { engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath } : null,
        ...(b.delegation ? { delegation: { requestId: b.delegation.requestId, state: b.delegation.state,
          ...(b.delegation.result ? { result: b.delegation.result.slice(0, 6000) } : {}) } } : {}),
      };
    });
    for (const previous of r.children ?? []) if (!current.some(child => child.id === previous.id)) current.push({ ...previous, state: CHILD_TERMINAL.has(previous.state) ? previous.state : "unknown" });
    if (current.length > 4096) throw new Error("Retained child ownership capacity reached");
    r.children = current;
    return current.map(({ parentRef: _parent, ...child }) => child);
  }
  async function project(r: RecordState, owned: Owned): Promise<HostTaskConversationSnapshot> {
    let error = fault ?? r.ownershipError;
    let childRows: HostTaskConversationChild[] = [];
    try { childRows = await children(r); } catch { error = "Native child ownership could not be confirmed"; childRows = snapshots.get(r.requestId)?.children ?? (r.children ?? []).map(({ parentRef: _parent, ...child }) => child); }
    const state = r.sessionRef ? facade.conversationState?.(r.sessionRef) : null;
    const unresolved = r.inputs.some(i => i.receipt.status === "unknown" || i.receipt.status === "starting");
    const pending = r.inputs.some(i => !TERMINAL.has(i.receipt.status));
    const childActive = childRows.some(c => !CHILD_TERMINAL.has(c.state));
    let status: HostTaskConversationSnapshot["status"] = "idle";
    if (error || unresolved || childRows.some(c => c.state === "unknown") || owned.receipt.status === "unknown" || (r.sessionRef && !state)) status = "unknown";
    else if (!r.sessionRef) status = owned.receipt.status === "failed" ? "failed" : owned.receipt.status === "cancelled" ? "cancelled" : "starting";
    else if (r.stopping) {
      const settled = r.stopRunId ? facade.settledRun(r.stopRunId, r.sessionRef) : null;
      status = !childActive && !pending && state?.status === "idle" && (!r.stopRunId || settled) ? "cancelled" : "stopping";
    } else if (state?.status === "awaiting_permission") status = "waiting";
    else if (state?.status === "busy" || pending || childActive) status = "running";
    else if (r.stopped) status = "cancelled";
    const latestDelivery = r.inputs.at(-1)?.receipt;
    if (status === "idle" && (latestDelivery ? latestDelivery.status === "failed" : owned.receipt.status === "failed")) status = "failed";
    const displayedError = error ?? (status === "failed" ? latestDelivery?.error ?? owned.receipt.error : undefined);
    // The stop fence remains armed after settlement. It is separate from the
    // current write claim and from the permanent native-session reservation.
    // A late owned child reacquires this scope as soon as it is observed.
    const holding = !["idle", "failed", "cancelled"].includes(status);
    await deps.hold(r.requestId, holding);
    const previous = snapshots.get(r.requestId);
    const displays = [owned, ...r.inputs].filter(item => item.displayText !== undefined && item.userRow);
    const displaysBySeq = new Map<number, typeof displays>();
    for (const display of displays) { const seq = display.userRow!.seq; displaysBySeq.set(seq, [...(displaysBySeq.get(seq) ?? []), display]); }
    const view: HostTaskConversationSnapshot = { requestId: r.requestId, revision: r.revision, inputRevision: r.inputRevision,
      workspacePath: owned.receipt.workspacePath, sessionRef: r.sessionRef ? { ...r.sessionRef } : null,
      selection: owned.receipt.requestedSelection && { ...owned.receipt.requestedSelection }, effectiveSelection: owned.receipt.effectiveSelection && { ...owned.receipt.effectiveSelection },
      status, messages: (state?.messages ?? []).map(message => {
        const matching = message.role === "user" ? (displaysBySeq.get(message.seq) ?? []).filter(({ userRow: row }) => row!.ts === message.ts && row!.text === message.text &&
          JSON.stringify(row!.images ?? []) === JSON.stringify(message.images ?? [])) : [];
        const displayText = matching.length === 1 ? matching[0].displayText : undefined;
        let cached = messageCopies.get(message);
        if (!cached || cached.displayText !== displayText) {
          const copy = structuredClone(message) as typeof message & { displayText?: string };
          delete copy.displayText; if (displayText !== undefined) copy.displayText = displayText;
          cached = { displayText, copy: freeze(copy) }; messageCopies.set(message, cached);
        }
        return cached.copy;
      }), deliveries: r.inputs.map(i => structuredClone(i.receipt)), children: childRows,
      stopRequested: r.stopping,
      canSend: !!r.sessionRef && !!state && (!r.stopping || status === "cancelled") && status !== "unknown" && !fault,
      canChangeSelection: !holding, ...(displayedError ? { error: displayedError } : {}),
    };
    const sameMessages = previous?.messages.length === view.messages.length && view.messages.every((message, index) => previous.messages[index] === message);
    // Never stringify the native transcript on every streaming update. Cached
    // immutable rows retain identity; only bounded receipt/child metadata needs
    // structural comparison here.
    if (!previous || !sameMessages || JSON.stringify({ ...previous, revision: 0, messages: undefined }) !== JSON.stringify({ ...view, revision: 0, messages: undefined })) {
      view.revision = ++r.revision; await persist(); freeze(view); snapshots.set(r.requestId, view);
      for (const callback of listeners) { try { callback(view); } catch { console.error("[plugins] conversation listener failed"); } }
    } else return previous;
    return view;
  }
  async function reconcile(r: RecordState) {
    for (const i of r.inputs) {
      const p = i.receipt;
      // An unknown delivery never becomes completed merely because the run ended.
      if (p.status !== "received" || !p.runId || !r.sessionRef) continue;
      const proof = facade.settledRun(p.runId, r.sessionRef);
      if (proof) i.receipt = { ...p, status: proof.status, updatedAt: now(), ...(proof.error ? { error: proof.error } : {}) };
    }
  }
  async function pump() {
    seedCoordinators();
    for (const r of records.values()) {
      assertOwner();
      let owned: Owned;
      try { ({ owned } = await ownedRecord(r.requestId)); }
      catch (error) {
        // A shared persistence failure still fences the whole inbox; an ownership
        // failure belongs only to this immutable coordinator and its write scope.
        if (fault) throw error;
        continue;
      }
      await reconcile(r);
      if (r.stopping && !deps.paused?.()) await stopChildren(r);
      let view = await project(r, owned);
      const input = r.inputs.find(i => i.receipt.status === "queued");
      const resumesStop = !!input && r.stopping && input.resumeStopEpoch === (r.stopEpoch ?? 0);
      const canResume = resumesStop && view.status !== "unknown" && view.children.every(c => CHILD_TERMINAL.has(c.state)) && !!r.sessionRef && facade.conversationState?.(r.sessionRef)?.status === "idle";
      if (deps.paused?.() || fault || (!view.canSend && !canResume) || !r.sessionRef || r.inputs.some(i => ["unknown", "starting"].includes(i.receipt.status))) continue;
      if (!input || deps.blocked?.(r.requestId) || !facade.conversationState?.(r.sessionRef)?.canDeliver || !facade.continueMessage) continue;
      const currentInstructions = r.fixedInstructions ?? owned.fixedInstructions;
      const nextInstructions = input.fixedInstructions ?? currentInstructions;
      const instructionsChanged = !sameFixedInstructions(currentInstructions, nextInstructions);
      // A live/steered input cannot replace a running CLI's system context.
      // Retain the accepted input until a full native launch can apply it.
      if (instructionsChanged && facade.conversationState?.(r.sessionRef)?.status !== "idle") continue;
      try {
        if (nextInstructions && !await facade.fixedInstructionsSupported?.()) throw new TaskPreSpawnError("Native fixed instructions are unavailable");
        const images = await deps.resolveImages(input.images);
        const result = await facade.continueMessage(r.sessionRef, input.prompt, images, (deps.runId ?? (() => `run-${newId()}`))(), async (delivery, runId) => {
          const deliveryPaused = () => input.receipt.status === "cancelled" || (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) || cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`) || deps.paused?.();
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          await ownedRecord(r.requestId);
          await deps.verify?.(r.requestId);
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (deps.blocked?.(r.requestId)) throw new TaskPreSpawnError("Conversation scope is held by another native task");
          if (r.stopping && (await children(r)).some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
          if (instructionsChanged && delivery !== "turn") throw new TaskPreSpawnError("Updated fixed instructions require a new native turn");
          if (delivery === "turn" && nextInstructions) r.fixedInstructions = fixedInstructionsIdentity(nextInstructions);
          input.fenceSeq = sequences.get(runId) ?? -1;
          input.receipt = { ...input.receipt, status: "starting", delivery, runId, sessionRef: { ...r.sessionRef! }, updatedAt: now() };
          await persist();
          assertOwner(); if (deliveryPaused()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (r.stopping && (await children(r)).some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
        }, owned.launch, ...(input.displayText !== undefined ? [async (row: HostUserRowIdentity) => {
          assertOwner(); if (row.runId !== input.receipt.runId) throw new TaskPreSpawnError("Native user row belongs to another input run");
          input.userRow = structuredClone(row); await persist();
          assertOwner();
          if (input.receipt.status === "cancelled" || (r.stopping && input.resumeStopEpoch !== (r.stopEpoch ?? 0)) || deps.paused?.()) throw new TaskPreSpawnError("Conversation delivery paused");
          if (r.stopping && (await children(r)).some(c => !CHILD_TERMINAL.has(c.state))) throw new TaskPreSpawnError("Owned children have not settled; stop intent retained");
        }] : []));
        input.receipt = { ...input.receipt, status: "received", delivery: result.delivery, runId: result.runId, updatedAt: now(), error: undefined };
        if (r.stopping && input.resumeStopEpoch === (r.stopEpoch ?? 0)) {
          r.stopping = false; r.stopped = false; r.stopRunId = undefined;
          for (const key of stopRequests) if (key.startsWith(`${r.requestId}\u0000`)) stopRequests.delete(key);
        }
        if (r.stopping) {
          r.stopRunId = result.runId;
          await persist();
          await facade.interrupt(result.runId);
        }
      } catch (error) {
        input.receipt = { ...input.receipt, status: error instanceof TaskPreSpawnError ? (input.receipt.status === "cancelled" || r.stopping || cancelledInputs.has(`${r.requestId}\u0000${input.receipt.requestId}`) ? "cancelled" : "queued") : input.receipt.status === "queued" ? "failed" : "unknown",
          updatedAt: now(), error: error instanceof Error ? error.message : "Continuation delivery failed" };
      }
      await reconcile(r); await persist(); view = await project(r, owned);
    }
  }
  function wake() {
    if (disposed || !initialized) return;
    if (scheduled) { wakeAgain = true; return; }
    scheduled = true;
    void ensure().then(() => serial(pump)).catch(async () => {
      if (disposed || ownerMap.get(deps.pluginId) !== token) return;
      fault ??= "Conversation ownership or delivery reconciliation failed; execution remains held";
      for (const r of records.values()) {
        await deps.hold(r.requestId, true);
        const previous = snapshots.get(r.requestId);
        if (!previous) continue;
        const unknown = freeze({ ...previous, revision: ++r.revision, status: "unknown" as const, canSend: false, canChangeSelection: false, error: fault });
        snapshots.set(r.requestId, unknown);
        for (const callback of listeners) { try { callback(unknown); } catch { console.error("[plugins] conversation listener failed"); } }
      }
      await persist().catch(() => { console.error("[plugins] conversation recovery fence could not be persisted"); });
    }).catch(() => { console.error("[plugins] conversation ownership fence could not be persisted"); }).finally(() => {
      scheduled = false; if (wakeAgain) { wakeAgain = false; wake(); }
    });
  }
  const inspect = async (id: string) => { const { record, owned } = await ownedRecord(id); await reconcile(record); if (record.stopping && !deps.paused?.()) await stopChildren(record); const view = await project(record, owned); await persist(); return view; };
  return {
    async ready() { await ensure(); },
    attachedTo(ref) { return [...records.values()].some(r => r.sessionRef && sameRef(r.sessionRef, ref)); },
    async drain() { await ensure(); await serial(pump); }, capture, restore, wake,
    async conversation(id) { await ensure(); return serial(async () => { const { record } = await ownedRecord(id); if (record.sessionRef) await facade.openBackground(record.sessionRef); return inspect(id); }); },
    async sendMessage(request: HostTaskMessageRequest) {
      validateFixedInstructions(request?.fixedInstructions);
      if (!request || !validId(request.requestId) || !Number.isSafeInteger(request.expectedInputRevision) || request.expectedInputRevision < 0 ||
        typeof request.prompt !== "string" || request.prompt.length > 120000 || (!request.prompt.trim() && !request.images?.length) ||
        (request.displayText !== undefined && (typeof request.displayText !== "string" || request.displayText.length > 120000)) ||
        (request.images !== undefined && (!Array.isArray(request.images) || request.images.length > 8 || request.images.some(id => !validId(id))))) throw new Error("Invalid continuation request");
      request = structuredClone(request);
      await ensure();
      const receipt = await serial(async () => {
        const { record: r, owned } = await ownedRecord(request.conversationRequestId);
        const fingerprint = fingerprintOf(r.requestId, request.requestId, request.expectedInputRevision, request.prompt, request.images ?? [], request.displayText, request.fixedInstructions);
        const previous = r.inputs.find(i => i.receipt.requestId === request.requestId);
        if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Continuation request fingerprint differs"); return structuredClone(previous.receipt); }
        if (request.fixedInstructions && (!r.sessionRef || !supportsFixedInstructions(r.sessionRef.engine) || !await facade.fixedInstructionsSupported?.())) throw new Error("Native fixed instructions are unavailable");
        if (r.inputRevision !== request.expectedInputRevision) throw new Error("Conversation input revision conflict");
        if (r.sessionRef) await facade.openBackground(r.sessionRef);
        if (deps.paused?.() || !(await project(r, owned)).canSend) throw new Error("Conversation cannot accept input in its current state");
        if (r.inputs.filter(i => !TERMINAL.has(i.receipt.status)).length >= 32) throw new Error("Conversation pending input limit reached");
        const time = now();
        const receipt: HostTaskMessageReceipt = { conversationRequestId: r.requestId, requestId: request.requestId,
          inputRevision: ++r.inputRevision, preview: preview(request.displayText), status: "queued", delivery: "queued", runId: null, sessionRef: r.sessionRef && { ...r.sessionRef }, acceptedAt: time, updatedAt: time };
        r.inputs.push({ receipt, fingerprint, prompt: request.prompt, images: [...(request.images ?? [])], ...(request.displayText !== undefined ? { displayText: request.displayText } : {}), ...(request.fixedInstructions ? { fixedInstructions: fixedInstructionsIdentity(request.fixedInstructions) } : {}), ...(r.stopping ? { resumeStopEpoch: r.stopEpoch ?? 0 } : {}) });
        while (r.inputs.length > 128) { const at = r.inputs.findIndex(i => TERMINAL.has(i.receipt.status)); if (at < 0) break; r.inputs.splice(at, 1); }
        await deps.hold(r.requestId, true); await persist(); await project(r, owned); return structuredClone(receipt);
      });
      wake(); return receipt;
    },
    async messageReceipt(id, requestId) { await ensure(); return serial(async () => { const { record } = await ownedRecord(id); await reconcile(record); await persist(); return structuredClone(record.inputs.find(i => i.receipt.requestId === requestId)?.receipt ?? null); }); },
    async cancelMessage(id, requestId) { await ensure();
      if (records.get(id)?.inputs.some(i => i.receipt.requestId === requestId)) cancelledInputs.add(`${id}\u0000${requestId}`);
      return serial(async () => {
      const { record: r, owned } = await ownedRecord(id); const input = r.inputs.find(i => i.receipt.requestId === requestId);
      if (!input) return null;
      if (input.receipt.status === "queued") { input.receipt = { ...input.receipt, status: "cancelled", updatedAt: now(), error: undefined }; await persist(); await project(r, owned); }
      cancelledInputs.delete(`${id}\u0000${requestId}`); return structuredClone(input.receipt);
    }); },
    async stopConversation(id) { await ensure();
      const { record: r, owned } = await ownedRecord(id); r.stopping = true;
      r.stopEpoch = (r.stopEpoch ?? 0) + 1;
      for (const input of r.inputs) if (input.receipt.status === "queued") input.receipt = { ...input.receipt, status: "cancelled", updatedAt: now() };
      r.stopRunId = r.sessionRef ? facade.conversationState?.(r.sessionRef)?.runId : owned.receipt.runId;
      await persist();
      const errors: string[] = [];
      if (!r.sessionRef) { try { await deps.cancelInitial?.(id); } catch { errors.push("Initial task stop failed"); } }
      if (r.stopRunId) { try { assertOwner(); await facade.interrupt(r.stopRunId); } catch { errors.push("Coordinator stop failed"); } }
      errors.push(...await stopChildren(r, true));
      await reconcile(r); const view = await project(r, owned); return errors.length ? { ...view, error: errors.join("; ") } : view;
    },
    async conversationAction(id, action) { await ensure(); return serial(async () => {
      const { record: r } = await ownedRecord(id); const view = await inspect(id);
      assertOwner();
      if (deps.paused?.()) throw new Error("Conversation actions are paused");
      if (!action || action.conversationRequestId !== id || !Number.isSafeInteger(action.expectedRevision) || action.expectedRevision !== view.revision || !r.sessionRef) throw new Error("Stale conversation action");
      if (action.type === "openChild") {
        const child = view.children.find(c => c.id === action.childId); if (!child?.sessionRef) throw new Error("Owned native child is not available");
        await facade.focus(child.sessionRef);
      } else { if (!facade.conversationAction) throw new Error("Native conversation action unavailable"); await facade.conversationAction(r.sessionRef, action); }
      return inspect(id);
    }); },
    onConversationEvent(callback) { assertOwner(); if (typeof callback !== "function") throw new Error("Conversation callback required"); listeners.add(callback); void ensure().then(wake).catch(() => {}); return () => { listeners.delete(callback); }; },
    dispose() { disposed = true; off?.(); offEvents?.(); listeners.clear(); },
  };

  async function stopChildren(r: RecordState, retry = false): Promise<string[]> {
    const errors: string[] = [];
    // Capture proof before issuing stop: a native stop may remove the row from
    // the next snapshot. Removal alone is not terminal proof.
    await children(r);
    for (const { branch: child, parent } of (await nativeChildren(r.sessionRef, r.children)).reverse()) if (!CHILD_TERMINAL.has(child.state)) {
      const key = `${r.requestId}\u0000${child.id}\u0000${child.runId ?? ""}`;
      if (!retry && stopRequests.has(key)) continue;
      stopRequests.add(key);
      try {
        assertOwner(); if (!facade.stopChild || !child.id) throw new Error();
        const proof = await facade.stopChild(parent, child.id);
        if (proof && proof.id === child.id && proof.runId === child.runId && proof.parentEngine === parent.engine && proof.parentSessionId === parent.sessionId &&
          sameTaskPath(proof.parentWorkspacePath ?? proof.workspacePath, parent.workspacePath) && CHILD_TERMINAL.has(proof.state)) {
          r.children = r.children?.map(c => c.id === child.id ? { ...c, state: proof.state } : c);
          await persist();
        }
      } catch { errors.push(`Child stop could not be confirmed: ${child.id}`); }
    }
    return errors;
  }
}
