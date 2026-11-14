import { afterEach, describe, expect, it, vi } from "vitest";
import { createDetachedSurfaceOwner } from "./owner";
import { createDetachedSurfaceClient } from "./client";
import { EVENTS, type DetachedTransport, type JsonValue } from "./protocol";
import { abortRuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { usePluginTabsStore } from "../runtime/center-tabs";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); usePluginTabsStore.setState({ tabs: [], activeId: null }); abortRuntimeCheckpoint(); });

/** Old full-JSON wire fixture; no old native binary is executed. */
function legacyFixture() {
  const handlers = new Map<string, Set<(event: { payload: any }) => void>>();
  const records = new Map<number, { reply: ReturnType<typeof deferred<void>>; receipt?: any }>();
  const calls: Array<{ command: string; request: any }> = [];
  const encoded: string[] = [], business: Array<{ name: string; text: JsonValue }> = [];
  let state: JsonValue = { draft: "", history: ["旧协议历史🌏"] }, changed = () => {};
  let opened: any, snapshot: any, nextSequence = 1, loseAck = false, gate: Promise<void> | undefined;
  const identity = () => ({ windowId: "old-window", registrationId: opened.registrationId });
  const cross = (value: any) => { const text = JSON.stringify(value); encoded.push(text); return JSON.parse(text); };
  const emit = (name: string, value: any) => { const payload = cross(value); for (const callback of handlers.get(name) ?? []) callback({ payload }); };
  const transport: DetachedTransport = {
    async listen(event, callback) { const set = handlers.get(event) ?? new Set(); handlers.set(event, set); set.add(callback); return () => { set.delete(callback); }; },
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const request = cross(args ?? {}).request; calls.push({ command, request }); let value: any = null;
      if (command === "plugin_window_capabilities") throw "Command plugin_window_capabilities not found";
      if (command.endsWith("_update") || command === "plugin_window_snapshot") throw new Error(`new command on old host: ${command}`);
      switch (command) {
        case "plugin_window_presentation_register": break;
        case "plugin_window_open": opened = request; snapshot = request.snapshot; value = { ...identity(), label: "old-window" }; break;
        case "plugin_window_init": value = { ...opened, ...identity(), label: "old-window", snapshot, nextSequence, unresolvedSequences: [...records].filter(([, record]) => !record.receipt).map(([sequence]) => sequence) }; break;
        case "plugin_window_publish": if (request.snapshot.revision >= snapshot.revision) snapshot = request.snapshot; emit(EVENTS.snapshot, { ...identity(), snapshot, dark: request.dark }); break;
        case "plugin_window_action": {
          if (request.sequence !== nextSequence++) throw new Error("unexpected sequence");
          const record = { reply: deferred<void>(), receipt: undefined as any }; records.set(request.sequence, record);
          emit(EVENTS.action, { ...identity(), ownerToken: opened.ownerToken, sequence: request.sequence, action: request.action });
          if (loseAck) { loseAck = false; throw new Error("lost transport; original action remains pending"); }
          await record.reply.promise; value = record.receipt; break;
        }
        case "plugin_window_respond": {
          if (request.snapshot.revision >= snapshot.revision) snapshot = request.snapshot;
          const record = records.get(request.sequence)!;
          record.receipt = { sequence: request.sequence, ok: request.ok, value: request.value, snapshot, ...(request.error ? { error: request.error } : {}) };
          record.reply.resolve(); break;
        }
        case "plugin_window_inspect_action": {
          const record = records.get(request.sequence);
          value = { ...identity(), sequence: request.sequence, state: record?.receipt ? "resolved" : "unknown", ...(record?.receipt ? { receipt: record.receipt } : {}) }; break;
        }
        case "plugin_window_status": value = { ownerAvailable: true, closing: false }; break;
        case "plugin_window_return": emit(EVENTS.returned, { ...identity(), ownerToken: opened.ownerToken, tabId: "legacy-tab", reason: request.reason }); break;
        case "plugin_window_owner_alive": case "plugin_window_dispose": case "plugin_window_presentation_set": case "plugin_window_cancel_return": break;
        default: throw new Error(`unexpected legacy command: ${command}`);
      }
      return cross(value) as T;
    },
  };
  const owner = createDetachedSurfaceOwner({ pluginId: "legacy-test", tabId: "legacy-tab", title: () => "Legacy", rendererExport: "Detached", assets: { code: "code", css: "" },
    getSnapshot: () => state, subscribe: callback => { changed = callback; return () => {}; },
    dispatch: async action => {
      if (gate) await gate;
      const text = action.name === "send" ? (state as any).draft : action.args[0];
      business.push({ name: action.name, text });
      if (action.name !== "send") { state = { ...(state as Record<string, JsonValue>), draft: text }; changed(); }
      return text;
    }, onReturn: () => {}, labels: { returnToMain: "Return", ownerUnavailable: "Unavailable", actionFailed: "Failed", loading: "Loading" }, transport });
  const client = createDetachedSurfaceClient({ transport }); disposers.push(client.dispose, owner.dispose);
  return { owner, client, calls, encoded, business, records,
    hold(promise: Promise<void>) { gate = promise; }, loseAck() { loseAck = true; }, getState: () => state };
}

describe("new owner/client with an explicitly missing native capabilities command", () => {
  it("uses only full legacy traffic for 24 FIFO Unicode edits, an immediate send and close flush", async () => {
    const f = legacyFixture(); await f.owner.open(); const init = await f.client.init();
    expect(init).not.toHaveProperty("incremental");
    const open = f.calls.find(call => call.command === "plugin_window_open")!;
    expect(open.request).not.toHaveProperty("incremental");
    const old = f.client.getSnapshot();
    const edits = Array.from({ length: 24 }, (_, index) => `输入中文👩🏽‍💻🌏 ${index + 1}`);
    const actions = edits.map(text => f.client.dispatch({ name: "draft", args: [text] }));
    const sent = f.client.dispatch({ name: "send", args: [] });
    const closed = f.client.requestReturn();
    const results = await Promise.all(actions); expect((await sent).value).toBe(edits.at(-1)); await closed;
    expect(results.map(result => result.sequence)).toEqual(edits.map((_, index) => index + 1));
    expect(f.business.map(item => item.text)).toEqual([...edits, edits.at(-1)]);
    expect((f.client.getSnapshot()!.state as any).draft).toBe(edits.at(-1));
    expect((old!.state as any).draft).toBe(""); expect(f.client.getStatus().phase).toBe("docked");
    expect(f.calls.some(call => call.command.endsWith("_update") || call.command === "plugin_window_snapshot")).toBe(false);
    for (const command of ["plugin_window_publish", "plugin_window_respond", "plugin_window_action"]) expect(f.calls.some(call => call.command === command)).toBe(true);
    expect(f.calls.filter(call => call.command === "plugin_window_respond")).toHaveLength(25);
    expect(f.calls.filter(call => call.command === "plugin_window_respond").every(call => call.request.snapshot.state.history[0] === "旧协议历史🌏")).toBe(true);
    expect(f.encoded.filter(value => value.includes("旧协议历史🌏")).length).toBeGreaterThan(25);
  });

  it("inspects the original unknown legacy sequence without replay or switching to new commands", async () => {
    const f = legacyFixture(); await f.owner.open(); await f.client.init();
    const gate = deferred<void>(); f.hold(gate.promise); f.loseAck();
    const pending = f.client.dispatch({ name: "draft", args: ["原序号中文🌏"] });
    await vi.waitFor(() => expect(f.client.getStatus().phase).toBe("recovering"));
    expect(await f.client.reconcile()).toBe(false);
    await expect(f.client.flush()).rejects.toThrow(/pending/);
    expect(f.calls.filter(call => call.command === "plugin_window_action")).toHaveLength(1);
    gate.resolve(); await vi.waitFor(() => expect(f.records.get(1)?.receipt).toBeDefined());
    expect(await f.client.reconcile()).toBe(true);
    expect((await pending).sequence).toBe(1);
    expect(f.business).toEqual([{ name: "draft", text: "原序号中文🌏" }]);
    expect(f.calls.filter(call => call.command === "plugin_window_inspect_action").map(call => call.request.sequence)).toEqual([1, 1]);
    expect(f.calls.some(call => call.command.endsWith("_update") || call.command === "plugin_window_snapshot")).toBe(false);
  });
});
