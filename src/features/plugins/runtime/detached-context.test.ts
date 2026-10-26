import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centerTabRegistry, type PluginManifest } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";
import { createDetachedSurfaceOwner, type DetachedSurfaceOwnerOptions } from "../windows/owner";
import { usePluginTabsStore } from "./center-tabs";
import { canClosePluginViewsForUpdate, preparePluginViewsForUpdate, resumePluginViewsAfterUpdate } from "./update-close";
import { installHardening, resetHardeningForTests } from "./hardening";

vi.mock("./composer-draft", () => ({ setActiveComposerDraft: vi.fn() }));
vi.mock("@/features/chat/center-surfaces", () => ({ dismissCenterSurfaces: vi.fn() }));
vi.mock("@/lib/transport", async original => ({ ...await original<object>(), isWeb: false }));
const fakeOwner = vi.hoisted(() => ({ open: vi.fn(), returnToMain: vi.fn(), dispose: vi.fn(),
  present: vi.fn(), restore: vi.fn(), flushPresentation: vi.fn(), checkpointParticipant: "plugin-window-owner:test",
  getStatus: () => ({ phase: "docked" }), subscribeStatus: () => () => {} }));
vi.mock("../windows/owner", () => ({ createDetachedSurfaceOwner: vi.fn(() => fakeOwner) }));

const backend: PluginContextBackend = { get: async () => null, set: async () => {}, delete: async () => {}, bridgeInvoke: async () => null };
const manifest = (extra = true): PluginManifest => ({ id: "detached-demo", name: "Demo", version: "1.0.0", tier: "js", permissions: ["ui:center-tab", ...(extra ? ["ui:detached-window"] : [])] });
const cleanup: (() => void)[] = [];
beforeEach(() => { fakeOwner.present.mockResolvedValue("docked"); fakeOwner.restore.mockResolvedValue(null); fakeOwner.flushPresentation.mockResolvedValue(undefined); });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { resumePluginViewsAfterUpdate(); for (const dispose of cleanup.splice(0)) dispose(); vi.clearAllMocks(); usePluginTabsStore.setState({ tabs: [], activeId: null }); });
function handle(extra = true, rendererExports = new Set(["createWindow"])) {
  const h = createPluginContext(manifest(extra), backend, { appVersion: "1", detachedBundle: () => ({ code: "bundle", css: "css", rendererExports }) });
  cleanup.push(() => { for (const dispose of [...h.disposers].reverse()) dispose(); });
  return h;
}
function definition() {
  return { key: "workbench", title: () => "Workbench", component: () => null,
    detached: { rendererExport: "createWindow", getSnapshot: () => ({ draft: "saved in owner" }), subscribe: () => () => {}, dispatch: vi.fn(async () => false) } };
}

describe("detachable center-tab context", () => {
  it("validates update handlers before wrapping and guards their initial synchronous IPC calls", async () => {
    const originalInternals = window.__TAURI_INTERNALS__;
    const invoke = vi.fn(async () => null);
    window.__TAURI_INTERNALS__ = { invoke }; resetHardeningForTests(); installHardening();
    try {
      const h = handle(); h.ctx.ui.registerCenterTab(definition()); h.ctx.ui.openCenterTab("workbench"); await settle();
      expect(() => h.ctx.ui.registerUpdateCloseHandler({} as never)).toThrow("Invalid");
      let resumeResult: Promise<unknown> | undefined;
      h.ctx.ui.registerUpdateCloseHandler({
        prepare: async () => { await window.__TAURI_INTERNALS__!.invoke!("plugin_prepare"); },
        resume: () => { resumeResult = window.__TAURI_INTERNALS__!.invoke!("plugin_resume"); },
      });
      await expect(preparePluginViewsForUpdate(new AbortController().signal)).rejects.toThrow("blocked inside plugin code");
      resumePluginViewsAfterUpdate();
      await expect(resumeResult).rejects.toThrow("blocked inside plugin code");
      expect(invoke).not.toHaveBeenCalled();
      await window.__TAURI_INTERNALS__!.invoke!("host_call"); expect(invoke).toHaveBeenCalledOnce();
    } finally { window.__TAURI_INTERNALS__ = originalInternals; resetHardeningForTests(); }
  });
  it("tracks opt-in cleanup, requires permission, and locks public opening while allowing internal return", async () => {
    const h = handle(); h.ctx.ui.registerCenterTab(definition()); h.ctx.ui.openCenterTab("workbench"); await settle();
    const prepare = vi.fn(async () => {}); const resume = vi.fn();
    const unregister = h.ctx.ui.registerUpdateCloseHandler({ prepare, resume });
    expect(() => h.ctx.ui.registerUpdateCloseHandler({ prepare, resume })).toThrow("Duplicate");
    await preparePluginViewsForUpdate(new AbortController().signal);
    expect(() => h.ctx.ui.openCenterTab("workbench")).toThrow("preparing for update");
    const options = vi.mocked(createDetachedSurfaceOwner).mock.calls[0][0];
    expect(() => options.assertCanOpen?.()).toThrow("preparing for update");
    options.onReturn("return");
    expect(usePluginTabsStore.getState().tabs).toContain("plugin:detached-demo:workbench");
    resumePluginViewsAfterUpdate(); expect(resume).toHaveBeenCalledOnce();
    unregister(); expect(canClosePluginViewsForUpdate([{ reason: "plugin-view-without-checkpoint" }])).toBe(false);
    const denied = createPluginContext({ ...manifest(), id: "denied", permissions: [] }, backend, { appVersion: "1" });
    expect(() => denied.ctx.ui.registerUpdateCloseHandler({ prepare, resume })).toThrow("ui:center-tab");
  });
  it("requires the additional permission and an export from the activated bundle", () => {
    expect(() => handle(false).ctx.ui.registerCenterTab(definition())).toThrow("ui:detached-window");
    expect(() => handle(true, new Set()).ctx.ui.registerCenterTab(definition())).toThrow("unavailable detached renderer");
    expect(createDetachedSurfaceOwner).not.toHaveBeenCalled();
    expect(centerTabRegistry.get("plugin:detached-demo:workbench")).toBeUndefined();
  });
  it("delegates to the original action closure and returns to the same tab without another chat bridge", async () => {
    const h = handle(); const def = definition(); h.ctx.ui.registerCenterTab(def);
    const options = vi.mocked(createDetachedSurfaceOwner).mock.calls[0][0] as DetachedSurfaceOwnerOptions;
    expect(options.assets).toEqual({ code: "bundle", css: "css" });
    expect(options.getSnapshot()).toEqual({ draft: "saved in owner" });
    expect(await options.dispatch({ name: "submit", args: [] })).toBe(false);
    expect(def.detached.dispatch).toHaveBeenCalledTimes(1);
    options.onReturn("return");
    expect(usePluginTabsStore.getState().activeId).toBe("plugin:detached-demo:workbench");
    options.onReturn("closed");
    expect(usePluginTabsStore.getState().tabs).not.toContain("plugin:detached-demo:workbench");
    expect(h.disposers).toHaveLength(1);
    for (const dispose of [...h.disposers].reverse()) dispose();
    expect(fakeOwner.dispose).toHaveBeenCalledTimes(1);
    expect(centerTabRegistry.get("plugin:detached-demo:workbench")).toBeUndefined();
  });
  it("restores an open surface without activating the main tab and focuses its saved presentation on demand", async () => {
    fakeOwner.restore.mockResolvedValue("detached"); fakeOwner.present.mockResolvedValue("detached");
    const h = handle(); const def = definition();
    h.ctx.ui.registerCenterTab({ ...def, detached: { ...def.detached, defaultPresentation: "detached" } });
    await settle();
    expect(vi.mocked(createDetachedSurfaceOwner).mock.calls[0][0].defaultPresentation).toBe("detached");
    expect(usePluginTabsStore.getState().tabs).toEqual(["plugin:detached-demo:workbench"]);
    expect(usePluginTabsStore.getState().activeId).toBeNull();
    h.ctx.ui.openCenterTab("workbench"); await settle();
    expect(fakeOwner.present).toHaveBeenCalledOnce();
    expect(usePluginTabsStore.getState().activeId).toBeNull();
  });
  it("a closed view stays closed and a late open result cannot revive an unregistered owner", async () => {
    let resolve!: (mode: string) => void;
    fakeOwner.present.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const h = handle(); const unregister = h.ctx.ui.registerCenterTab(definition()); await settle();
    expect(usePluginTabsStore.getState().tabs).toEqual([]);
    h.ctx.ui.openCenterTab("workbench"); unregister(); resolve("docked"); await settle();
    expect(usePluginTabsStore.getState().tabs).toEqual([]);
    expect(fakeOwner.dispose).toHaveBeenCalledOnce();
  });
  it("exposes ctx.images on desktop when host:chat or host:tasks is granted and scopes detached Images API", async () => {
    const { createDetachedImagesApi } = await import("../windows/bootstrap");
    const invoke = vi.fn()
      .mockResolvedValueOnce({ id: "img1", name: "a.png", mimeType: "image/png", size: 12 })
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,AA==" });
    const bridgeBackend: PluginContextBackend = { ...backend, bridgeInvoke: invoke };
    const { ctx } = createPluginContext(
      { id: "detached-demo", name: "Demo", version: "1.0.0", tier: "js", permissions: ["host:tasks"] },
      bridgeBackend,
      { appVersion: "1" },
    );
    await expect(ctx.images.importImage({ dataBase64: "AA==", mimeType: "image/png", name: "a.png" })).resolves.toEqual({
      id: "img1", name: "a.png", mimeType: "image/png", size: 12,
    });
    expect(invoke).toHaveBeenCalledWith("plugin_image_import", {
      pluginId: "detached-demo", dataBase64: "AA==", mimeType: "image/png", name: "a.png",
    });
    await expect(ctx.images.readPreview("img1")).resolves.toEqual({ dataUrl: "data:image/png;base64,AA==" });
    expect(invoke).toHaveBeenCalledWith("plugin_image_preview", { pluginId: "detached-demo", imageId: "img1" });

    let available = true;
    const detInvoke = vi.fn()
      .mockResolvedValueOnce({ id: "img2", name: "b.png", mimeType: "image/png", size: 8 })
      .mockResolvedValueOnce({ dataUrl: "data:image/png;base64,BB==" });
    const detachedImages = createDetachedImagesApi("detached-demo", detInvoke, () => available);
    expect(Object.keys(detachedImages).sort()).toEqual(["importImage", "readPreview"]);
    await expect(detachedImages.importImage({ dataBase64: "BB==", mimeType: "image/png", name: "b.png" })).resolves.toEqual({
      id: "img2", name: "b.png", mimeType: "image/png", size: 8,
    });
    await expect(detachedImages.readPreview("img2")).resolves.toEqual({ dataUrl: "data:image/png;base64,BB==" });
    available = false;
    await expect(detachedImages.importImage({ dataBase64: "BB==", mimeType: "image/png" })).rejects.toThrow(/unavailable/);
    await expect(detachedImages.readPreview("img2")).rejects.toThrow(/unavailable/);
  });
});
