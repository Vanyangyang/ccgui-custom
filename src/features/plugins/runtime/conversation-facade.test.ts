import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  sideState: {} as Record<string, any>,
  engines: [
    { id: "claude", available: true, enabled: true, defaultModel: "opus", defaultEffort: "high" },
    { id: "agy", available: true, enabled: true, supportsImages: true, defaultModel: "gemini-4-argon-high", defaultEffort: "high" },
  ],
  support: vi.fn(async (_engine?: string) => true),
  models: vi.fn(async (id: string) => [{ id: id === "agy" ? "gemini-4-argon-high" : "opus", name: id === "agy" ? "Gemini 4 Argon High" : "Opus" }]),
  config: { claude: { providers: {}, current: null }, agy: { providers: { channel: { name: "AGY custom", apiKey: "must-not-leak" } }, current: "channel" } },
}));
vi.mock("./task-facade", () => ({ desktopTaskFacade: async () => ({
  ready: async () => {}, engines: () => f.engines, models: f.models,
  workspaces: () => [], projects: async () => [], activeEngine: () => "agy",
}), registeredWorkspace: vi.fn() }));
vi.mock("@/features/sidechat/store", () => ({ useSidechatStore: {
  getState: () => ({ sidechatBySession: f.sideState }), subscribe: vi.fn(),
  setState: (update: (s: { sidechatBySession: Record<string, any> }) => { sidechatBySession: Record<string, any> }) => {
    f.sideState = update({ sidechatBySession: f.sideState }).sidechatBySession;
  },
} }));
vi.mock("@/lib/ipc", () => ({ ipc: { getCliConfig: async () => f.config } }));
vi.mock("@/lib/transport", () => ({ invoke: vi.fn() }));
vi.mock("./fixed-instructions", () => ({ nativeFixedInstructionsSupported: f.support }));
import { desktopConversationFacade } from "./conversation-facade";

beforeEach(() => { f.engines[1].available = true; f.engines[1].enabled = true; f.models.mockClear(); f.support.mockImplementation(async () => true); });
it("publishes native AGY models and named channels without secrets or independent effort", async () => {
  const catalog = await (await desktopConversationFacade()).catalog();
  expect(catalog.defaultEngine).toBe("agy");
  expect(catalog.engines.find(e => e.id === "agy")).toEqual({ id: "agy", label: "AGY", available: true, supportsImages: true, supportsFixedInstructions: true,
    models: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon High" }], providers: [{ id: "__local_settings_json__", label: expect.any(String) }, { id: "channel", label: "AGY custom" }],
    efforts: [], defaultModel: "gemini-4-argon-high", defaultEffort: null, defaultProviderId: "channel" });
  expect(JSON.stringify(catalog)).not.toContain("must-not-leak");
  expect(catalog.engines.find(e => e.id === "claude")?.defaultEffort).toBe("high");
});
it.each(["available", "enabled"] as const)("does not publish AGY when %s is false", async field => {
  f.engines[1][field] = false;
  const catalog = await (await desktopConversationFacade()).catalog();
  expect(catalog.engines.some(e => e.id === "agy")).toBe(false);
  expect(f.models).not.toHaveBeenCalledWith("agy");
});
it("keeps legacy global capability while explicitly disabling AGY on old hosts", async () => {
  f.support.mockImplementation(async engine => engine !== "agy");
  const catalog = await (await desktopConversationFacade()).catalog();
  expect(catalog.capabilities?.fixedInstructions).toBe(true);
  expect(catalog.engines.find(e => e.id === "agy")?.supportsFixedInstructions).toBe(false);
  expect(catalog.engines.find(e => e.id === "claude")?.supportsFixedInstructions).toBe(true);
});
it("releases only the same idle state and never discards new activity or drafts", async () => {
  const facade = await desktopConversationFacade();
  const idle = { streaming: false, runId: null, draft: "", messages: [{ text: "完整原文😀" }] } as any;
  f.sideState = { owned: idle, other: { ...idle } };
  expect(facade.release!("owned", { ...idle })).toBe(false);
  expect(facade.release!("owned", idle)).toBe(true);
  expect(f.sideState.owned).toBeUndefined(); expect(f.sideState.other).toBeDefined();
  for (const patch of [{ streaming: true }, { runId: "sidechat-live" }, { draft: "未发送" }, { draftImages: ["image"] }]) {
    const protectedState = { ...idle, ...patch };
    f.sideState = { owned: protectedState };
    expect(facade.release!("owned", protectedState)).toBe(false);
    expect(f.sideState.owned).toBe(protectedState);
  }
});
