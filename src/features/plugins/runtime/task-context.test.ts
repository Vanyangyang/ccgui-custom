import { describe, expect, it, vi, type Mock } from "vitest";
import type { PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";

vi.mock("./composer-draft", () => ({ setActiveComposerDraft: vi.fn() }));
// This contract test intentionally represents the Web host and never performs
// transport I/O. Do not let imported UI stores open a real reconnecting socket.
vi.mock("@/lib/transport", async original => ({ ...await original<object>(), isWeb: true,
  invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), serverVersion: vi.fn(async () => null) }));

function fakeStorage(): PluginContextBackend & { data: Map<string, unknown>; bridgeInvoke: Mock } {
  const data = new Map<string, unknown>();
  return {
    data,
    bridgeInvoke: vi.fn(async () => null),
    get: async (id, key) => data.get(`${id}:${key}`) ?? null,
    set: async (id, key, value) => void data.set(`${id}:${key}`, value),
    delete: async (id, key) => void data.delete(`${id}:${key}`),
  };
}
const manifest = (permissions: string[]): PluginManifest => ({ id: "task-plugin", name: "T", version: "1.0.0", tier: "js", permissions });

describe("ctx.tasks facade", () => {
  it("gates every task operation behind host:tasks and refuses the web host", async () => {
    const backend = fakeStorage();
    const denied = createPluginContext(manifest([]), backend, { appVersion: "1" });
    for (const call of [
      () => denied.ctx.tasks.catalog(), () => denied.ctx.tasks.history({ workspacePath: "G:/x" }),
      () => denied.ctx.tasks.excerpt({ engine: "claude", sessionId: "s", workspacePath: "G:/x" }),
      () => denied.ctx.tasks.plan({ requestId: "p", goal: "g", projects: [] }), () => denied.ctx.tasks.getPlan("p"),
      () => denied.ctx.tasks.cancelPlan("p"), () => denied.ctx.tasks.submit({} as never), () => denied.ctx.tasks.receipt("r"),
      () => denied.ctx.tasks.list(), () => denied.ctx.tasks.cancel("r"), () => denied.ctx.tasks.open("r"),
      () => denied.ctx.tasks.forget("r"), () => denied.ctx.tasks.slots(),
      () => denied.ctx.tasks.conversation("r"), () => denied.ctx.tasks.sendMessage({ conversationRequestId: "r", requestId: "m", expectedInputRevision: 0, prompt: "hello" }),
      () => denied.ctx.tasks.messageReceipt("r", "m"), () => denied.ctx.tasks.cancelMessage("r", "m"), () => denied.ctx.tasks.stopConversation("r"),
      () => denied.ctx.tasks.conversationAction("r", { type: "openNative", conversationRequestId: "r", expectedRevision: 1 }),
    ]) await expect(call()).rejects.toThrow(/host:tasks/);
    expect(() => denied.ctx.tasks.onEvent(() => {})).toThrow(/host:tasks/);
    expect(() => denied.ctx.tasks.onConversationEvent(() => {})).toThrow(/host:tasks/);
    // jsdom has no __TAURI_INTERNALS__, so the host transport is Web.
    const web = createPluginContext(manifest(["host:tasks"]), backend, { appVersion: "1" });
    await expect(web.ctx.tasks.catalog()).rejects.toThrow(/desktop/);
    expect(() => web.ctx.tasks.onEvent(() => {})).toThrow(/desktop/);
    await expect(web.ctx.tasks.conversation("r")).rejects.toThrow(/desktop/);
    expect(() => web.ctx.tasks.onConversationEvent(() => {})).toThrow(/desktop/);
    expect(backend.bridgeInvoke).not.toHaveBeenCalled();
    expect(backend.data.size).toBe(0);
  });

  it("reserves the host task ledger keys inside the plugin's own storage", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(manifest(["storage"]), backend, { appVersion: "1" });
    await expect(ctx.storage.set("__host_tasks_v1:index", { forged: true })).rejects.toThrow(/reserved/);
    await expect(ctx.storage.delete("__host_tasks_v1:plans")).rejects.toThrow(/reserved/);
    await ctx.storage.set("workspace:mine", 1);
    expect([...backend.data.keys()]).toEqual(["task-plugin:workspace:mine"]);
  });
});
