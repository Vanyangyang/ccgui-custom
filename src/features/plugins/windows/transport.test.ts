import { afterEach, describe, expect, it, vi } from "vitest";
import { createDetachedSurfaceOwner } from "./owner";
import { createDetachedSurfaceClient } from "./client";
import { copyJson, EVENTS, type DetachedInit, type DetachedTransport, type JsonValue } from "./protocol";
import { abortRuntimeCheckpoint, getRuntimeCheckpointReadiness, prepareRuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { usePluginTabsStore } from "../runtime/center-tabs";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness() {
  const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue(undefined);
  const transport: DetachedTransport = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => invoke(command, args) as Promise<T>,
    listen: async <T>(name: string, callback: (event: { payload: T }) => void) => {
      const set = handlers.get(name) ?? new Set(); handlers.set(name, set);
      const handler = callback as (event: { payload: unknown }) => void; set.add(handler);
      return () => { set.delete(handler); };
    },
  };
  return { invoke, transport, handlers, emit(name: string, payload: unknown) { for (const cb of handlers.get(name) ?? []) cb({ payload }); } };
}
const labels = { returnToMain: "Return", ownerUnavailable: "Unavailable", actionFailed: "Failed", loading: "Loading" };
function initData(): DetachedInit { return { pluginId: "test", tabId: "tab", registrationId: "reg", windowId: "window", label: "window", title: "Title", rendererExport: "Detached", code: "code", css: "", labels, snapshot: { revision: 0, state: { draft: "" } }, dark: false, nextSequence: 1, unresolvedSequences: [] }; }
async function turns() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); usePluginTabsStore.setState({ tabs: [], activeId: null }); abortRuntimeCheckpoint(); vi.useRealTimers(); });

function ownerFixture(assertCanOpen?: () => void, defaultPresentation?: "docked" | "detached") {
  const h = harness(); let state: JsonValue = { draft: "" }; let changed = () => {};
  const dispatch = vi.fn<(action: { name: string; args: JsonValue[] }) => Promise<JsonValue>>().mockResolvedValue(false);
  const onReturn = vi.fn(); const unsubscribe = vi.fn();
  h.invoke.mockImplementation(async (command, args) => {
    const request = args?.request as Record<string, unknown>;
    if (command === "plugin_window_open") return { windowId: "window", label: "window", registrationId: request.registrationId };
  });
  const getSnapshot = vi.fn(() => state);
  const owner = createDetachedSurfaceOwner({ pluginId: "test", tabId: "tab", title: () => "Title", rendererExport: "Detached", assets: { code: "code", css: "" }, getSnapshot, subscribe: cb => { changed = cb; return unsubscribe; }, dispatch, onReturn, labels, transport: h.transport, assertCanOpen, defaultPresentation });
  disposers.push(owner.dispose);
  return { ...h, owner, dispatch, onReturn, unsubscribe, getSnapshot, setState(next: JsonValue) { state = next; changed(); }, identity() { const call = h.invoke.mock.calls.find(([cmd]) => cmd === "plugin_window_open")!; const request = call[1]!.request as Record<string, unknown>; return { windowId: "window", registrationId: request.registrationId, ownerToken: request.ownerToken }; } };
}
function clientFixture() {
  const h = harness();
  h.invoke.mockImplementation(async command => command === "plugin_window_init" ? initData() : command === "plugin_window_status" ? { ownerAvailable: true, closing: false } : undefined);
  const client = createDetachedSurfaceClient({ transport: h.transport }); disposers.push(client.dispose);
  return { ...h, client };
}

describe("detached owner", () => {
  it("does no snapshot work for docked changes and opens with the latest exact state", async () => {
    const f = ownerFixture(); const baseline = f.getSnapshot.mock.calls.length;
    for (let i = 0; i < 30; i++) f.setState({ draft: `中文👩🏽‍💻 ${i}` });
    await turns();
    expect(f.getSnapshot).toHaveBeenCalledTimes(baseline);
    await f.owner.open();
    expect((f.invoke.mock.calls.find(([cmd]) => cmd === "plugin_window_open")![1]!.request as any).snapshot.state).toEqual({ draft: "中文👩🏽‍💻 29" });
  });
  it("coalesces notifications before cloning and keeps only the latest display state behind an in-flight publish", async () => {
    const f = ownerFixture(); await f.owner.open(); f.getSnapshot.mockClear(); f.invoke.mockClear();
    const gate = deferred<unknown>(); let held = false;
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_publish" && !held) { held = true; await gate.promise; }
      return original(command, args);
    });
    for (let i = 0; i < 30; i++) f.setState({ draft: `batch 1: ${i}` });
    expect(f.getSnapshot).not.toHaveBeenCalled();
    await turns(); expect(f.getSnapshot).toHaveBeenCalledOnce();
    for (let i = 0; i < 30; i++) f.setState({ draft: `最终原文🌏 ${i}` });
    await turns(); expect(f.getSnapshot).toHaveBeenCalledOnce();
    gate.resolve(undefined); await turns();
    const publications = f.invoke.mock.calls.filter(([command]) => command === "plugin_window_publish");
    expect(publications).toHaveLength(2);
    expect((publications[1][1]!.request as any).snapshot.state).toEqual({ draft: "最终原文🌏 29" });
    expect(f.getSnapshot).toHaveBeenCalledTimes(2);
    f.setState({ draft: "最终原文🌏 29" }); await turns();
    expect(f.invoke.mock.calls.filter(([command]) => command === "plugin_window_publish")).toHaveLength(2);
  });
  it("an action receipt captures its committed state even while display publication is pending", async () => {
    const f = ownerFixture(); await f.owner.open();
    f.dispatch.mockImplementation(async () => { f.setState({ draft: "已提交，不等展示队列" }); return true; });
    f.emit(EVENTS.action, { ...f.identity(), sequence: 1, action: { name: "save", args: [] } });
    await turns();
    const response = f.invoke.mock.calls.find(([command]) => command === "plugin_window_respond");
    expect((response![1]!.request as any).snapshot.state).toEqual({ draft: "已提交，不等展示队列" });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("an obsolete publish cannot block reopening or report its late failure on the new window", async () => {
    const f = ownerFixture(); await f.owner.open(); const old = f.identity();
    const gate = deferred<unknown>(); let nextWindow = false;
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (command, args) => {
      const request = args?.request as any;
      if (command === "plugin_window_open" && nextWindow) return { windowId: "new-window", registrationId: request.registrationId };
      if (command === "plugin_window_publish" && request.windowId === old.windowId) return gate.promise;
      return original(command, args);
    });
    f.setState({ draft: "old publication" }); await turns();
    f.emit(EVENTS.returned, { ...old, tabId: "tab", reason: "closed" }); nextWindow = true;
    const reopening = f.owner.open(); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
    await reopening; gate.reject(new Error("old transport failed")); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
  });
  it("closing during the initial publish releases the old opening before a new window opens", async () => {
    const f = ownerFixture(), gate = deferred<unknown>(); let nextWindow = false;
    f.invoke.mockImplementation(async (command, args) => {
      const request = args?.request as any;
      if (command === "plugin_window_open") return { windowId: nextWindow ? "new-window" : "window", registrationId: request.registrationId };
      if (command === "plugin_window_publish" && request.windowId === "window") return gate.promise;
    });
    const first = f.owner.open(); await turns(); const old = f.identity();
    f.emit(EVENTS.returned, { ...old, tabId: "tab", reason: "closed" }); nextWindow = true;
    const second = f.owner.open(); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
    await Promise.all([first, second]);
    gate.resolve(undefined); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
  });
  it("a heartbeat failure from a retired window cannot mark its replacement unavailable", async () => {
    vi.useFakeTimers(); const f = ownerFixture(); await f.owner.open(); const old = f.identity();
    const gate = deferred<unknown>(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (command, args) => command === "plugin_window_owner_alive" ? gate.promise : original(command, args));
    await vi.advanceTimersByTimeAsync(3000);
    f.emit(EVENTS.returned, { ...old, tabId: "tab", reason: "closed" });
    f.invoke.mockImplementation(async (command, args) => command === "plugin_window_open"
      ? { windowId: "new-window", registrationId: (args!.request as any).registrationId } : original(command, args));
    await f.owner.open(); gate.reject(new Error("old heartbeat")); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
  });
  it("ignores a late confirmation failure from a window that has already returned", async () => {
    const f = ownerFixture(); await f.owner.open(); const identity = f.identity(); const reply = deferred<unknown>();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (command, args) => command === "plugin_window_respond" ? reply.promise : original(command, args));
    f.emit(EVENTS.action, { ...identity, sequence: 1, action: { name: "save", args: [] } }); await turns();
    f.emit(EVENTS.returned, { ...identity, tabId: "tab", reason: "return" });
    f.invoke.mockImplementation(async (command, args) => command === "plugin_window_open"
      ? { windowId: "new-window", label: "new-window", registrationId: (args!.request as any).registrationId } : original(command, args));
    await f.owner.open(); reply.reject(new Error("late failure from previous window")); await turns();
    expect(f.owner.getStatus()).toEqual({ phase: "detached", windowId: "new-window" });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("stops retrying an expired native receipt without marking the result confirmed", async () => {
    vi.useFakeTimers(); const f = ownerFixture(); await f.owner.open();
    const original = f.invoke.getMockImplementation()!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_respond") throw "plugin_window_action_not_pending_or_expired";
      return original(command, args);
    });
    f.emit(EVENTS.action, { ...f.identity(), sequence: 1, action: { name: "save", args: [] } });
    await turns(); await vi.advanceTimersByTimeAsync(9000);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.filter(([command]) => command === "plugin_window_respond")).toHaveLength(1);
    expect(f.owner.getStatus()).toMatchObject({ phase: "error", error: "Detached action result is no longer retained" });
    warning.mockRestore();
  });
  it("retransmits only an unconfirmed result after a response transport failure, never the business action", async () => {
    vi.useFakeTimers(); const f = ownerFixture(); await f.owner.open();
    const original = f.invoke.getMockImplementation()!; let failed = false;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_respond" && !failed) { failed = true; throw "plugin_window_transport_error"; }
      return original(command, args);
    });
    f.emit(EVENTS.action, { ...f.identity(), sequence: 1, action: { name: "save", args: [] } });
    await turns();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_respond")).toHaveLength(1);
    f.setState({ draft: "newer state" }); await turns();
    await vi.advanceTimersByTimeAsync(3000);
    const replies = f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_respond");
    expect(replies).toHaveLength(2);
    expect((replies[1][1]!.request as any)).toMatchObject({ sequence: 1, ok: true, value: false, snapshot: { state: { draft: "newer state" } } });
    expect(f.dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_respond")).toHaveLength(2);
    warning.mockRestore();
  });
  it("reports failed restore and retries registration on explicit user entry without business actions", async () => {
    const f = ownerFixture();
    f.invoke.mockRejectedValueOnce(new Error("read failed"));
    await expect(f.owner.restore()).rejects.toThrow("read failed");
    expect(f.owner.getStatus().phase).toBe("error");
    expect(await f.owner.present()).toBe("docked");
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_presentation_register")).toHaveLength(2);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("allows explicit open retry after the initial snapshot publication failed", async () => {
    const f = ownerFixture(); let failed = false;
    f.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "plugin_window_open") return { windowId: "window", registrationId: (args!.request as any).registrationId };
      if (cmd === "plugin_window_publish" && !failed) { failed = true; throw new Error("publish failed"); }
    });
    await expect(f.owner.open()).rejects.toThrow("publish failed");
    await f.owner.open(); expect(f.owner.getStatus().phase).toBe("detached");
  });
  it("keeps a failed close visible to flush and automatic restore until explicit retry saves it", async () => {
    const f = ownerFixture(); await f.owner.present();
    usePluginTabsStore.getState().openTab("tab"); await f.owner.flushPresentation();
    f.invoke.mockRejectedValueOnce(new Error("disk failed"));
    usePluginTabsStore.getState().closeTab("tab");
    await expect(f.owner.flushPresentation()).rejects.toThrow("disk failed");
    await expect(f.owner.restore()).rejects.toThrow("disk failed");
    await expect(f.owner.flushPresentation()).rejects.toThrow("disk failed");
    expect(await f.owner.present()).toBe("docked");
    await f.owner.flushPresentation();
    const writes = f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_presentation_set").map(([, args]) => (args!.request as any).wasOpen);
    expect(writes.slice(-3)).toEqual([false, false, true]);
  });
  it.each(["present", "open"] as const)("rechecks maintenance lock after pending registration for %s", async method => {
    let locked = false; const f = ownerFixture(() => { if (locked) throw new Error("locked"); });
    const read = deferred<any>(); f.invoke.mockImplementation(async cmd => cmd === "plugin_window_presentation_register" ? read.promise : undefined);
    const work = f.owner[method](); await turns(); locked = true;
    read.resolve({ presentation: "docked", wasOpen: false });
    await expect(work).rejects.toThrow("locked");
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_open" || cmd === "plugin_window_presentation_set")).toBe(false);
  });
  it.each(["present", "open"] as const)("rechecks maintenance lock after pending persistence for %s", async method => {
    let locked = false; const f = ownerFixture(() => { if (locked) throw new Error("locked"); });
    const write = deferred<any>();
    f.invoke.mockImplementation(async cmd => cmd === "plugin_window_presentation_set" ? write.promise : undefined);
    usePluginTabsStore.getState().openTab("tab"); await turns();
    const work = f.owner[method](); await turns(); locked = true; write.resolve(undefined);
    await expect(work).rejects.toThrow("locked");
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_open")).toBe(false);
  });
  it("cancels stale automatic restore after a newer maintenance starts", async () => {
    const f = ownerFixture(); const read = deferred<any>();
    f.invoke.mockImplementation(async cmd => cmd === "plugin_window_presentation_register" ? read.promise : undefined);
    const work = f.owner.restore(); await turns(); f.owner.cancelRestore?.();
    read.resolve({ presentation: "detached", wasOpen: true });
    expect(await work).toBeNull();
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_open")).toBe(false);
  });
  it("rechecks the runtime fence after asynchronous registration", async () => {
    const f = ownerFixture(); const read = deferred<any>();
    f.invoke.mockImplementation(async cmd => cmd === "plugin_window_presentation_register" ? read.promise : undefined);
    const work = f.owner.open(); await turns();
    await expect(prepareRuntimeCheckpoint()).rejects.toThrow();
    read.resolve(null); await expect(work).rejects.toThrow();
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_open")).toBe(false);
  });
  it("uses the configured default only on explicit presentation, and remembers a docked close", async () => {
    const f = ownerFixture(undefined, "detached");
    expect(await f.owner.restore()).toBeNull();
    expect(await f.owner.present()).toBe("detached");
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_open")).toHaveLength(1);
    const returning = f.owner.returnToMain(); await turns();
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "return" }); await returning;
    usePluginTabsStore.getState().openTab("tab");
    usePluginTabsStore.getState().closeTab("tab");
    await f.owner.flushPresentation();
    expect(f.invoke).toHaveBeenLastCalledWith("plugin_window_presentation_set", { request: expect.objectContaining({ presentation: "docked", wasOpen: false }) });
    expect(await f.owner.restore()).toBeNull();
  });
  it("restores an open detached view without focus or dispatch and manual entry focuses it", async () => {
    const f = ownerFixture();
    f.invoke.mockImplementation(async (cmd, args) => cmd === "plugin_window_presentation_register" ? { presentation: "detached", wasOpen: true } : cmd === "plugin_window_open" ? { windowId: "window", registrationId: (args!.request as any).registrationId } : undefined);
    expect(await f.owner.restore()).toBe("detached");
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_open", { request: expect.objectContaining({ focus: false }) });
    expect(await f.owner.present()).toBe("detached");
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_open", { request: expect.objectContaining({ focus: true }) });
    expect(f.dispatch).not.toHaveBeenCalled();
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "closed" });
    expect(await f.owner.restore()).toBeNull();
  });
  it("does not clear intent for maintenance tab removal or detached placeholder removal", async () => {
    const f = ownerFixture(); await f.owner.present();
    usePluginTabsStore.getState().openTab("tab"); await f.owner.flushPresentation();
    f.invoke.mockClear(); usePluginTabsStore.getState().closeTab("tab", "maintenance"); await f.owner.flushPresentation();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(await f.owner.restore()).toBe("docked");
    await f.owner.open(); usePluginTabsStore.getState().openTab("tab"); f.invoke.mockClear();
    usePluginTabsStore.getState().closeTab("tab"); await f.owner.flushPresentation();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("preserves detached intent on maintenance and does not reopen the main tab", async () => {
    const f = ownerFixture(); await f.owner.open();
    const closing = f.owner.returnToMain("maintenance"); await turns();
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_request_return", { request: { ...f.identity(), reason: "maintenance" } });
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "maintenance" }); await closing;
    expect(f.onReturn).not.toHaveBeenCalled();
  });
  it("does not restore a previously closed detached view", async () => {
    const f = ownerFixture();
    f.invoke.mockResolvedValue({ presentation: "detached", wasOpen: false });
    expect(await f.owner.restore()).toBeNull();
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_open")).toBe(false);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("checks plugin update opening guards before and after asynchronous listener readiness", async () => {
    let locked = true;
    const f = ownerFixture(() => { if (locked) throw new Error("update locked"); });
    await expect(f.owner.open()).rejects.toThrow("update locked");
    locked = false;
    const opening = f.owner.open(); locked = true;
    await expect(opening).rejects.toThrow("update locked");
    expect(f.invoke.mock.calls.some(([command]) => command === "plugin_window_open")).toBe(false);
  });
  it("fences opening and return delivery against self-update, rejecting mutations while paused", async () => {
    const f = ownerFixture(); const gate = deferred<any>();
    f.invoke.mockImplementation(async command => command === "plugin_window_open" ? gate.promise : undefined);
    const opening = f.owner.open(); await turns();
    expect(getRuntimeCheckpointReadiness()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "plugin-window-without-checkpoint" })]));
    gate.resolve({ ...f.identity(), label: "window" }); await opening;
    await expect(prepareRuntimeCheckpoint()).rejects.toThrow();
    f.emit(EVENTS.action, { ...f.identity(), sequence: 1, action: { name: "send", args: [] } }); await turns();
    expect(f.dispatch).not.toHaveBeenCalled();
    await expect(f.owner.open()).rejects.toThrow();
    abortRuntimeCheckpoint();
    // Even if the native window has closed, the owner remains a blocker until
    // this matching return is delivered to the original document.
    expect(getRuntimeCheckpointReadiness().some(item => item.reason === "plugin-window-without-checkpoint")).toBe(true);
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "closed" }); await turns();
    expect(getRuntimeCheckpointReadiness().filter(item => item.reason === "plugin-window-without-checkpoint")).toEqual([]);
  });
  it("coalesces concurrent open, snapshots changes while docked, and cleans subscriptions/timers", async () => {
    vi.useFakeTimers(); const f = ownerFixture(); f.setState({ draft: "before" });
    expect(f.owner.open()).toBe(f.owner.open()); await turns();
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_open")).toHaveLength(1);
    expect((f.invoke.mock.calls.find(([cmd]) => cmd === "plugin_window_open")![1]!.request as any).snapshot).toEqual({ revision: 1, state: { draft: "before" } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_owner_alive", expect.anything());
    f.owner.dispose(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes a late window after owner teardown", async () => {
    const f = ownerFixture(); const gate = deferred<any>();
    f.invoke.mockImplementation(async command => command === "plugin_window_open" ? gate.promise : undefined);
    const opened = f.owner.open(); await turns(); f.owner.dispose();
    gate.resolve({ ...f.identity(), label: "window" }); await opened;
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_dispose")).toHaveLength(2);
    expect(f.owner.getStatus().phase).not.toBe("detached");
  });
  it("handles a returned event arriving before open resolves", async () => {
    const f = ownerFixture(); const gate = deferred<any>();
    f.invoke.mockImplementation(async command => command === "plugin_window_open" ? gate.promise : undefined);
    const opening = f.owner.open(); await turns();
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "closed" });
    gate.resolve({ ...f.identity(), label: "window" }); await opening;
    expect(f.owner.getStatus().phase).toBe("docked"); expect(f.onReturn).toHaveBeenCalledWith("closed");
  });
  it("executes duplicate actions once, rejects gaps, and preserves false", async () => {
    const f = ownerFixture(); await f.owner.open(); const gate = deferred<JsonValue>(); f.dispatch.mockReturnValue(gate.promise);
    const event = { ...f.identity(), sequence: 1, action: { name: "send", args: [] } };
    f.emit(EVENTS.action, event); f.emit(EVENTS.action, event);
    f.emit(EVENTS.action, { ...event, sequence: 3 }); await turns();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    gate.resolve(false); await turns();
    const responses = f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_respond").map(([, args]) => args!.request as any);
    expect(responses.filter(receipt => receipt.sequence === 1)).toHaveLength(1);
    expect(responses.find(receipt => receipt.sequence === 1)).toMatchObject({ ok: true, value: false });
    expect(responses.find(receipt => receipt.sequence === 3)).toMatchObject({ ok: false, value: null });
  });
  it("ignores stale returns and resets action sequence when reopened", async () => {
    const f = ownerFixture(); await f.owner.open(); const identity = f.identity();
    f.emit(EVENTS.returned, { ...identity, registrationId: "old", tabId: "tab", reason: "return" });
    f.emit(EVENTS.returned, { ...identity, ownerToken: "old", tabId: "tab", reason: "return" });
    expect(f.onReturn).not.toHaveBeenCalled();
    f.emit(EVENTS.action, { ...identity, sequence: 1, action: { name: "save", args: [] } }); await turns();
    f.emit(EVENTS.returned, { ...identity, tabId: "tab", reason: "return" });
    expect(f.onReturn).toHaveBeenCalledTimes(1);
    f.invoke.mockImplementation(async (command, args) => command === "plugin_window_open" ? { windowId: "new-window", label: "new-window", registrationId: (args!.request as any).registrationId } : undefined);
    await f.owner.open();
    f.emit(EVENTS.action, { ...identity, sequence: 1, action: { name: "save", args: [] } });
    f.emit(EVENTS.returned, { ...identity, tabId: "tab", reason: "closed" }); await turns();
    expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.onReturn).toHaveBeenCalledTimes(1);
    f.emit(EVENTS.action, { ...identity, windowId: "new-window", sequence: 1, action: { name: "save", args: [] } }); await turns();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it("requests child flush and waits for returned instead of destroying directly", async () => {
    const f = ownerFixture(); await f.owner.open(); const returned = f.owner.returnToMain(); await turns();
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_request_return", { request: f.identity() });
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_return")).toBe(false);
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "return" }); await returned;
    expect(f.owner.getStatus().phase).toBe("docked");
  });
  it("keeps the same window usable when its renderer refuses return for unsynchronized edits", async () => {
    const f = ownerFixture(); await f.owner.open();
    const returned = f.owner.returnToMain(); const rejected = expect(returned).rejects.toThrow("Unconfirmed edits"); await turns();
    f.emit(EVENTS.returnBlocked, { ...f.identity(), tabId: "tab" }); await rejected;
    expect(f.owner.getStatus()).toMatchObject({ phase: "detached", windowId: "window", returnBlocked: true });
    expect(f.onReturn).not.toHaveBeenCalled();
    const next = f.owner.returnToMain(); await turns();
    f.emit(EVENTS.returned, { ...f.identity(), tabId: "tab", reason: "return" }); await next;
    expect(f.onReturn).toHaveBeenCalledTimes(1);
  });
  it("allows explicit user force return after returnBlocked while forbidding force maintenance", async () => {
    const f = ownerFixture(); await f.owner.open();
    const blocked = f.owner.returnToMain(); const rejected = expect(blocked).rejects.toThrow("Unconfirmed edits"); await turns();
    f.emit(EVENTS.returnBlocked, { ...f.identity(), tabId: "tab" }); await rejected;
    expect(f.owner.getStatus().returnBlocked).toBe(true);
    await expect(f.owner.returnToMain("maintenance", { force: true })).rejects.toThrow("Maintenance return cannot force discard");
    await f.owner.returnToMain("return", { force: true });
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_return", { request: { ...f.identity(), reason: "return", force: true } });
    expect(f.owner.getStatus().phase).toBe("docked");
    expect(f.onReturn).toHaveBeenCalledWith("return");
  });
});

describe("detached client", () => {
  it.each(["plugin_window_owner_unavailable", "plugin_window_too_many_pending_actions", "plugin_window_invalid_action"])("does not retain an unadmitted action or replay its successors after %s", async reason => {
    const f = clientFixture(); await f.client.init(); let rejectAdmission = true;
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
      if (command === "plugin_window_action") {
        if (rejectAdmission) throw reason;
        const { sequence } = args!.request as any;
        return { sequence, ok: true, snapshot: { revision: 1, state: "fresh edit" } };
      }
    });
    const first = f.client.dispatch({ name: "send", args: ["not admitted"] });
    const second = f.client.dispatch({ name: "send", args: ["queued before failure"] });
    const settled = Promise.allSettled([first, second]);
    await turns();
    expect(f.client.getStatus().phase).toBe(reason === "plugin_window_owner_unavailable" ? "unavailable" : "detached");
    expect((await settled).every(result => result.status === "rejected" && String(result.reason).includes("not sent"))).toBe(true);
    rejectAdmission = false;
    expect(await f.client.reconcile()).toBe(true);
    await expect(f.client.dispatch({ name: "edit", args: ["fresh user action"] })).resolves.toMatchObject({ sequence: 1 });
    const calls = f.invoke.mock.calls.filter(([command]) => command === "plugin_window_action");
    expect(calls.map(([, args]) => (args!.request as any).sequence)).toEqual([1, 1]);
    expect(calls.map(([, args]) => (args!.request as any).action.name)).toEqual(["send", "edit"]);
    expect(f.invoke.mock.calls.some(([command]) => command === "plugin_window_inspect_action")).toBe(false);
    await f.client.requestReturn(); expect(f.client.getStatus().phase).toBe("docked");
  });
  it("fences queued successors when the owner disappears before a definitive action reply", async () => {
    const f = clientFixture(); await f.client.init(); const receipt = deferred<any>(); let available = false;
    f.invoke.mockImplementation(async command => command === "plugin_window_action" ? receipt.promise
      : { ownerAvailable: available, closing: false });
    const first = f.client.dispatch({ name: "edit", args: ["first"] });
    const second = f.client.dispatch({ name: "send", args: ["must not resume"] });
    const rejected = expect(second).rejects.toThrow("not sent");
    await turns(); await f.client.status();
    receipt.resolve({ sequence: 1, ok: true, snapshot: { revision: 1, state: "saved" } });
    await first; await rejected;
    expect(f.client.getStatus().phase).toBe("unavailable");
    available = true; expect(await f.client.reconcile()).toBe(true);
    expect(f.invoke.mock.calls.filter(([command]) => command === "plugin_window_action")).toHaveLength(1);
  });
  it("allows return to be retried after owner availability recovers", async () => {
    const f = clientFixture(); await f.client.init(); let available = false;
    f.invoke.mockImplementation(async () => ({ ownerAvailable: available, closing: false }));
    await expect(f.client.requestReturn()).rejects.toThrow("unavailable");
    available = true; expect(await f.client.reconcile()).toBe(true);
    await f.client.requestReturn(); expect(f.client.getStatus().phase).toBe("docked");
  });
  it.each(["plugin_window_action_out_of_order", "plugin_window_receipt_expired_no_retry", "plugin_window_action_payload_conflict"])("fails explicitly on sequence mismatch %s without waiting for an impossible receipt", async reason => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async command => {
      if (command === "plugin_window_action") throw reason;
      return { ownerAvailable: true, closing: false };
    });
    const action = f.client.dispatch({ name: "send", args: [] }); const settled = Promise.allSettled([action]);
    await turns(); expect(f.client.getStatus().phase).toBe("error");
    expect((await settled)[0].status).toBe("rejected");
    expect(await f.client.reconcile()).toBe(false);
    expect(f.invoke.mock.calls.some(([command]) => command === "plugin_window_inspect_action")).toBe(false);
  });
  it("recovers a lost maintenance event through status without turning it into a user close", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async cmd => cmd === "plugin_window_status" ? { ownerAvailable: true, closing: true, reason: "maintenance" } : undefined);
    await f.client.status(); await turns();
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_return", { request: { windowId: "window", registrationId: "reg", reason: "maintenance" } });
  });
  it("subscribes before init and does not let init or stale windows roll snapshot backward", async () => {
    const f = clientFixture(); const gate = deferred<DetachedInit>();
    f.invoke.mockImplementation(async () => gate.promise);
    const initialized = f.client.init(); await turns();
    f.emit(EVENTS.snapshot, { ...initData(), snapshot: { revision: 2, state: { draft: "new" } } });
    gate.resolve(initData()); expect((await initialized).snapshot.revision).toBe(2);
    f.emit(EVENTS.snapshot, { ...initData(), windowId: "old", snapshot: { revision: 99, state: null } });
    f.emit(EVENTS.snapshot, { ...initData(), snapshot: { revision: 1, state: null } });
    expect(f.client.getSnapshot()).toEqual({ revision: 2, state: { draft: "new" } });
  });
  it("serializes inputs and flushes all accepted actions before close", async () => {
    const f = clientFixture(); await f.client.init(); const first = deferred<any>();
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_action") { const { sequence } = args!.request as any; return sequence === 1 ? first.promise : { sequence, ok: true, value: false, snapshot: { revision: 2, state: "second" } }; }
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
    });
    const one = f.client.dispatch({ name: "draft", args: ["a"] }); const two = f.client.dispatch({ name: "draft", args: ["ab"] });
    f.emit(EVENTS.closeRequested, { ...initData(), reason: "closed" }); await turns();
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    await expect(f.client.dispatch({ name: "draft", args: ["late"] })).rejects.toThrow("not accepting");
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_return")).toBe(false);
    first.resolve({ sequence: 1, ok: true, value: null, snapshot: { revision: 1, state: "first" } }); await one;
    expect((await two).value).toBe(false); await turns();
    expect(f.client.getSnapshot()?.state).toBe("second");
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_return", { request: { windowId: "window", registrationId: "reg", reason: "closed" } });
  });
  it("does not retry unknown actions or send queued successors, and refuses false return success", async () => {
    const f = clientFixture(); await f.client.init(); f.invoke.mockRejectedValue(new Error("unknown"));
    const one = f.client.dispatch({ name: "send", args: [] }); const two = f.client.dispatch({ name: "send", args: [] });
    const settled = Promise.allSettled([one, two]);
    await turns();
    expect(await f.client.reconcile()).toBe(false);
    await expect(f.client.requestReturn()).rejects.toThrow();
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_return")).toBe(false);
    f.client.dispose();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
  });
  it("keeps an unknown action pending until read-only inspection returns its late definitive result", async () => {
    const f = clientFixture(); await f.client.init(); let resolved = false;
    f.invoke.mockImplementation(async command => {
      if (command === "plugin_window_action") return { sequence: 1, ok: false, unknown: true, snapshot: initData().snapshot };
      if (command === "plugin_window_inspect_action") return { windowId: "window", registrationId: "reg", sequence: 1, state: "resolved",
        receipt: { sequence: 1, ok: true, value: false, snapshot: { revision: 1, state: { draft: "saved" } } } };
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
    });
    const first = f.client.dispatch({ name: "save", args: [] });
    void first.then(() => { resolved = true; }, () => { resolved = true; });
    await turns();
    expect(resolved).toBe(false);
    expect(f.client.getStatus().phase).toBe("recovering");
    expect(await f.client.reconcile()).toBe(true);
    await expect(first).resolves.toMatchObject({ value: false, sequence: 1, snapshot: { state: { draft: "saved" } } });
    expect(f.client.getStatus().phase).toBe("detached");
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    await f.client.requestReturn();
    expect(f.client.getStatus().phase).toBe("docked");
  });
  it("installs receipt before resolving dispatch, preserving business false", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockResolvedValue({ sequence: 1, ok: true, value: false, error: null, snapshot: { revision: 1, state: "done" } });
    const result = await f.client.dispatch({ name: "send", args: [] });
    expect(result.value).toBe(false); expect(f.client.getSnapshot()).toEqual(result.snapshot);
  });
  it("returns the latest merged snapshot when a newer publish precedes an older action receipt", async () => {
    const f = clientFixture(); await f.client.init(); const receipt = deferred<any>();
    f.invoke.mockImplementation(async command => command === "plugin_window_action" ? receipt.promise : undefined);
    const action = f.client.dispatch({ name: "send", args: [] }); await turns();
    const latest = { revision: 2, state: { draft: "newer published state" } };
    f.emit(EVENTS.snapshot, { ...initData(), snapshot: latest });
    receipt.resolve({ sequence: 1, ok: true, value: false, snapshot: { revision: 1, state: { draft: "older receipt state" } } });
    const result = await action;
    expect(f.client.getSnapshot()).toEqual(latest);
    expect(result.snapshot).toBe(f.client.getSnapshot());
    expect(result.snapshot).toEqual(latest);
    expect(result.value).toBe(false);
    expect(result.sequence).toBe(1);
  });
  it("allows subsequent input and return after a definite action rejection", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
      if (command === "plugin_window_action") { const { sequence } = args!.request as any; return { sequence, ok: sequence !== 1, value: null, error: sequence === 1 ? "Rejected" : undefined, snapshot: { revision: sequence, state: sequence } }; }
    });
    const first = f.client.dispatch({ name: "send", args: [] });
    const second = f.client.dispatch({ name: "draft", args: ["fixed"] });
    await expect(first).rejects.toThrow("Rejected"); await expect(second).resolves.toMatchObject({ sequence: 2 });
    await f.client.requestReturn(); expect(f.client.getStatus().phase).toBe("docked");
  });
  it("runs live renderer guards after draining receipts and preserves failed edits until repaired", async () => {
    const f = clientFixture(); await f.client.init();
    let unconfirmed = true;
    f.client.registerReturnGuard(() => !unconfirmed);
    await expect(f.client.requestReturn("closed")).rejects.toThrow("Unconfirmed edits");
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_cancel_return", { request: { windowId: "window", registrationId: "reg" } });
    expect(f.invoke.mock.calls.some(([command]) => command === "plugin_window_return")).toBe(false);
    expect(f.client.getStatus().phase).toBe("detached");
    f.invoke.mockImplementation(async command => command === "plugin_window_action"
      ? { sequence: 1, ok: true, value: true, error: null, snapshot: { revision: 1, state: "fixed" } }
      : command === "plugin_window_status" ? { ownerAvailable: true, closing: false } : undefined);
    const edited = f.client.dispatch({ name: "edit", args: [] }).then(result => { unconfirmed = false; return result; });
    const returned = f.client.requestReturn();
    await edited; await returned;
    expect(f.client.getStatus().phase).toBe("docked");
  });
  it("allows explicit user discardAndReturn when returnGuard blocks closing or when an action is unresolved, without replaying", async () => {
    const f = clientFixture(); await f.client.init();
    f.client.registerReturnGuard(() => false);
    await expect(f.client.requestReturn("closed")).rejects.toThrow("Unconfirmed edits");
    expect(f.client.getStatus()).toMatchObject({ phase: "detached", returnBlocked: true, blockedReason: "closed" });
    await f.client.discardAndReturn("closed");
    expect(f.invoke).toHaveBeenCalledWith("plugin_window_return", {
      request: { windowId: "window", registrationId: "reg", reason: "closed", force: true },
    });
    expect(f.invoke.mock.calls.some(([cmd]) => cmd === "plugin_window_action")).toBe(false);
    expect(f.client.getStatus().phase).toBe("docked");
  });
  it("freezes on unknown receipts even when native reports ok false", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockResolvedValue({ sequence: 1, ok: false, unknown: true, error: "Timed out", snapshot: initData().snapshot });
    const first = f.client.dispatch({ name: "send", args: [] });
    const rejection = expect(first).rejects.toThrow("disposed");
    await turns();
    expect(f.client.getStatus().phase).toBe("recovering");
    await expect(f.client.dispatch({ name: "send", args: [] })).rejects.toThrow("not accepting");
    await expect(f.client.requestReturn()).rejects.toThrow();
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    f.client.dispose(); await rejection;
  });
  it("does not send old queued actions after recovery or leave gaps in native sequence", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
      if (command === "plugin_window_action") { const { sequence } = args!.request as any;
        return { sequence, ok: sequence !== 1, unknown: sequence === 1, snapshot: { revision: sequence, state: sequence } }; }
      if (command === "plugin_window_inspect_action") return { ...initData(), sequence: 1, state: "resolved", receipt: { sequence: 1, ok: true, snapshot: { revision: 1, state: 1 } } };
    });
    const first = f.client.dispatch({ name: "send", args: [] });
    const second = f.client.dispatch({ name: "send", args: ["must not resume automatically"] });
    const rejected = expect(second).rejects.toThrow("not sent");
    await turns(); await f.client.reconcile(); await first; await rejected;
    await f.client.dispatch({ name: "edit", args: ["fresh user action"] });
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action").map(([, args]) => (args!.request as any).sequence)).toEqual([1, 2]);
  });
  it.each(["pending", "unknown", "missing", "expired", "wrong-generation"])("keeps %s inspection unresolved without resubmission", async state => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async command => {
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
      if (command === "plugin_window_action") throw new Error("lost ACK");
      if (command === "plugin_window_inspect_action") return { ...initData(), registrationId: state === "wrong-generation" ? "other" : "reg", sequence: 1, state: state === "wrong-generation" ? "resolved" : state,
        receipt: { sequence: 1, ok: true, snapshot: { revision: 1, state: "untrusted result" } } };
    });
    const first = f.client.dispatch({ name: "send", args: [] });
    const settled = Promise.allSettled([first]);
    await turns(); expect(await f.client.reconcile()).toBe(false);
    expect(f.client.getStatus().phase).toBe("recovering");
    expect(f.client.getSnapshot()).toEqual(initData().snapshot);
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    f.client.dispose(); await settled;
  });
  it("recovers a definite rejection without treating it as success", async () => {
    const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async command => command === "plugin_window_action" ? Promise.reject(new Error("lost ACK"))
      : command === "plugin_window_inspect_action" ? { ...initData(), sequence: 1, state: "resolved", receipt: { sequence: 1, ok: false, error: "Original edit rejected", snapshot: initData().snapshot } }
      : { ownerAvailable: true, closing: false });
    const first = f.client.dispatch({ name: "edit", args: [] }); const rejection = expect(first).rejects.toThrow("Original edit rejected");
    await turns(); expect(await f.client.reconcile()).toBe(true); await rejection;
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
    expect(f.client.getStatus().phase).toBe("detached");
  });
  it("window reload adopts the native watermark and reconciles prior actions before accepting fresh input", async () => {
    const f = clientFixture();
    f.invoke.mockImplementation(async (command, args) => {
      if (command === "plugin_window_init") return { ...initData(), nextSequence: 7, unresolvedSequences: [6] };
      if (command === "plugin_window_status") return { ownerAvailable: true, closing: false };
      if (command === "plugin_window_inspect_action") return { ...initData(), sequence: 6, state: "resolved", receipt: { sequence: 6, ok: true, snapshot: { revision: 6, state: "original action finished" } } };
      if (command === "plugin_window_action") { const { sequence } = args!.request as any; return { sequence, ok: true, snapshot: { revision: sequence, state: "fresh" } }; }
    });
    await f.client.init(); expect(f.client.getStatus().phase).toBe("recovering");
    await expect(f.client.dispatch({ name: "send", args: [] })).rejects.toThrow("not accepting");
    expect(await f.client.reconcile()).toBe(true);
    await expect(f.client.dispatch({ name: "edit", args: [] })).resolves.toMatchObject({ sequence: 7 });
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
  });
  it("checks original receipts through the existing heartbeat without retrying a mutation", async () => {
    vi.useFakeTimers(); const f = clientFixture(); await f.client.init();
    f.invoke.mockImplementation(async command => command === "plugin_window_action" ? Promise.reject(new Error("lost ACK"))
      : command === "plugin_window_inspect_action" ? { ...initData(), sequence: 1, state: "resolved", receipt: { sequence: 1, ok: true, snapshot: { revision: 1, state: "saved" } } }
      : { ownerAvailable: true, closing: false });
    const first = f.client.dispatch({ name: "save", args: [] }); await turns();
    await vi.advanceTimersByTimeAsync(5000); await first;
    expect(f.client.getStatus().phase).toBe("detached");
    expect(f.invoke.mock.calls.filter(([cmd]) => cmd === "plugin_window_action")).toHaveLength(1);
  });
  it("cleans up listeners when initialization fails", async () => {
    const f = clientFixture(); f.invoke.mockRejectedValue(new Error("Owner gone"));
    await expect(f.client.init()).rejects.toThrow();
    expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true);
  });
  it("rejects conflicting revisions and owner disconnection, clears listeners and polling", async () => {
    vi.useFakeTimers(); const f = clientFixture(); await f.client.init();
    f.invoke.mockResolvedValue({ ownerAvailable: false, closing: false }); await vi.advanceTimersByTimeAsync(5000);
    expect(f.client.getStatus().phase).toBe("unavailable");
    await expect(f.client.dispatch({ name: "send", args: [] })).rejects.toThrow();
    f.client.dispose(); expect(vi.getTimerCount()).toBe(0); expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true);
  });
  it("fails closed on same-revision differing payload", async () => {
    const f = clientFixture(); await f.client.init();
    f.emit(EVENTS.snapshot, { ...initData(), snapshot: { revision: 0, state: "conflicting" } });
    expect(f.client.getSnapshot()?.state).toEqual({ draft: "" }); expect(f.client.getStatus().phase).toBe("error");
    await expect(f.client.flush()).rejects.toThrow();
  });
});

it("rejects non-JSON and unbounded payloads", () => {
  expect(() => copyJson({ bad: undefined })).toThrow(); expect(() => copyJson(NaN)).toThrow();
  const cycle: any = {}; cycle.self = cycle; expect(() => copyJson(cycle)).toThrow();
  expect(() => copyJson("large", 3)).toThrow();
});
