import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { centerTabRegistry, panelTabRegistry } from "@ccgui/plugin-sdk";
import { captureLayoutPanelRuntime, setLayoutPanelRuntime, useLayoutPanels } from "@/features/chat/use-layout-panels";
import { usePluginTabsStore } from "./center-tabs";
import { assertPluginViewsCanOpen, canClosePluginViewsForUpdate, preparePluginForMaintenance, preparePluginViewsForUpdate, registerPluginDetachedOwner, registerPluginUpdateCloseHandler, resumePluginViewsAfterUpdate } from "./update-close";
import type { DetachedSurfaceOwner } from "../windows/owner";

const cleanup: (() => void)[] = [];
async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const blockers = [{ reason: "plugin-view-without-checkpoint" }];
function fixture(id = "demo", prepare = vi.fn(async (_signal: AbortSignal) => {})) {
  const resume = vi.fn();
  const unregister = registerPluginUpdateCloseHandler(id, { prepare, resume }); cleanup.push(unregister);
  const key = `plugin:${id}:workbench`;
  cleanup.push(centerTabRegistry.register({ id: key, title: () => "Workbench", component: () => null }));
  usePluginTabsStore.getState().openTab(key);
  return { key, prepare, resume, unregister };
}
function detached(id = "demo", returnToMain = vi.fn(async () => {}), onRestore?: () => void) {
  const owner: DetachedSurfaceOwner = { checkpointParticipant: `plugin-window-owner:${id}`, getStatus: () => ({ phase: "detached", windowId: id }), returnToMain, open: vi.fn(async () => {}), present: vi.fn(async () => "detached" as const), restore: vi.fn(async () => "detached" as const), flushPresentation: vi.fn(async () => {}), dispose: vi.fn(), subscribeStatus: () => () => {} };
  const unregister = registerPluginDetachedOwner(id, owner, onRestore); cleanup.push(unregister);
  return { owner, unregister };
}
afterEach(() => {
  resumePluginViewsAfterUpdate();
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  usePluginTabsStore.setState({ tabs: [], activeId: null });
  setLayoutPanelRuntime("files"); window.location.hash = "";
});
describe("plugin update close", () => {
  it("prepares owned services even with closed views, while unowned or busy processes stay blocking", async () => {
    const f = fixture(); usePluginTabsStore.getState().closeTab(f.key);
    const service = { reason: "plugin-processes", pluginId: "demo" };
    expect(canClosePluginViewsForUpdate([service])).toBe(true);
    expect(canClosePluginViewsForUpdate([{ reason: "plugin-processes" }])).toBe(false);
    expect(canClosePluginViewsForUpdate([service, { reason: "plugin-processes" }])).toBe(false);
    expect(canClosePluginViewsForUpdate([service, { reason: "plugin-processes", pluginId: "unknown" }])).toBe(false);
    expect(canClosePluginViewsForUpdate([service, { reason: "terminal-sessions" }])).toBe(false);
    await preparePluginViewsForUpdate(new AbortController().signal);
    expect(f.prepare).toHaveBeenCalledOnce();
    resumePluginViewsAfterUpdate(); expect(f.resume).toHaveBeenCalledOnce();
  });
  it("restores the original owner after rollback and unlock, but never after commit", async () => {
    fixture(); const restore = vi.fn(() => assertPluginViewsCanOpen("demo")); detached("demo", undefined, restore);
    const finish = await preparePluginForMaintenance("demo", new AbortController().signal);
    expect(restore).not.toHaveBeenCalled(); finish(false); await turns();
    expect(restore).toHaveBeenCalledOnce();
    const committed = await preparePluginForMaintenance("demo", new AbortController().signal);
    committed(true); await turns(); expect(restore).toHaveBeenCalledOnce();
  });
  it("does not restore until handler resume succeeds, then restores only once", async () => {
    const f = fixture(); const restore = vi.fn(); detached("demo", undefined, restore);
    const finish = await preparePluginForMaintenance("demo", new AbortController().signal);
    f.resume.mockImplementationOnce(() => { throw new Error("resume failed"); });
    expect(() => finish(false)).toThrow("resume failed"); await turns();
    expect(restore).not.toHaveBeenCalled(); expect(() => assertPluginViewsCanOpen("demo")).toThrow();
    finish(false); await turns(); expect(restore).toHaveBeenCalledOnce();
  });
  it("waits for cancelled close to settle and drops recovery after a newer maintenance", async () => {
    fixture(); const pending = Promise.withResolvers<void>(); const restore = vi.fn();
    const d = detached("demo", vi.fn(() => pending.promise), restore);
    const abort = new AbortController(); const work = preparePluginForMaintenance("demo", abort.signal);
    await turns(); abort.abort(new Error("cancelled")); await expect(work).rejects.toThrow("cancelled");
    await turns(); expect(restore).not.toHaveBeenCalled();
    vi.spyOn(d.owner, "getStatus").mockReturnValue({ phase: "docked" });
    const newer = await preparePluginForMaintenance("demo", new AbortController().signal); newer(true);
    pending.resolve(); await turns(); expect(restore).not.toHaveBeenCalled();
  });
  it("recovers a cancelled close once the original pending close finishes", async () => {
    fixture(); const pending = Promise.withResolvers<void>(); const restore = vi.fn();
    detached("demo", vi.fn(() => pending.promise), restore);
    const abort = new AbortController(); const work = preparePluginForMaintenance("demo", abort.signal);
    await turns(); abort.abort(new Error("cancelled")); await expect(work).rejects.toThrow("cancelled");
    await turns(); expect(restore).not.toHaveBeenCalled();
    pending.resolve(); await turns(); expect(restore).toHaveBeenCalledOnce();
  });
  it("drops rollback callbacks for an unregistered owner and handler replacement", async () => {
    const f = fixture(); const restore = vi.fn(); const d = detached("demo", undefined, restore);
    const finish = await preparePluginForMaintenance("demo", new AbortController().signal);
    finish(false); d.unregister(); f.unregister();
    cleanup.push(registerPluginUpdateCloseHandler("demo", { prepare: async () => {}, resume() {} }));
    await turns(); expect(restore).not.toHaveBeenCalled();
  });
  it("global cancellation restores docked views in background and consults owner authority for X-closed views", async () => {
    const f = fixture(); const other = fixture("other");
    let mode: "docked" | null = "docked";
    const restore = vi.fn(() => {
      assertPluginViewsCanOpen("demo");
      if (mode) usePluginTabsStore.getState().openTab(f.key, { activate: false, reason: "presentation" });
    });
    const d = detached("demo", undefined, restore); vi.spyOn(d.owner, "getStatus").mockReturnValue({ phase: "docked" });
    await preparePluginViewsForUpdate(new AbortController().signal); resumePluginViewsAfterUpdate();
    usePluginTabsStore.getState().openTab(other.key); await turns();
    expect(usePluginTabsStore.getState().tabs).toContain(f.key);
    expect(usePluginTabsStore.getState().activeId).toBe(other.key);
    mode = null; usePluginTabsStore.getState().closeTab(f.key);
    await preparePluginViewsForUpdate(new AbortController().signal); resumePluginViewsAfterUpdate(); await turns();
    expect(restore).toHaveBeenCalledTimes(2); expect(usePluginTabsStore.getState().tabs).not.toContain(f.key);
  });
  it("retains a failed maintenance resume lock for retry or exact registration disposal", async () => {
    const resume = vi.fn().mockImplementationOnce(() => { throw new Error("resume refused"); });
    const unregister = registerPluginUpdateCloseHandler("retry", { prepare: async () => {}, resume }); cleanup.push(unregister);
    const finish = await preparePluginForMaintenance("retry", new AbortController().signal);
    expect(() => finish(false)).toThrow("resume refused");
    expect(() => assertPluginViewsCanOpen("retry")).toThrow();
    const retryFinish = await preparePluginForMaintenance("retry", new AbortController().signal);
    expect(resume).toHaveBeenCalledTimes(2); retryFinish(true);
    expect(() => assertPluginViewsCanOpen("retry")).not.toThrow();
    resume.mockImplementation(() => { throw new Error("still refused"); });
    const finalFinish = await preparePluginForMaintenance("retry", new AbortController().signal);
    expect(() => finalFinish(false)).toThrow("still refused"); unregister();
    expect(() => assertPluginViewsCanOpen("retry")).not.toThrow();
  });
  it("maintenance saves only its closed target controller and leaves other views alone", async () => {
    const target = fixture(); const other = fixture("other");
    usePluginTabsStore.getState().closeTab(target.key);
    const finish = await preparePluginForMaintenance("demo", new AbortController().signal);
    expect(target.prepare).toHaveBeenCalledOnce(); expect(other.prepare).not.toHaveBeenCalled();
    expect(usePluginTabsStore.getState().tabs).toEqual([other.key]);
    expect(() => assertPluginViewsCanOpen("demo")).toThrow();
    finish(false); expect(target.resume).toHaveBeenCalledOnce();
  });
  it("maintenance blocks unprotected views and returns target owners through their guard", async () => {
    cleanup.push(centerTabRegistry.register({ id: "plugin:unknown:tab", title: () => "Unprotected", component: () => null }));
    usePluginTabsStore.getState().openTab("plugin:unknown:tab");
    await expect(preparePluginForMaintenance("unknown", new AbortController().signal)).rejects.toThrow("without an update close handler");
    const f = fixture(); const d = detached("demo", vi.fn(async () => { throw new Error("guard refused"); }));
    await expect(preparePluginForMaintenance("demo", new AbortController().signal)).rejects.toThrow("guard refused");
    expect(d.owner.returnToMain).toHaveBeenCalledExactlyOnceWith("maintenance"); expect(f.prepare).not.toHaveBeenCalled();
    expect(() => assertPluginViewsCanOpen("demo")).not.toThrow();
  });
  it("maintenance clears stale view selection after a disabled plugin unregisters its runtime", async () => {
    const unregisterTab = centerTabRegistry.register({ id: "plugin:disabled:tab", title: () => "Disabled", component: () => null });
    const unregisterPanel = panelTabRegistry.register({ id: "plugin:disabled:panel", label: () => "Disabled", component: () => null });
    usePluginTabsStore.getState().openTab("plugin:disabled:tab");
    setLayoutPanelRuntime("plugin:disabled:panel");
    unregisterTab(); unregisterPanel();
    const finish = await preparePluginForMaintenance("disabled", new AbortController().signal);
    expect(usePluginTabsStore.getState().tabs).toEqual([]);
    expect(captureLayoutPanelRuntime().panelTab).toBe("files");
    finish(true);
    expect(() => assertPluginViewsCanOpen("disabled")).not.toThrow();
  });
  it("maintenance abort never closes late and keeps replacement locked until cleanup", async () => {
    const pending = Promise.withResolvers<void>(); const f = fixture("demo", vi.fn(() => pending.promise));
    const controller = new AbortController(); const work = preparePluginForMaintenance("demo", controller.signal);
    controller.abort(new Error("timeout")); await expect(work).rejects.toThrow("timeout");
    pending.resolve(); await Promise.resolve(); expect(usePluginTabsStore.getState().tabs).toContain(f.key);
    expect(f.resume).toHaveBeenCalledOnce();
    const finish = await preparePluginForMaintenance("demo", new AbortController().signal);
    f.unregister(); const replacement = { prepare: vi.fn(async () => {}), resume: vi.fn() };
    cleanup.push(registerPluginUpdateCloseHandler("demo", replacement));
    expect(() => assertPluginViewsCanOpen("demo")).toThrow(); finish(false);
    expect(replacement.resume).not.toHaveBeenCalled(); expect(() => assertPluginViewsCanOpen("demo")).not.toThrow();
  });
  it("is a no-op without handlers and prepares loaded controllers whose views are closed", async () => {
    await expect(preparePluginViewsForUpdate(new AbortController().signal)).resolves.toBeUndefined();
    const f = fixture(); usePluginTabsStore.getState().closeTab(f.key);
    await preparePluginViewsForUpdate(new AbortController().signal);
    expect(f.prepare).toHaveBeenCalledOnce(); expect(usePluginTabsStore.getState().tabs).toEqual([]);
    resumePluginViewsAfterUpdate(); expect(f.resume).toHaveBeenCalledOnce();
  });
  it("rejects a new controller registered during an asynchronous preparation", async () => {
    const finish = Promise.withResolvers<void>();
    const f = fixture("demo", vi.fn(() => finish.promise));
    const preparing = preparePluginViewsForUpdate(new AbortController().signal);
    cleanup.push(registerPluginUpdateCloseHandler("late", { prepare: vi.fn(async () => {}), resume: vi.fn() }));
    finish.resolve(); await expect(preparing).rejects.toThrow("registration changed");
    expect(usePluginTabsStore.getState().tabs).toEqual([f.key]);
    resumePluginViewsAfterUpdate(); expect(f.resume).toHaveBeenCalledOnce();
  });
  it("requires only supported blockers and every visible plugin to opt in", () => {
    const f = fixture();
    expect(canClosePluginViewsForUpdate(blockers)).toBe(true);
    expect(canClosePluginViewsForUpdate([])).toBe(false);
    expect(canClosePluginViewsForUpdate([...blockers, { reason: "busy" }])).toBe(false);
    usePluginTabsStore.getState().openTab("plugin:unknown:tab");
    expect(canClosePluginViewsForUpdate(blockers)).toBe(false);
    usePluginTabsStore.setState({ tabs: [f.key] });
    setLayoutPanelRuntime("plugin:unknown:panel");
    expect(canClosePluginViewsForUpdate(blockers)).toBe(false);
    setLayoutPanelRuntime("files");
    window.location.hash = "#/p/demo";
    expect(canClosePluginViewsForUpdate(blockers)).toBe(false);
    window.location.hash = "";
    usePluginTabsStore.setState({ tabs: ["plugin::bad"] });
    expect(canClosePluginViewsForUpdate(blockers)).toBe(false);
  });
  it("accounts for native blockers and exact live owner identities", () => {
    fixture();
    const native = [{ reason: "plugin-window-without-checkpoint" }];
    expect(canClosePluginViewsForUpdate(native)).toBe(false);
    detached();
    expect(canClosePluginViewsForUpdate(native)).toBe(true);
    expect(canClosePluginViewsForUpdate([{ ...native[0], participant: "plugin-window-owner:other" }])).toBe(false);
    expect(canClosePluginViewsForUpdate([{ ...native[0], participant: "plugin-window-owner:demo" }])).toBe(true);
    detached("unknown");
    expect(canClosePluginViewsForUpdate(native)).toBe(false);
  });
  it("returns windows before saving, then closes center and mounted side panel, holding reopen locks", async () => {
    const order: string[] = [];
    const f = fixture("demo", vi.fn(async () => { order.push("save"); expect(usePluginTabsStore.getState().tabs).toContain(f.key); }));
    detached("demo", vi.fn(async () => { order.push("return"); expect(() => assertPluginViewsCanOpen("demo")).toThrow(); }));
    cleanup.push(panelTabRegistry.register({ id: "plugin:demo:panel", label: () => "Panel", component: () => null }));
    setLayoutPanelRuntime("plugin:demo:panel");
    const container = document.createElement("div");
    const root = createRoot(container);
    function Panel() { return <span>{useLayoutPanels().panelTab}</span>; }
    act(() => { root.render(<Panel />); });
    await act(async () => { await preparePluginViewsForUpdate(new AbortController().signal); });
    expect(order).toEqual(["return", "save"]);
    expect(usePluginTabsStore.getState().tabs).toEqual([]);
    expect(container.textContent).toBe("files");
    expect(() => setLayoutPanelRuntime("plugin:demo:panel")).toThrow();
    expect(() => assertPluginViewsCanOpen("demo")).toThrow();
    expect(() => assertPluginViewsCanOpen("unrelated")).not.toThrow();
    resumePluginViewsAfterUpdate(); resumePluginViewsAfterUpdate();
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(() => assertPluginViewsCanOpen("demo")).not.toThrow(); act(() => root.unmount());
  });
  it("keeps views on save failure and resumes even the failing handler", async () => {
    const f = fixture("demo", vi.fn(async () => { throw new Error("save failed"); }));
    await expect(preparePluginViewsForUpdate(new AbortController().signal)).rejects.toThrow("save failed");
    expect(usePluginTabsStore.getState().tabs).toEqual([f.key]);
    expect(() => assertPluginViewsCanOpen("demo")).toThrow();
    resumePluginViewsAfterUpdate(); expect(f.resume).toHaveBeenCalledOnce();
  });
  it("honors return guard rejection without invoking prepare or final close", async () => {
    const f = fixture(); detached("demo", vi.fn(async () => { throw new Error("guard"); }));
    await expect(preparePluginViewsForUpdate(new AbortController().signal)).rejects.toThrow("guard");
    expect(f.prepare).not.toHaveBeenCalled(); expect(usePluginTabsStore.getState().tabs).toEqual([f.key]);
  });
  it("aborts promptly and never closes on late callback completion", async () => {
    let finish!: () => void;
    const f = fixture("demo", vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const abort = new AbortController(); const preparing = preparePluginViewsForUpdate(abort.signal);
    abort.abort(new Error("timeout"));
    await expect(preparing).rejects.toThrow("timeout"); resumePluginViewsAfterUpdate(); finish();
    await Promise.resolve(); expect(usePluginTabsStore.getState().tabs).toEqual([f.key]); expect(f.resume).toHaveBeenCalledOnce();
  });
  it("protects reloaded handlers and views from old disposers/completions", async () => {
    let finish!: () => void;
    const f = fixture("demo", vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const preparing = preparePluginViewsForUpdate(new AbortController().signal);
    f.unregister();
    const replacement = { prepare: vi.fn(async () => {}), resume: vi.fn() };
    cleanup.push(registerPluginUpdateCloseHandler("demo", replacement)); f.unregister(); finish();
    await expect(preparing).rejects.toThrow("registration changed"); resumePluginViewsAfterUpdate();
    expect(replacement.resume).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
    expect(usePluginTabsStore.getState().tabs).toEqual([f.key]); expect(canClosePluginViewsForUpdate(blockers)).toBe(true);
  });
  it("retains failed resume handlers and locks for retry without repeating successful handlers", async () => {
    const f = fixture(); expect(() => registerPluginUpdateCloseHandler("demo", { prepare: async () => {}, resume() {} })).toThrow("Duplicate");
    expect(() => registerPluginUpdateCloseHandler("invalid", {} as never)).toThrow("Invalid");
    const resume = vi.fn().mockImplementationOnce(() => { throw new Error("resume"); }).mockImplementation(() => {});
    cleanup.push(registerPluginUpdateCloseHandler("broken", { prepare: async () => {}, resume }));
    cleanup.push(centerTabRegistry.register({ id: "plugin:broken", title: () => "Broken", component: () => null }));
    usePluginTabsStore.getState().openTab("plugin:broken");
    await preparePluginViewsForUpdate(new AbortController().signal);
    expect(() => resumePluginViewsAfterUpdate()).toThrow("Unable to resume");
    expect(() => assertPluginViewsCanOpen("broken")).toThrow();
    expect(() => assertPluginViewsCanOpen("demo")).not.toThrow();
    await expect(preparePluginViewsForUpdate(new AbortController().signal)).rejects.toThrow("already in progress");
    resumePluginViewsAfterUpdate(); resumePluginViewsAfterUpdate();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(() => assertPluginViewsCanOpen("broken")).not.toThrow();
    expect(captureLayoutPanelRuntime().panelTab).toBe("files");
  });
});
