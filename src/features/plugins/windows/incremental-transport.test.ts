import { afterEach, describe, expect, it, vi } from "vitest";
import { createDetachedSurfaceOwner } from "./owner";
import { createDetachedSurfaceClient } from "./client";
import { createSnapshotUpdate } from "./json-snapshot";
import { EVENTS, type DetachedSnapshot, type DetachedTransport, type JsonValue, type SnapshotUpdate } from "./protocol";
import { abortRuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { usePluginTabsStore } from "../runtime/center-tabs";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turns = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const labels = { returnToMain: "Return", ownerUnavailable: "Unavailable", actionFailed: "Failed", loading: "Loading" };
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  usePluginTabsStore.setState({ tabs: [], activeId: null }); abortRuntimeCheckpoint();
});

/** Serialized in-memory transport, not a native/Rust performance measurement.
 * The fake host independently applies patch paths and keeps sequence/receipt
 * records. The production JS codec generates outgoing deltas; Rust validation,
 * permissions, IPC timing and bounded native retention need their own tests. */
function fixture(initial: JsonValue = { draft: "", history: ["retained"] }) {
  type Pending = { key: string; knownRevision: number; reply: ReturnType<typeof deferred<any>>; result?: any; unknown?: boolean };
  const handlers = new Map<string, Set<(event: { payload: any }) => void>>();
  const records = new Map<number, Pending>(), versions = new Map<number, DetachedSnapshot>();
  const wire: Array<{ channel: string; bytes: number; text: string }> = [];
  const commands: Array<{ command: string; request: any }> = [];
  let state = initial, changed = () => {}, dark = false, nativeDark = false;
  let opened: any, native: DetachedSnapshot, nextSequence = 1, fullBarrier = 0;
  let dropEvents = false;
  let afterPublish: (() => Promise<void>) | undefined;
  let snapshotGate: Promise<void> | undefined;
  let dispatchGate: Promise<void> | undefined;
  let receiptTransform: ((receipt: any) => any) | undefined;
  let actionReplyFailure = false;
  let inspectionOverride: ((sequence: number) => any) | undefined;
  const cross = <T>(channel: string, value: T): T => {
    const text = JSON.stringify(value);
    wire.push({ channel, text, bytes: new TextEncoder().encode(text).length });
    return JSON.parse(text);
  };
  const identity = () => ({ windowId: "window", registrationId: opened.registrationId });
  const emit = (event: string, value: unknown) => {
    const payload = cross(`event:${event}`, value);
    for (const callback of handlers.get(event) ?? []) callback({ payload });
  };
  const snapshotEvent = () => ({ ...identity(), snapshot: native, dark: nativeDark });
  const same = (request: any) => request.windowId === "window" && request.registrationId === opened.registrationId;
  const save = (snapshot: DetachedSnapshot) => { native = snapshot; versions.set(snapshot.revision, snapshot); };
  function applyNative(update: SnapshotUpdate) {
    if (update.kind === "full") {
      if (update.snapshot.revision === native.revision && JSON.stringify(update.snapshot.state) !== JSON.stringify(native.state)) throw "plugin_window_snapshot_revision_conflict";
      if (update.snapshot.revision > native.revision) { save(update.snapshot); fullBarrier = native.revision; }
      return;
    }
    if (update.kind === "unchanged") {
      if (update.revision > native.revision) throw "plugin_window_snapshot_base_mismatch";
      return;
    }
    if (update.revision < native.revision) return;
    if (update.revision === native.revision) {
      // A publication and its receipt may carry the same patch concurrently.
      for (const change of update.changes) {
        let parent: any = native.state;
        for (const part of change.path.slice(0, -1)) parent = parent[part];
        const key = change.path.at(-1)!;
        const value = change.path.length ? parent[key] : parent;
        if (change.op === "set" ? JSON.stringify(value) !== JSON.stringify(change.value) : Object.hasOwn(parent, key)) throw "plugin_window_snapshot_revision_conflict";
      }
      return;
    }
    if (update.baseRevision !== native.revision) throw "plugin_window_snapshot_base_mismatch";
    // This deliberately does not call applySnapshotUpdate: the receiver model
    // independently applies the plain serialized operations to its own state.
    const apply = (value: any, path: (string | number)[], op: "set" | "remove", replacement?: JsonValue): any => {
      if (!path.length) return replacement;
      const [key, ...rest] = path;
      if (!value || typeof value !== "object") throw new Error("invalid native path");
      const next = Array.isArray(value) ? [...value] : { ...value };
      if (!rest.length && op === "remove") delete next[key];
      else Object.defineProperty(next, key, { value: apply(value[key], rest, op, replacement), enumerable: true, writable: true, configurable: true });
      return next;
    };
    let value = native.state;
    for (const change of update.changes) value = apply(value, change.path, change.op, change.op === "set" ? change.value : undefined);
    save({ revision: update.revision, state: value });
  }
  // Rust clears its bounded delta log at a full update. Model that recovery
  // barrier; this fixture does not model native byte/count-based log eviction.
  const outgoing = (knownRevision: number): SnapshotUpdate => createSnapshotUpdate(knownRevision < fullBarrier ? undefined : versions.get(knownRevision), native);
  const receipt = (sequence: number, knownRevision: number) => {
    const record = records.get(sequence)!;
    return { ...record.result, sequence, ...(record.unknown ? { unknown: true } : {}), update: outgoing(knownRevision) };
  };
  const transport: DetachedTransport = {
    async listen(event, callback) {
      const set = handlers.get(event) ?? new Set(); handlers.set(event, set); set.add(callback);
      return () => { set.delete(callback); };
    },
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const passed = cross(`request:${command}`, args ?? {}), request: any = passed.request;
      commands.push({ command, request });
      let value: any = null;
      switch (command) {
        case "plugin_window_capabilities": value = { snapshotDelta: 1 }; break;
        case "plugin_window_presentation_register": break;
        case "plugin_window_open":
          opened = request; save(request.snapshot); nativeDark = request.dark;
          value = { ...identity(), label: "window" }; break;
        case "plugin_window_init":
          value = { ...opened, ...identity(), label: "window", incremental: true, snapshot: native, dark: nativeDark,
            nextSequence, unresolvedSequences: [...records].filter(([, record]) => !record.result || record.unknown).map(([sequence]) => sequence) }; break;
        case "plugin_window_publish_update":
        case "plugin_window_respond_update": {
          if (!same(request) || request.ownerToken !== opened.ownerToken) throw new Error("native owner identity mismatch");
          const before = native.revision;
          applyNative(request.update);
          if (command === "plugin_window_publish_update") {
            const darkChanged = nativeDark !== request.dark;
            nativeDark = request.dark;
            if (!dropEvents && (before !== native.revision || darkChanged)) emit(EVENTS.snapshot, { ...identity(), update: request.update, dark: nativeDark });
            if (afterPublish) await afterPublish();
          } else {
            const record = records.get(request.sequence);
            if (!record) throw "plugin_window_action_not_pending_or_expired";
            record.result = { ok: request.ok, value: request.value, ...(request.error ? { error: request.error } : {}) };
            record.reply.resolve(undefined);
            if (!dropEvents && before !== native.revision) emit(EVENTS.snapshot, { ...identity(), update: request.update, dark: nativeDark });
          }
          value = { revision: native.revision }; break;
        }
        case "plugin_window_action_update": {
          if (!same(request)) throw new Error("native detached identity mismatch");
          if (request.knownRevision > native.revision) throw "plugin_window_snapshot_base_mismatch";
          const key = JSON.stringify(request.action);
          let record = records.get(request.sequence);
          if (record && record.key !== key) throw "plugin_window_action_payload_conflict";
          if (!record) {
            if (request.sequence !== nextSequence) throw "plugin_window_action_out_of_order";
            nextSequence++;
            record = { key, knownRevision: request.knownRevision, reply: deferred<any>() }; records.set(request.sequence, record);
            emit(EVENTS.action, { ...identity(), ownerToken: opened.ownerToken, sequence: request.sequence, action: request.action });
          }
          if (actionReplyFailure) { actionReplyFailure = false; throw new Error("lost action transport while original request is pending"); }
          await record.reply.promise;
          value = receipt(request.sequence, request.knownRevision);
          if (receiptTransform) { const transform = receiptTransform; receiptTransform = undefined; value = transform(value); }
          break;
        }
        case "plugin_window_inspect_action_update": {
          const record = records.get(request.sequence);
          if (inspectionOverride) value = inspectionOverride(request.sequence);
          else if (!record?.result) value = { ...identity(), sequence: request.sequence, state: record ? "pending" : "missing" };
          else { record.unknown = false; value = { ...identity(), sequence: request.sequence, state: "resolved", receipt: receipt(request.sequence, request.knownRevision) }; }
          break;
        }
        case "plugin_window_snapshot": if (snapshotGate) await snapshotGate; value = snapshotEvent(); break;
        case "plugin_window_status": value = { ownerAvailable: true, closing: false }; break;
        case "plugin_window_return": emit(EVENTS.returned, { ...identity(), ownerToken: opened.ownerToken, tabId: "tab", reason: request.reason }); break;
        case "plugin_window_request_return": emit(EVENTS.closeRequested, { ...identity(), reason: request.reason ?? "return" }); break;
        case "plugin_window_owner_alive": case "plugin_window_dispose": case "plugin_window_presentation_set": case "plugin_window_cancel_return": break;
        default: throw new Error(`unexpected transport command: ${command}`);
      }
      return cross(`response:${command}`, value) as T;
    },
  };
  const dispatch = vi.fn(async (action: { name: string; args: JsonValue[] }) => {
    if (dispatchGate) await dispatchGate;
    state = { ...(state as Record<string, JsonValue>), draft: action.args[0] }; changed(); return action.args[0];
  });
  const owner = createDetachedSurfaceOwner({ pluginId: "test", tabId: "tab", title: () => "Title", rendererExport: "Detached",
    assets: { code: "code", css: "" }, getSnapshot: () => state, subscribe: callback => { changed = callback; return () => { changed = () => {}; }; },
    dispatch, onReturn: () => {}, labels, dark: () => dark, transport });
  disposers.push(owner.dispose);
  const client = () => { const value = createDetachedSurfaceClient({ transport }); disposers.push(value.dispose); return value; };
  return { owner, client, transport, wire, commands, dispatch, records, emit, identity, snapshotEvent,
    getNative: () => native, getState: () => state, setState(value: JsonValue) { state = value; changed(); },
    setDark(value: boolean) { dark = value; changed(); },
    dropEvents(value = true) { dropEvents = value; },
    holdPublication(hook?: () => Promise<void>) { afterPublish = hook; },
    holdSnapshot(gate?: Promise<void>) { snapshotGate = gate; },
    holdDispatch(gate?: Promise<void>) { dispatchGate = gate; },
    transformReceipt(transform: (value: any) => any) { receiptTransform = transform; },
    loseNextAck() { actionReplyFailure = true; },
    inspectWith(hook?: (sequence: number) => any) { inspectionOverride = hook; },
    resetWire() { wire.length = 0; commands.length = 0; },
  };
}

describe("incremental owner/client integration over serialized memory transport", () => {
  it("opens and edits a conversation larger than eight MiB without resending its history", async () => {
    const original = "原文👩🏽‍💻\n```ts\nconst a = '中';\n```\n" + "x".repeat(8 * 1024 * 1024 + 1024);
    const history: JsonValue[] = [Object.freeze({ role: "assistant", text: original })];
    Object.freeze(history);
    const f = fixture({ draft: "", history });
    await f.owner.open(); const c = f.client(); await c.init();
    expect(((c.getSnapshot()!.state as any).history[0]).text).toBe(original);
    f.resetWire();
    const result = await c.dispatch({ name: "draft", args: ["继续🌏"] });
    await c.flush(); await turns();
    expect(result.value).toBe("继续🌏");
    expect((c.getSnapshot()!.state as any).draft).toBe("继续🌏");
    expect(((c.getSnapshot()!.state as any).history[0]).text).toBe(original);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(Math.max(...f.wire.map(row => row.bytes))).toBeLessThan(4096);
  }, 30000);

  it("keeps 24 FIFO Unicode edits bounded after warming a frozen history larger than 2 MiB", async () => {
    const history: JsonValue[] = [Object.freeze({ text: "HISTORY_SENTINEL:" + "原".repeat(710000) })];
    Object.freeze(history);
    const f = fixture({ draft: "", history }); await f.owner.open(); const c = f.client(); await c.init();
    const old = c.getSnapshot()!, initialBytes = new TextEncoder().encode(JSON.stringify(history)).length;
    expect(initialBytes).toBeGreaterThan(2 * 1024 * 1024); f.resetWire();
    const edits = Array.from({ length: 24 }, (_, index) => "中文🌏".repeat(index + 1));
    const results = await Promise.all(edits.map(text => c.dispatch({ name: "draft", args: [text] })));
    await c.flush(); await turns();
    expect(f.dispatch.mock.calls.map(([action]) => action.args[0])).toEqual(edits);
    expect(results.map(result => result.sequence)).toEqual(edits.map((_, i) => i + 1));
    expect((c.getSnapshot()!.state as any).draft).toBe(edits.at(-1));
    expect((old.state as any).draft).toBe(""); expect(Object.isFrozen((old.state as any).history)).toBe(true);
    expect(f.commands.filter(row => row.command === "plugin_window_snapshot")).toHaveLength(0);
    expect(f.wire.every(row => !row.text.includes("HISTORY_SENTINEL"))).toBe(true);
    expect(Math.max(...f.wire.map(row => row.bytes))).toBeLessThan(4096);
    expect(f.commands.filter(row => /(?:publish|respond)_update$/.test(row.command)).every(row => row.request.update.kind !== "full")).toBe(true);
  }, 15000);

  it("lets receipt completion overtake a slow publication and repairs its stale encoding base without replay", async () => {
    const history = ["retained".repeat(1000)]; Object.freeze(history);
    const f = fixture({ draft: "", history }); await f.owner.open(); const c = f.client(); await c.init(); f.resetWire();
    const gate = deferred<void>(); let held = false;
    f.holdPublication(async () => { if (!held) { held = true; await gate.promise; } });
    f.setState({ draft: "published before ACK", history });
    await vi.waitFor(() => expect(held).toBe(true));
    const result = await c.dispatch({ name: "draft", args: ["receipt先完成🌏"] });
    expect(result.value).toBe("receipt先完成🌏"); expect(f.dispatch).toHaveBeenCalledOnce();
    const replies = f.commands.filter(row => row.command === "plugin_window_respond_update");
    expect(replies.map(row => row.request.update.kind)).toEqual(["patch", "full"]);
    gate.resolve(); await turns();
    expect((c.getSnapshot()!.state as any).draft).toBe("receipt先完成🌏");
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("installs receipt deltas even when every publication event was dropped", async () => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init(); f.dropEvents(); f.resetWire();
    await c.dispatch({ name: "draft", args: ["丢事件仍保留🙂"] });
    expect((c.getSnapshot()!.state as any).draft).toBe("丢事件仍保留🙂");
    expect(f.commands.some(row => row.command === "plugin_window_snapshot")).toBe(false);
  });

  it.each(["patch", "unchanged"] as const)("blocks action completion, flush and return until a %s receipt baseline is restored", async kind => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init(); f.dropEvents(); f.resetWire();
    f.setState({ draft: "missing intermediate", history: ["retained"] });
    await vi.waitFor(() => expect(f.getNative().revision).toBe(1));
    const gate = deferred<void>(); f.holdSnapshot(gate.promise);
    f.transformReceipt(value => ({ ...value, update: kind === "unchanged" ? { kind, revision: 2 }
      : { kind, baseRevision: 1, revision: 2, changes: [{ op: "set", path: ["draft"], value: "最终输入🌏" }] } }));
    let completed = false, flushed = false, returned = false;
    const action = c.dispatch({ name: "draft", args: ["最终输入🌏"] }).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(f.commands.some(row => row.command === "plugin_window_snapshot")).toBe(true));
    const flush = c.flush().then(() => { flushed = true; });
    const returning = c.requestReturn().then(() => { returned = true; });
    await turns(); expect({ completed, flushed, returned }).toEqual({ completed: false, flushed: false, returned: false });
    expect(f.commands.some(row => row.command === "plugin_window_return")).toBe(false);
    gate.resolve(); const result = await action; await Promise.all([flush, returning]);
    expect(result.sequence).toBe(1); expect((result.snapshot.state as any).draft).toBe("最终输入🌏");
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.commands.filter(row => row.command === "plugin_window_action_update")).toHaveLength(1);
    expect(f.commands.filter(row => row.command === "plugin_window_init")).toHaveLength(0);
  });

  it.each(["patch", "unchanged"] as const)("holds flush and return for an event-only %s gap without action replay", async kind => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init(); f.dropEvents(); f.resetWire();
    f.setState({ draft: "first lost", history: ["retained"] });
    await vi.waitFor(() => expect(f.getNative().revision).toBe(1));
    f.setState({ draft: "latest lost🌏", history: ["retained"] });
    await vi.waitFor(() => expect(f.getNative().revision).toBe(2));
    const gate = deferred<void>(); f.holdSnapshot(gate.promise);
    f.emit(EVENTS.snapshot, { ...f.identity(), dark: false, update: kind === "unchanged" ? { kind, revision: 2 }
      : { kind, baseRevision: 1, revision: 2, changes: [{ op: "set", path: ["draft"], value: "latest lost🌏" }] } });
    await vi.waitFor(() => expect(f.commands.some(row => row.command === "plugin_window_snapshot")).toBe(true));
    let flushed = false, returned = false;
    const flush = c.flush().then(() => { flushed = true; });
    const returning = c.requestReturn().then(() => { returned = true; });
    await turns(); expect({ flushed, returned }).toEqual({ flushed: false, returned: false });
    expect(f.commands.some(row => row.command === "plugin_window_return")).toBe(false);
    gate.resolve(); await Promise.all([flush, returning]);
    expect((c.getSnapshot()!.state as any).draft).toBe("latest lost🌏");
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.commands.filter(row => row.command === "plugin_window_snapshot")).toHaveLength(1);
  });

  it("ignores a late read-only recovery after client disposal and does not replay its action", async () => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init(); f.dropEvents();
    f.setState({ draft: "unseen", history: ["retained"] });
    await vi.waitFor(() => expect(f.getNative().revision).toBe(1));
    const old = c.getSnapshot(), gate = deferred<void>(); f.holdSnapshot(gate.promise);
    f.emit(EVENTS.snapshot, { ...f.identity(), dark: true, update: { kind: "unchanged", revision: 1 } });
    await vi.waitFor(() => expect(f.commands.some(row => row.command === "plugin_window_snapshot")).toBe(true));
    c.dispose(); gate.resolve(); await turns();
    expect(c.getSnapshot()).toBe(old); expect(c.getDark()).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("recovers a lost ACK and a reloaded unresolved sequence through inspection only", async () => {
    const f = fixture(); await f.owner.open(); const first = f.client(); await first.init(); f.loseNextAck();
    const gate = deferred<void>(); f.holdDispatch(gate.promise);
    const action = first.dispatch({ name: "draft", args: ["原始请求🌏"] });
    void action.catch(() => {});
    await vi.waitFor(() => expect(first.getStatus().phase).toBe("recovering"));
    await expect(first.flush()).rejects.toThrow(/pending/);
    first.dispose(); await expect(action).rejects.toThrow(/disposed/);
    const second = f.client(); const init = await second.init();
    expect(init.nextSequence).toBe(2); expect(init.unresolvedSequences).toEqual([1]);
    await expect(second.dispatch({ name: "draft", args: ["不得重发"] })).rejects.toThrow(/not accepting/);
    f.inspectWith(sequence => ({ ...f.identity(), sequence, state: "unknown" }));
    expect(await second.reconcile()).toBe(false);
    expect(f.dispatch).toHaveBeenCalledOnce();
    f.inspectWith(); gate.resolve();
    await vi.waitFor(() => expect(f.records.get(1)?.result).toBeDefined());
    expect(await second.reconcile()).toBe(true);
    const next = await second.dispatch({ name: "draft", args: ["明确下一条"] });
    expect(next.sequence).toBe(2);
    expect(f.dispatch.mock.calls.map(([value]) => value.args[0])).toEqual(["原始请求🌏", "明确下一条"]);
    expect(f.commands.filter(row => row.command === "plugin_window_action_update").map(row => row.request.sequence)).toEqual([1, 2]);
    expect(f.commands.filter(row => row.command === "plugin_window_inspect_action_update").map(row => row.request.sequence)).toEqual([1, 1]);
  });

  it("applies dark-only updates without changing revision and ignores wrong-window and post-dispose events", async () => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init(); f.resetWire();
    const old = c.getSnapshot(); f.setDark(true);
    await vi.waitFor(() => expect(c.getDark()).toBe(true));
    expect(c.getSnapshot()).toBe(old);
    expect(f.commands.find(row => row.command === "plugin_window_publish_update")!.request.update).toEqual({ kind: "unchanged", revision: 0 });
    f.emit(EVENTS.snapshot, { ...f.identity(), windowId: "wrong", update: { kind: "full", snapshot: { revision: 3, state: { draft: "wrong" } } }, dark: false });
    await turns(); expect(c.getSnapshot()).toBe(old); expect(c.getDark()).toBe(true);
    c.dispose();
    f.emit(EVENTS.snapshot, { ...f.identity(), update: { kind: "full", snapshot: { revision: 4, state: { draft: "late" } } }, dark: false });
    await turns(); expect(c.getSnapshot()).toBe(old); expect(c.getDark()).toBe(true);
  });

  it("fails closed on conflicting effects at the same snapshot revision", async () => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init();
    await c.dispatch({ name: "draft", args: ["真实输入"] }); const old = c.getSnapshot();
    f.emit(EVENTS.snapshot, { ...f.identity(), update: { kind: "patch", baseRevision: 0, revision: 1,
      changes: [{ op: "set", path: ["draft"], value: "冲突输入" }] }, dark: false });
    await vi.waitFor(() => expect(c.getStatus().phase).toBe("error"));
    expect(c.getSnapshot()).toBe(old);
    await expect(c.dispatch({ name: "draft", args: ["不可继续"] })).rejects.toThrow(/not accepting/);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it("does not poll an impossible receipt after native rejects a future known revision before admission", async () => {
    const f = fixture(); await f.owner.open(); const c = f.client(); await c.init();
    f.emit(EVENTS.snapshot, { ...f.identity(), dark: false, update: { kind: "full", snapshot: { revision: 99, state: { draft: "invalid future projection" } } } });
    await turns();
    await expect(c.dispatch({ name: "draft", args: ["保留待重试草稿"] })).rejects.toThrow(/baseline mismatch.*not sent/);
    expect(c.getStatus().phase).toBe("error");
    expect(f.records.size).toBe(0);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(await c.reconcile()).toBe(false);
    expect(f.commands.filter(row => row.command === "plugin_window_inspect_action_update")).toHaveLength(0);
  });
});
