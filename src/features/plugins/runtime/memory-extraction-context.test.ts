import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";

const env = vi.hoisted(() => ({ web: false, label: "main" }));
vi.mock("./composer-draft", () => ({ setActiveComposerDraft: vi.fn() }));
vi.mock("@/lib/transport", async original => ({ ...await original<object>(), get isWeb() { return env.web; },
  invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), serverVersion: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: env.label }) }));
vi.mock("./conversation-bridge", () => ({ HOST_CONVERSATIONS_KEY_PREFIX: "__host_conversations_v1:",
  createHostConversationBridge: () => ({ inspect: vi.fn(async () => ({ status: "completed" })), dispose: vi.fn() }) }));
vi.mock("./task-bridge", () => ({ HOST_TASKS_KEY_PREFIX: "__host_tasks_v1:",
  createHostTaskBridge: () => ({ conversation: vi.fn(async () => ({ status: "idle" })), dispose: vi.fn() }) }));
const cleanups: (() => void)[] = [];
afterEach(() => { env.web = false; env.label = "main"; for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(permissions: string[]) {
  const invoke = vi.fn(async (command: string) => command === "plugin_memory_status" ? { available: true, busy: false, retryAfterMs: 0 }
    : { status: "deferred", reason: "foreground", retryAfterMs: 30000 });
  const backend: PluginContextBackend = { get: async () => null, set: async () => {}, delete: async () => {}, bridgeInvoke: invoke };
  const manifest: PluginManifest = { id: "memory-owner", name: "Memory", version: "1", tier: "js", permissions };
  const handle = createPluginContext(manifest, backend, { appVersion: "1" });
  cleanups.push(() => { for (const dispose of [...handle.disposers].reverse()) dispose(); });
  return { ...handle, invoke };
}
const request = { requestId: "e1", projectId: "game", source: { kind: "conversation" as const, id: "topic" } };

describe("ctx.memoryExtraction capability", () => {
  it("requires the explicit model-quota permission for every operation", async () => {
    const h = setup(["host:chat", "host:tasks"]);
    for (const call of [() => h.ctx.memoryExtraction.status(), () => h.ctx.memoryExtraction.checkpoint({ projectId: "game", source: request.source }),
      () => h.ctx.memoryExtraction.prepare({ projectId: "game", source: request.source }),
      () => h.ctx.memoryExtraction.extract(request), () => h.ctx.memoryExtraction.cancel("e1")]) await expect(call()).rejects.toThrow(/host:memory/);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("host:memory does not grant access to sources without their existing capability", async () => {
    const h = setup(["host:memory"]);
    await expect(h.ctx.memoryExtraction.status()).resolves.toMatchObject({ available: true });
    await expect(h.ctx.memoryExtraction.extract(request)).rejects.toThrow(/host:chat/);
    await expect(h.ctx.memoryExtraction.prepare({ projectId: "game", source: request.source })).rejects.toThrow(/host:chat/);
    await expect(h.ctx.memoryExtraction.extract({ ...request, source: { kind: "coordination", id: "task" } })).rejects.toThrow(/host:tasks/);
    expect(h.invoke.mock.calls.map(c => c[0])).toEqual(["plugin_memory_status"]);
  });

  it("binds the plugin identity in native calls and denies the generic command escape", async () => {
    const h = setup(["host:memory", "host:chat"]);
    await expect(h.ctx.memoryExtraction.extract(request)).resolves.toMatchObject({ status: "deferred" });
    expect(h.invoke).toHaveBeenCalledWith("plugin_memory_extract", { pluginId: "memory-owner", request });
    await expect(h.ctx.bridge.invoke("plugin_memory_extract", { pluginId: "other", request })).rejects.toThrow();
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not expose native inference through the web or detached owner", async () => {
    const h = setup(["host:memory", "host:chat"]);
    env.web = true;
    await expect(h.ctx.memoryExtraction.status()).rejects.toThrow(/desktop owner/);
    env.web = false; env.label = "plugin-window-game";
    const previous = window.__TAURI_INTERNALS__;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: { metadata: {} } });
    try { await expect(h.ctx.memoryExtraction.extract(request)).rejects.toThrow(/desktop owner/); }
    finally { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: previous }); }
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
