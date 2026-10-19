import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitSessionActivated,
  pluginBus,
  resetPluginBusForTests,
  SESSION_ACTIVATED_TOPIC,
  USAGE_UPDATED_TOPIC,
  bridgeHostChatFocusEvents,
  forwardUsageEvent,
  USAGE_DONE_TOPIC,
} from "./events";
import type { HostChatSession } from "@ccgui/plugin-sdk";

describe("pluginBus retained topics", () => {
  beforeEach(() => resetPluginBusForTests());

  it("replays the latest active session to a late subscriber", () => {
    // 宿主在应用启动、插件还没加载完时就发过事件
    emitSessionActivated("codex", "s-1");

    const seen: unknown[] = [];
    pluginBus.on(SESSION_ACTIVATED_TOPIC, (data) => seen.push(data));

    // 迟到的订阅者立刻拿到当前值
    expect(seen).toEqual([{ engine: "codex", sessionId: "s-1" }]);

    emitSessionActivated("claude", "s-2");
    expect(seen).toEqual([
      { engine: "codex", sessionId: "s-1" },
      { engine: "claude", sessionId: "s-2" },
    ]);
  });

  it("replays only the newest value, not the history", () => {
    emitSessionActivated("codex", "s-1");
    emitSessionActivated("claude", "s-2");

    const seen: unknown[] = [];
    pluginBus.on(SESSION_ACTIVATED_TOPIC, (data) => seen.push(data));

    expect(seen).toEqual([{ engine: "claude", sessionId: "s-2" }]);
  });

  it("delivers nothing before the first emit", () => {
    const listener = vi.fn();
    pluginBus.on(SESSION_ACTIVATED_TOPIC, listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps other topics fire-and-forget", () => {
    const late = vi.fn();
    pluginBus.emit(USAGE_UPDATED_TOPIC, { kind: "usage" });
    pluginBus.on(USAGE_UPDATED_TOPIC, late);
    expect(late).not.toHaveBeenCalled();

    const live = vi.fn();
    pluginBus.on(USAGE_UPDATED_TOPIC, live);
    pluginBus.emit(USAGE_UPDATED_TOPIC, { kind: "usage", seq: 2 });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after the disposer runs", () => {
    emitSessionActivated("codex", "s-1");
    const listener = vi.fn();
    const dispose = pluginBus.on(SESSION_ACTIVATED_TOPIC, listener);
    expect(listener).toHaveBeenCalledTimes(1);

    dispose();
    emitSessionActivated("claude", "s-2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves each native response's usage without prematurely ending background work", () => {
    const updates = vi.fn(); const done = vi.fn();
    pluginBus.on(USAGE_UPDATED_TOPIC, updates);
    pluginBus.on(USAGE_DONE_TOPIC, done);
    const base = { engine: "claude", runId: "native", sessionId: "s", seq: 1, ts: 123, genMs: 20 };
    forwardUsageEvent({ ...base, kind: "turn_complete", data: { usage: { output_tokens: 7 } } });
    forwardUsageEvent({ ...base, seq: 2, kind: "turn_complete", data: { usage: { output_tokens: 11 } } });
    expect(done).not.toHaveBeenCalled();
    expect(updates.mock.calls.map(([event]) => event.data.output_tokens)).toEqual([7, 11]);
    expect(updates.mock.calls[0][0]).toEqual({ ...base, kind: "usage", data: { output_tokens: 7 } });
    forwardUsageEvent({ ...base, seq: 3, kind: "done", data: { usage: null } });
    expect(done).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledTimes(2);
  });

  it("forwards an interrupted response's usage as a nonterminal update, not a done", () => {
    const updates = vi.fn(); const done = vi.fn();
    pluginBus.on(USAGE_UPDATED_TOPIC, updates);
    pluginBus.on(USAGE_DONE_TOPIC, done);
    const base = { engine: "claude", runId: "native", sessionId: "s", seq: 1, ts: 123, genMs: 20 };
    forwardUsageEvent({ ...base, kind: "turn_complete", data: { usage: { output_tokens: 3 }, interrupted: true } });
    // 打断只结束这次回复，运行（及后台任务）仍开着：用量照常上报，data 只是用量。
    expect(done).not.toHaveBeenCalled();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0][0]).toEqual({ ...base, kind: "usage", data: { output_tokens: 3 } });
    // 被打断且没有可用用量的响应不发出空更新。
    forwardUsageEvent({ ...base, seq: 2, kind: "turn_complete", data: { usage: null, interrupted: true } });
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing retained listener", () => {
    emitSessionActivated("codex", "s-1");
    const good = vi.fn();
    expect(() =>
      pluginBus.on(SESSION_ACTIVATED_TOPIC, () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    pluginBus.on(SESSION_ACTIVATED_TOPIC, good);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("host native window attention", () => {
  beforeEach(() => resetPluginBusForTests());
  const target: HostChatSession = { client: "ccgui", engine: "claude", nativeSessionId: "11111111-1111-1111-1111-111111111111",
    guiSessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/one", clientInstanceId: "desktop-1", windowId: "window-1", status: "idle" };
  it("emits exact host focus metadata once native focus arrives, retains it, and leaves selection on blur", async () => {
    let focus!: (focused: boolean) => void; const unlisten = vi.fn(); const current = vi.fn(async () => target);
    emitSessionActivated("claude", target.nativeSessionId);
    const listener = vi.fn(); pluginBus.on(SESSION_ACTIVATED_TOPIC, listener);
    const dispose = await bridgeHostChatFocusEvents({ desktop: true, current, onFocusChanged: async (cb) => { focus = cb; return unlisten; } });
    expect(current).not.toHaveBeenCalled(); focus(false); expect(listener).toHaveBeenCalledTimes(1);
    focus(true);
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({ engine: "claude", sessionId: target.nativeSessionId, origin: "host", reason: "window-focus", target }));
    const attention = listener.mock.calls.at(-1)![0]; expect(Object.isFrozen(attention)).toBe(true); expect(Object.isFrozen(attention.target)).toBe(true);
    focus(false); const late = vi.fn(); pluginBus.on(SESSION_ACTIVATED_TOPIC, late); expect(late).toHaveBeenCalledWith(attention);
    dispose(); focus(true); expect(current).toHaveBeenCalledTimes(1); expect(unlisten).toHaveBeenCalledTimes(1);
  });
  it("suppresses async focus reads after blur, disposal, and missing native target", async () => {
    let focus!: (focused: boolean) => void; let resolve!: (value: HostChatSession | null) => void;
    const dispose = await bridgeHostChatFocusEvents({ desktop: true, current: () => new Promise((r) => { resolve = r; }), onFocusChanged: async (cb) => { focus = cb; return () => {}; } });
    const listener = vi.fn(); pluginBus.on(SESSION_ACTIVATED_TOPIC, listener);
    focus(true); focus(false); resolve(target); await new Promise((r) => setTimeout(r, 0)); expect(listener).not.toHaveBeenCalled();
    focus(true); resolve(null); await new Promise((r) => setTimeout(r, 0)); expect(listener).not.toHaveBeenCalled();
    focus(true); dispose(); resolve(target); await new Promise((r) => setTimeout(r, 0)); expect(listener).not.toHaveBeenCalled();
  });
  it("does not register native focus or claim desktop attention on a Web surface", async () => {
    const onFocusChanged = vi.fn(); const current = vi.fn();
    (await bridgeHostChatFocusEvents({ desktop: false, current, onFocusChanged }))();
    expect(onFocusChanged).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
  });
  it("cleans up a native registration that resolves after pagehide", async () => {
    let registered!: (unlisten: () => void) => void; const unlisten = vi.fn();
    const setup = bridgeHostChatFocusEvents({ desktop: true, current: async () => target, onFocusChanged: () => new Promise((r) => { registered = r; }) });
    window.dispatchEvent(new Event("pagehide")); registered(unlisten); const dispose = await setup; dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
