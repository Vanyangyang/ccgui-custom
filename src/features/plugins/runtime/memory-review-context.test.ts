import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryReviewRequest, PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";

const env = vi.hoisted(() => ({ web: false, label: "main" }));
vi.mock("./composer-draft", () => ({ setActiveComposerDraft: vi.fn() }));
vi.mock("@/lib/transport", async original => ({ ...await original<object>(), get isWeb() { return env.web; },
  invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), serverVersion: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: env.label }) }));
const cleanups: (() => void)[] = [];
afterEach(() => { env.web = false; env.label = "main"; for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(permissions: string[]) {
  const invoke = vi.fn(async (command: string) => command === "plugin_memory_status" ? { available: true, busy: false, retryAfterMs: 0 }
    : { status: "deferred", reason: "foreground", retryAfterMs: 30000 });
  const backend: PluginContextBackend = { get: async () => null, set: async () => {}, delete: async () => {}, bridgeInvoke: invoke };
  const manifest: PluginManifest = { id: "review-owner", name: "Review", version: "1", tier: "js", permissions };
  const handle = createPluginContext(manifest, backend, { appVersion: "1" });
  cleanups.push(() => { for (const dispose of [...handle.disposers].reverse()) dispose(); });
  return { ...handle, invoke };
}
const request = (): MemoryReviewRequest => ({ requestId: "review", projectId: "game", batchId: "batch", root: {
  id: "root", revision: 1, kind: "decision", title: "t", text: "text", conditions: [], authority: "assistant_recorded",
  source: { kind: "ai_background_extract", role: "assistant", complete: false, text: "{}", sourceKind: "conversation" },
}, candidates: [] });

describe("ctx.host.memoryReview capability", () => {
  it("requires host:memory and the existing source grant before native invocation", async () => {
    const noMemory = setup(["host:chat"]);
    await expect(noMemory.ctx.host.memoryReview.status()).rejects.toThrow(/host:memory/);
    await expect(noMemory.ctx.host.memoryReview.review(request())).rejects.toThrow(/host:memory/);
    expect(noMemory.invoke).not.toHaveBeenCalled();
    const noSource = setup(["host:memory"]);
    await expect(noSource.ctx.host.memoryReview.review(request())).rejects.toThrow(/host:chat/);
    const r = request(); r.root.source.sourceKind = "coordination";
    await expect(noSource.ctx.host.memoryReview.review(r)).rejects.toThrow(/host:tasks/);
    expect(noSource.invoke).not.toHaveBeenCalled();
  });
  it("binds plugin identity, keeps provenance verification native, denies generic escape", async () => {
    const h = setup(["host:memory", "host:chat"]);
    await expect(h.ctx.host.memoryReview.review(request())).resolves.toMatchObject({ status: "deferred" });
    expect(h.invoke).toHaveBeenCalledWith("plugin_memory_review", { pluginId: "review-owner", request: request() });
    await expect(h.ctx.bridge.invoke("plugin_memory_review", { pluginId: "foreign", request: request() })).rejects.toThrow();
  });
  it("does not expose inference to web or detached windows", async () => {
    const h = setup(["host:memory", "host:chat"]); env.web = true;
    await expect(h.ctx.host.memoryReview.status()).rejects.toThrow(/desktop owner/);
    env.web = false; env.label = "plugin-window-game";
    const previous = window.__TAURI_INTERNALS__;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: { metadata: {} } });
    try { await expect(h.ctx.host.memoryReview.review(request())).rejects.toThrow(/desktop owner/); }
    finally { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, writable: true, value: previous }); }
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("allows exact owner cancellation cleanup even after capability revocation", async () => {
    const h = setup([]);
    await h.ctx.host.memoryReview.cancel("review");
    expect(h.invoke).toHaveBeenCalledWith("plugin_memory_cancel", { pluginId: "review-owner", requestId: "review" });
  });
});
