import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";
import { HOST_HANDOFF_KEY_PREFIX } from "./handoff-bridge";
import { HANDOFF_PREFERENCES_KEY } from "@/features/chat/handoff-preferences";

const env = vi.hoisted(() => ({ web: false, label: "main" }));
const summaries = vi.hoisted(() => ({ coordinator: vi.fn(async () => "Full coordinator history"), child: vi.fn(async () => "Full child history") }));
vi.mock("./task-bridge", async original => ({ ...await original<object>(), createHostTaskBridge: vi.fn(() => ({
  summarizeCoordinatorHandoff: summaries.coordinator, summarizeManagedHandoff: summaries.child, dispose: () => {},
})) }));
const picker = vi.hoisted(() => ({ choose: vi.fn(), catalog: vi.fn(), focusMain: vi.fn(), open: vi.fn(), status: { phase: "detached", windowId: "workbench-window" }, trace: [] as string[] }));
vi.mock("./composer-draft", () => ({ setActiveComposerDraft: vi.fn() }));
vi.mock("@/lib/transport", async original => ({ ...await original<object>(), get isWeb() { return env.web; },
  invoke: vi.fn(async (command: string) => command === "handoff_full_history_supported" ? true : null), listen: vi.fn(async () => () => {}), serverVersion: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: env.label,
  unminimize: () => { throw Error("Command plugin:window|unminimize not allowed by ACL"); },
  show: () => { throw Error("Command plugin:window|show not allowed by ACL"); },
  setFocus: () => { throw Error("Command plugin:window|set_focus not allowed by ACL"); },
}) }));
vi.mock("@/features/chat/handoff-model-picker", () => ({ chooseHandoffModel: picker.choose }));
vi.mock("@/features/chat/handoff-model-catalog", () => ({ readHandoffModelCatalog: picker.catalog }));
vi.mock("../windows/owner", () => ({ createDetachedSurfaceOwner: () => ({
  focusMain: picker.focusMain, open: picker.open, getStatus: () => picker.status,
  dispose: () => {}, restore: async () => null, flushPresentation: async () => {},
  checkpointParticipant: "plugin-window-owner:picker-test", subscribeStatus: () => () => {},
}) }));
const cleanup: (() => void)[] = [];
let nextId = 0;
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto); vi.clearAllMocks();
  picker.status = { phase: "detached", windowId: "workbench-window" }; picker.trace = [];
  picker.focusMain.mockImplementation(async () => { picker.trace.push("focus-owner"); });
  picker.open.mockImplementation(async () => { picker.trace.push("focus-workbench"); });
  picker.choose.mockImplementation(async () => { picker.trace.push("picker-open"); return { engine: "codex", model: "selected-model", effort: "high" }; });
  picker.catalog.mockImplementation(async selection => ({ selection, engines: [] }));
});
afterEach(() => { env.web = false; env.label = "main"; for (const off of cleanup.splice(0)) off(); vi.unstubAllGlobals(); localStorage.clear(); });
function fixture(permissions: string[]) {
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => "原生摘要核心返回的测试结果，保持源话题不变。");
  const data = new Map<string, unknown>();
  const backend: PluginContextBackend = { get: async (_, key) => data.get(key), set: async (_, key, value) => { data.set(key, value); }, delete: async () => {}, bridgeInvoke: invoke };
  const manifest: PluginManifest = { id: "handoff-owner-" + (++nextId), name: "Handoff", version: "1", tier: "js", permissions };
  const handle = createPluginContext(manifest, backend, { appVersion: "1", detachedBundle: () => ({ code: "fixture-bundle", css: "", rendererExports: new Set(["fixtureWindow"]) }) });
  cleanup.push(() => { for (const off of [...handle.disposers].reverse()) off(); });
  return { ...handle, invoke, data };
}
const request = { handoffId: "topic", requestId: "summary-1", expectedRevision: 0, text: "用户提供的交接摘录中文🙂" };
function registerFloating(h: ReturnType<typeof fixture>) {
  h.ctx.ui.registerCenterTab({ key: "workbench", title: () => "Workbench", component: () => null,
    detached: { rendererExport: "fixtureWindow", getSnapshot: () => ({ draft: "preserved" }), subscribe: () => () => {}, dispatch: async () => false } });
}

describe("ctx.handoff capability", () => {
  it.each(["host:chat", "host:tasks"])("requires both permissions for coordinator history: %s", async permission => {
    const h = fixture([permission]);
    await expect(h.ctx.handoff.summarize({ handoffId: "root", requestId: "one", expectedRevision: 0,
      source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1 } })).rejects.toThrow(permission === "host:chat" ? "host:tasks" : "host:chat");
    expect(summaries.coordinator).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
  });
  it("routes the coordinator kind with both permissions without exposing the internal task method", async () => {
    const h = fixture(["host:chat", "host:tasks"]);
    const source = { kind: "coordinator" as const, conversationRequestId: "root", expectedRevision: 2 };
    const selection = { engine: "codex" as const, model: "selected" };
    const request = { handoffId: "root", requestId: "one", expectedRevision: 0, source, selection };
    await h.ctx.handoff.summarize(request);
    await vi.waitFor(async () => expect((await h.ctx.handoff.inspect("root"))?.status).toBe("completed"));
    await h.ctx.handoff.summarize(request);
    expect(summaries.coordinator).toHaveBeenCalledExactlyOnceWith(source, selection, expect.any(Function));
    expect(summaries.child).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    expect(h.ctx.tasks).not.toHaveProperty("summarizeCoordinatorHandoff");
  });
  it("serves the shared safe catalog to a floating workbench without focusing either window or opening a modal", async () => {
    const h = fixture(["host:chat", "ui:center-tab", "ui:detached-window"]); registerFloating(h);
    const selection = { engine: "codex" as const, model: "chosen", providerId: "channel", effort: "high" };
    expect(await h.ctx.handoff.catalog!({ selection })).toEqual({ selection, engines: [] });
    expect(picker.catalog).toHaveBeenCalledExactlyOnceWith(selection);
    expect(picker.trace).toEqual([]); expect(picker.choose).not.toHaveBeenCalled(); expect(h.invoke).not.toHaveBeenCalled();
    expect(picker.status).toEqual({ phase: "detached", windowId: "workbench-window" });
  });
  it("opens a docked model picker without forbidden window builtins or inference", async () => {
    const h = fixture(["host:chat"]);
    expect(await h.ctx.handoff.chooseModel!()).toEqual({ engine: "codex", model: "selected-model", effort: "high" });
    expect(picker.trace).toEqual(["picker-open"]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses the authenticated owner focus path and returns to the same floating view, cancelled=%s", async cancelled => {
    const h = fixture(["host:chat", "ui:center-tab", "ui:detached-window"]); registerFloating(h);
    if (cancelled) picker.choose.mockImplementation(async () => { picker.trace.push("picker-open"); return null; });
    const choice = await h.ctx.handoff.chooseModel!({ workspacePath: "G:/Synthetic" });
    expect(choice).toEqual(cancelled ? null : { engine: "codex", model: "selected-model", effort: "high" });
    expect(picker.trace).toEqual(["focus-owner", "picker-open", "focus-workbench"]);
    expect(picker.status).toEqual({ phase: "detached", windowId: "workbench-window" });
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it.each(["closed", "replaced"]) ("does not reopen a %s floating view after the picker closes", async change => {
    const h = fixture(["host:chat", "ui:center-tab", "ui:detached-window"]); registerFloating(h);
    picker.choose.mockImplementation(async () => {
      picker.trace.push("picker-open");
      picker.status = change === "closed" ? { phase: "docked", windowId: "workbench-window" } : { phase: "detached", windowId: "replacement-window" };
      return null;
    });
    expect(await h.ctx.handoff.chooseModel!()).toBeNull();
    expect(picker.trace).toEqual(["focus-owner", "picker-open"]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("requires host:chat on every entry point", async () => {
    const h = fixture(["host:tasks"]);
    for (const call of [() => h.ctx.handoff.catalog!(), () => h.ctx.handoff.chooseModel!(), () => h.ctx.handoff.preferences(), () => h.ctx.handoff.summarize(request), () => h.ctx.handoff.inspect("topic"), () => h.ctx.handoff.discard("topic", "summary-1")]) {
      await expect(call()).rejects.toThrow("host:chat");
    }
    expect(() => h.ctx.handoff.onEvent(() => {})).toThrow("host:chat");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("rejects web and detached contexts, including their preference and observation entry points", async () => {
    const h = fixture(["host:chat"]);
    env.web = true;
    await expect(h.ctx.handoff.catalog!()).rejects.toThrow("desktop owner");
    await expect(h.ctx.handoff.preferences()).rejects.toThrow("desktop owner");
    await expect(h.ctx.handoff.summarize(request)).rejects.toThrow("desktop owner");
    env.web = false; env.label = "plugin-window-test";
    const previous = window.__TAURI_INTERNALS__;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: { metadata: {} } });
    try {
      await expect(h.ctx.handoff.catalog!()).rejects.toThrow("desktop owner");
      await expect(h.ctx.handoff.preferences()).rejects.toThrow("desktop owner");
      await expect(h.ctx.handoff.inspect("topic")).rejects.toThrow("desktop owner");
      await expect(h.ctx.handoff.discard("topic", "summary-1")).rejects.toThrow("desktop owner");
      expect(() => h.ctx.handoff.onEvent(() => {})).toThrow("desktop owner");
    } finally { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: previous }); }
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("uses global /handoff routing, stamps plugin ownership and keeps its storage and command private", async () => {
    localStorage.setItem(HANDOFF_PREFERENCES_KEY, JSON.stringify({ enabled: false, selection: { engine: "codex", model: "host-codex", effort: "high" } }));
    const h = fixture(["host:chat", "storage"]);
    expect(await h.ctx.handoff.preferences()).toEqual({ enabled: false, selection: { engine: "codex", model: "host-codex", effort: "high" } });
    const event = vi.fn(); h.ctx.handoff.onEvent(event);
    await h.ctx.handoff.summarize(request);
    await vi.waitFor(async () => expect((await h.ctx.handoff.inspect("topic"))?.status).toBe("completed"));
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith("plugin_summarize_handoff", {
      pluginId: h.manifest.id, title: undefined, transcriptExcerpt: request.text, childContext: undefined,
      compressionSelection: { engine: "codex", model: "host-codex", effort: "high" },
      fullHistory: true,
    });
    expect(event).toHaveBeenCalledTimes(2);
    await expect(h.ctx.bridge.invoke("plugin_summarize_handoff", { pluginId: "other", transcriptExcerpt: request.text })).rejects.toThrow();
    // As with the existing conversation/task ledgers, own-namespace reads are
    // permitted, but plugins cannot forge or delete the host's request fence.
    for (const call of [() => h.ctx.storage.set(HOST_HANDOFF_KEY_PREFIX + "topic", {}), () => h.ctx.storage.delete(HOST_HANDOFF_KEY_PREFIX + "topic")]) {
      await expect(call()).rejects.toThrow("reserved");
    }
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
  it("requires task ownership capability before resolving managed-child history", async () => {
    const h = fixture(["host:chat"]);
    await expect(h.ctx.handoff.summarize({ handoffId: "owned", requestId: "one", expectedRevision: 0,
      source: { kind: "managedChild", conversationRequestId: "parent", expectedRevision: 1, approvalId: "leader:child", approvalRequestId: "held", sourceStamp: "a".repeat(64) } })).rejects.toThrow("host:tasks");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
