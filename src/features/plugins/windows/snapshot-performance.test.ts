import { describe, expect, it } from "vitest";
import { createDetachedSurfaceClient } from "./client";
import { createDetachedSurfaceOwner } from "./owner";
import { EVENTS, type DetachedInit, type DetachedTransport, type JsonValue } from "./protocol";

// Bounded replay of a draft beside completed multilingual/Markdown history.
// Transport is in-memory: these numbers exclude native IPC, WebView and React.
function historyFixture(draft = "") {
  const content = ("中文原文👩🏽‍💻🌏\n\n| 标题 | value |\n| --- | --- |\n| 历史 | unchanged |\n\n```ts\nconst message = '保留原文';\n```\n[引用](https://example.test/source)\n").repeat(12);
  return { draft, messages: Array.from({ length: 320 }, (_, id) => ({ id, role: id % 2 ? "assistant" : "user", content, complete: true })) };
}
const labels = { returnToMain: "Return", ownerUnavailable: "Unavailable", actionFailed: "Failed", loading: "Loading" };
function harness(run: (command: string, request: any) => unknown) {
  const handlers = new Map<string, (event: { payload: any }) => void>();
  const transport: DetachedTransport = {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => await run(command, args?.request) as T,
    listen: async <T>(name: string, callback: (event: { payload: T }) => void) => {
      handlers.set(name, callback);
      return () => { handlers.delete(name); };
    },
  };
  return { transport, emit(name: string, payload: unknown) { handlers.get(name)?.({ payload }); } };
}
async function turns() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function measure(run: () => void | Promise<void>) {
  const stringify = JSON.stringify, parse = JSON.parse;
  const counts = { stringify: 0, parse: 0, fullStateStringify: 0, fullStateParse: 0 };
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    counts.stringify++;
    const text = stringify(...args);
    if (text && text.length > 100_000) counts.fullStateStringify++;
    return text;
  }) as typeof stringify;
  JSON.parse = ((...args: Parameters<typeof parse>) => {
    counts.parse++;
    if (args[0].length > 100_000) counts.fullStateParse++;
    return parse(...args);
  }) as typeof parse;
  const start = performance.now();
  try { await run(); } finally { JSON.stringify = stringify; JSON.parse = parse; }
  return { ...counts, elapsedMs: Math.round((performance.now() - start) * 100) / 100 };
}

describe("detached snapshot bounded performance replay", () => {
  it("measures owner edits including an upstream JSON copy and both publish/receipt paths", async () => {
    let state = historyFixture(), changed = () => {}, reads = 0, publications = 0, receipts = 0;
    let identity: Record<string, unknown> = {};
    const h = harness((command, request) => {
      if (command === "plugin_window_open") {
        identity = { windowId: "window", registrationId: request.registrationId, ownerToken: request.ownerToken };
        return { ...identity, label: "window" };
      }
      if (command === "plugin_window_publish") publications++;
      if (command === "plugin_window_respond") receipts++;
    });
    const owner = createDetachedSurfaceOwner({
      pluginId: "perf", tabId: "perf", title: () => "Performance fixture", rendererExport: "Detached",
      assets: { code: "", css: "" }, labels, transport: h.transport,
      getSnapshot: () => { reads++; return JSON.parse(JSON.stringify(state)) as JsonValue; },
      subscribe: listener => { changed = listener; return () => {}; },
      dispatch: action => { state = { ...state, draft: action.args[0] as string }; changed(); return true; },
      onReturn: () => {},
    });
    try {
      await owner.open(); reads = publications = receipts = 0;
      const metrics = await measure(async () => {
        for (let sequence = 1; sequence <= 8; sequence++) {
          h.emit(EVENTS.action, { ...identity, sequence, action: { name: "draft", args: [`输入👩🏽‍💻 ${sequence}`] } });
          await turns();
        }
      });
      expect(receipts).toBe(8); expect(publications).toBe(8);
      expect(metrics.stringify).toBeLessThan(500);
      expect(owner.getStatus().phase).toBe("detached");
      console.info("detached-owner-replay", { bytes: new TextEncoder().encode(JSON.stringify(state)).length, edits: 8, reads, publications, receipts, ...metrics });
    } finally { owner.dispose(); }
  });

  it("measures duplicate incoming snapshots and action receipts without changing current references", async () => {
    const state = historyFixture();
    const data: DetachedInit = { pluginId: "perf", tabId: "perf", registrationId: "reg", windowId: "window", label: "window", title: "Performance fixture", rendererExport: "Detached", code: "", css: "", labels, snapshot: { revision: 1, state }, dark: false, nextSequence: 1, unresolvedSequences: [] };
    const h = harness((command, request) => command === "plugin_window_init" ? data : command === "plugin_window_action"
      ? { sequence: request.sequence, ok: true, value: null, snapshot: { revision: 1, state } } : undefined);
    const client = createDetachedSurfaceClient({ transport: h.transport });
    try {
      await client.init(); const previous = client.getSnapshot(); let notifications = 0;
      client.subscribe(() => { notifications++; });
      const duplicates = await measure(() => { for (let i = 0; i < 8; i++) h.emit(EVENTS.snapshot, { ...data, snapshot: { revision: 1, state } }); });
      expect(notifications).toBe(0);
      console.info("detached-duplicate-replay", { snapshots: 8, notifications, ...duplicates });
      const receipts = await measure(async () => { for (let i = 0; i < 8; i++) await client.dispatch({ name: "draft", args: [""] }); });
      expect(receipts.fullStateParse).toBe(8);
      console.info("detached-receipt-replay", { receipts: 8, ...receipts });
      expect(client.getSnapshot()).toBe(previous);
      expect(client.getStatus().phase).toBe("detached");
    } finally { client.dispose(); }
  });
});
