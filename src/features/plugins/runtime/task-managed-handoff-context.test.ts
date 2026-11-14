import { describe, expect, it, vi } from "vitest";
import type { HostTaskCostApproval, PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext } from "./context";
import type { HostTaskBridgeDependencies } from "./task-bridge";

const captured = vi.hoisted(() => ({ deps: undefined as HostTaskBridgeDependencies | undefined }));
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("./task-bridge", () => ({ HOST_TASKS_KEY_PREFIX: "__host_tasks_v1:", createHostTaskBridge: (_id: string, _backend: unknown, deps: HostTaskBridgeDependencies) => {
  captured.deps = deps; return { dispose: () => {}, catalog: async () => ({}) };
} }));
const approval: HostTaskCostApproval = { kind: "leader", id: "leader:a", requestId: "approval-a",
  sender: { engine: "codex", sessionId: "parent", workspacePath: "G:/parent" },
  target: { engine: "agy", sessionId: "child", workspacePath: "G:/child" },
  model: "gemini-model", message: "Original pending message", truncated: false, cacheHeat: "unknown", usageKind: "unknown", capturedAt: 1, canHandoff: true };
describe("managed handoff native confirmation boundary", () => {
  it("routes structured handoff content through the isolated host confirmation", async () => {
    const bridgeInvoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => true);
    const context = createPluginContext({ id: "test", name: "Test", version: "1.0", tier: "js", permissions: ["host:tasks"] } as PluginManifest,
      { bridgeInvoke, get: async () => null, set: async () => {}, delete: async () => {} }, { appVersion: "1" });
    await context.ctx.tasks.catalog();
    expect(await captured.deps!.confirmManagedHandoff!(approval, "Exact summary 🙂")).toBe(true);
    const [command, args] = bridgeInvoke.mock.calls[0] as unknown as [string, { request: { content: unknown } }];
    expect(command).toBe("plugin_window_confirm_cost_review");
    for (const text of ["parent", "child", "G:/parent", "G:/child", "gemini-model", approval.message, "Exact summary 🙂"]) expect(JSON.stringify(args.request.content)).toContain(text);
    bridgeInvoke.mockResolvedValueOnce({ confirmed: true } as never);
    expect(await captured.deps!.confirmManagedHandoff!(approval, "summary")).toBe(false);
  });
  it("preserves the complete Unicode summary and explicitly identifies an incomplete source preview", async () => {
    const bridgeInvoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => false);
    const context = createPluginContext({ id: "test", name: "Test", version: "1.0", tier: "js", permissions: ["host:tasks"] } as PluginManifest,
      { bridgeInvoke, get: async () => null, set: async () => {}, delete: async () => {} }, { appVersion: "1" });
    await context.ctx.tasks.catalog();
    expect(await captured.deps!.confirmManagedHandoff!({ ...approval, message: "🙂".repeat(1200), truncated: true }, "🙂".repeat(4000))).toBe(false);
    const args = bridgeInvoke.mock.calls[0][1] as unknown as { request: { content: { sections: { title: string; body: string }[] } } };
    expect(args.request.content.sections[0].body).toBe("🙂".repeat(1200));
    expect(args.request.content.sections[0].title).toMatch(/excerpt|摘录/);
    expect(args.request.content.sections[1].body).toBe("🙂".repeat(4000));
  });
  it("shows the independently resolved successor model, provider and effort alongside the unchanged source", async () => {
    const bridgeInvoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => true);
    const context = createPluginContext({ id: "test", name: "Test", version: "1.0", tier: "js", permissions: ["host:tasks"] } as PluginManifest,
      { bridgeInvoke, get: async () => null, set: async () => {}, delete: async () => {} }, { appVersion: "1" });
    await context.ctx.tasks.catalog();
    await captured.deps!.confirmManagedHandoff!(approval, "summary", { engine: "codex", model: "selected-model", providerId: "selected-provider", effort: "high" });
    const args = bridgeInvoke.mock.calls[0][1] as unknown as { request: { content: { fields: { label: string; value: string }[] } } };
    expect(args.request.content.fields.some(field => field.value === "gemini-model")).toBe(true);
    expect(args.request.content.fields.find(field => field.value.includes("selected-model"))?.value).toMatch(/codex.*selected-model[\s\S]*selected-provider[\s\S]*high/);
  });
});
