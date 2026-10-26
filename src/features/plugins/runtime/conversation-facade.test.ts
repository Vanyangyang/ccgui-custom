import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  task: { ready: vi.fn(), activeEngine: () => "claude", engines: () => [{ id: "claude", available: true, enabled: true, defaultModel: "opus", defaultEffort: "high" }, { id: "codex", available: true, enabled: false }],
    models: async () => [{ id: "opus", name: "Opus" }],
    projects: async () => [{ id: "project", defaultPath: "C:/work", members: [{ id: "member", path: "C:/member", label: "Member", status: "available" }] }],
    workspaces: () => [{ id: "local", path: "C:/work", name: "Local", remote: false, archived: false }, { id: "remote", path: "/remote", remote: true }] },
  getCliConfig: vi.fn(), send: vi.fn(), stop: vi.fn(), interrupt: vi.fn(), subscribe: vi.fn(), invoke: vi.fn(),
  state: { sidechatBySession: {} as Record<string, any> },
}));
vi.mock("./task-facade", () => ({ desktopTaskFacade: async () => mocks.task,
  registeredWorkspace: (_: unknown, path: string) => mocks.task.workspaces().find((w) => w.path === path) }));
vi.mock("@/lib/ipc", () => ({ ipc: { getCliConfig: mocks.getCliConfig, interruptSession: mocks.interrupt } }));
vi.mock("@/lib/transport", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/sidechat/store", () => ({ useSidechatStore: {
  getState: () => ({ ...mocks.state, sendSidechatMessage: mocks.send, stopSidechat: mocks.stop }),
  setState: (fn: (s: typeof mocks.state) => typeof mocks.state) => Object.assign(mocks.state, fn(mocks.state)), subscribe: mocks.subscribe,
} }));
import { desktopConversationFacade } from "./conversation-facade";
it("delegates ownership and selection resolution to native commands", async () => {
  const facade = await desktopConversationFacade();
  await facade.claim("plugin", "thread");
  expect(mocks.invoke).toHaveBeenCalledWith("plugin_conversation_claim", { pluginId: "plugin", threadId: "thread" });
  const selection = { engine: "claude" as const, model: "opus", effort: "high", providerId: "channel" };
  mocks.invoke.mockResolvedValueOnce({ ...selection, model: "claude-opus-exact" });
  expect(await facade.resolveSelection("plugin", selection)).toEqual({ ...selection, model: "claude-opus-exact" });
  expect(mocks.invoke).toHaveBeenLastCalledWith("plugin_conversation_resolve", { pluginId: "plugin", selection });
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.state.sidechatBySession = {};
  mocks.getCliConfig.mockResolvedValue({ claude: { current: "channel", providers: { channel: { name: "Named channel", apiKey: "secret", env: { TOKEN: "secret" } } } } });
});
it("projects only installed enabled choices and never leaks provider credentials", async () => {
  const facade = await desktopConversationFacade();
  const catalog = await facade.catalog();
  expect(catalog.engines).toHaveLength(1);
  expect(catalog.defaultEngine).toBe("claude");
  expect(catalog.engines[0]).toMatchObject({ defaultProviderId: "channel", models: [{ id: "opus", label: "Opus" }] });
  expect(JSON.stringify(catalog)).not.toContain("secret");
  await expect(facade.workspace("/remote")).rejects.toThrow("local");
  expect(await facade.workspace("C:/member")).toBe("C:/member");
});
it("launches only controlled parentless branches with frozen choices and stops exact runs", async () => {
  const facade = await desktopConversationFacade();
  mocks.invoke.mockResolvedValueOnce(["C:/pasted/img1.png"]);
  expect(await facade.resolveImages!("plugin", ["img1"])).toEqual(["C:/pasted/img1.png"]);
  expect(mocks.invoke).toHaveBeenLastCalledWith("plugin_image_resolve", { pluginId: "plugin", imageIds: ["img1"] });
  await facade.send("key", "C:/work", { engine: "claude", model: "opus", providerId: "channel" }, "prompt", "sidechat-1", ["C:/pasted/img1.png"]);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ strictBusy: true, requestedRunId: "sidechat-1", parentSessionId: null, parentMessages: [], providerId: "channel", images: ["C:/pasted/img1.png"] }));
  mocks.state.sidechatBySession.key = { streaming: true, runId: "sidechat-other" };
  await facade.stop("key", "sidechat-1"); expect(mocks.interrupt).not.toHaveBeenCalled();
  mocks.state.sidechatBySession.key.runId = "sidechat-1";
  await facade.stop("key", "sidechat-1"); expect(mocks.interrupt).toHaveBeenCalledWith("sidechat-1");
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.state.sidechatBySession.key.streaming).toBe(true);
});
