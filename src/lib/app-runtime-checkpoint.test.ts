import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCheckpoint } from "./runtime-checkpoint";
vi.mock("@/lib/ipc", () => ({ ipc: {} }));
const pluginState = vi.hoisted(() => ({ installing: null as { done: number; total: number } | null, loading: false }));
vi.mock("@/features/plugins/manager/usePlugins", () => ({ usePluginsStore: { getState: () => pluginState } }));
vi.mock("@/features/plugins/runtime/loader", () => ({ getPluginStatesSnapshot: () => pluginState.loading ? [{ id: "fixture", state: "loading" }] : [] }));

async function boot(checkpoint?: RuntimeCheckpoint) {
  vi.resetModules();
  const coordinator = await import("./runtime-checkpoint");
  coordinator.initializeRuntimeCheckpoint(checkpoint, { requiredParticipants: ["app-ui"] });
  const app = await import("./app-runtime-checkpoint");
  const files = (await import("@/features/files/store")).useFilesStore;
  const panels = await import("@/features/chat/use-layout-panels");
  const hub = (await import("@/features/plugins/hub/store")).usePluginHubStore;
  return { coordinator, app, files, panels, hub };
}
beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); pluginState.installing = null; pluginState.loading = false; });

describe("app UI checkpoint", () => {
  it("restores file tabs, navigation and memory panel choice without replacing actions or persisted preferences", async () => {
    const old = await boot();
    const path = "G:/fixture/readme.md";
    localStorage.setItem("ccgui-next.panelWidth", "421");
    old.files.setState({ root: "G:/fixture", openFiles: [path], activeFilePath: path, selectedPath: path,
      expanded: { "G:/fixture": true }, searchRoot: "G:/fixture",
      fileStates: { [path]: { path, loading: false, error: null, loadNonce: 7, content: { kind: "text", text: "saved 中文🙂" } as never } },
    });
    old.panels.restoreLayoutPanelRuntime({ panelTab: "changes" });
    old.hub.setState({ open: true, active: true, view: "installed" });
    window.history.replaceState(null, "", "/#/settings");
    const checkpoint = await old.coordinator.prepareRuntimeCheckpoint();
    const next = await boot(JSON.parse(JSON.stringify(checkpoint)));
    expect(next.files.getState().openFiles).toEqual([path]);
    expect(next.files.getState().activeFilePath).toBe(path);
    expect(next.files.getState().fileStates[path].content).toMatchObject({ text: "saved 中文🙂" });
    expect(next.files.getState().expanded).toEqual({ "G:/fixture": true });
    expect(typeof next.files.getState().openFile).toBe("function");
    expect(next.panels.captureLayoutPanelRuntime()).toEqual({ panelTab: "changes" });
    expect(next.hub.getState()).toMatchObject({ open: true, active: true, view: "installed" });
    expect(window.location.hash).toBe("#/settings");
    expect(localStorage.getItem("ccgui-next.panelWidth")).toBe("421");
    await next.coordinator.resumeRuntimeCheckpoint();
  });

  it("blocks unsaved editor drafts, pending reads and uncheckpointed plugin views", async () => {
    const app = await boot();
    app.files.setState({ dirtyPaths: { "G:/fixture/unsaved.ts": true } });
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/unsaved-editor-drafts/);
    app.coordinator.abortRuntimeCheckpoint();
    app.files.setState({ dirtyPaths: {}, loadingDirs: { "G:/fixture": true } });
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/file-read-in-progress/);
    app.coordinator.abortRuntimeCheckpoint();
    app.files.setState({ loadingDirs: {} });
    const tabs = (await import("@/features/plugins/runtime/center-tabs")).usePluginTabsStore;
    tabs.getState().openTab("plugin:fixture:form");
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/plugin-view-without-checkpoint/);
    app.coordinator.abortRuntimeCheckpoint();
    tabs.getState().closeTab("plugin:fixture:form");
    app.panels.restoreLayoutPanelRuntime({ panelTab: "plugin:fixture:panel" });
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/plugin-view-without-checkpoint/);
    app.coordinator.abortRuntimeCheckpoint();
    app.panels.restoreLayoutPanelRuntime({ panelTab: "files" });
    await expect(app.coordinator.prepareRuntimeCheckpoint()).resolves.toMatchObject({ version: 1 });
  });

  it("blocks open dialogs and plugin mutations without blocking an idle loaded plugin", async () => {
    const app = await boot();
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    try { await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/open-dialog/); }
    finally { dialog.remove(); app.coordinator.abortRuntimeCheckpoint(); }
    pluginState.installing = { done: 1, total: 2 };
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/plugin-install-in-progress/);
    app.coordinator.abortRuntimeCheckpoint(); pluginState.installing = null; pluginState.loading = true;
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/plugin-loading/);
    app.coordinator.abortRuntimeCheckpoint(); pluginState.loading = false;
    await expect(app.coordinator.prepareRuntimeCheckpoint()).resolves.toMatchObject({ version: 1 });
  });

  it("recognizes native settings dialogs and only exempts the marked update pane, never its nested dialogs", async () => {
    const app = await boot();
    const dialog = document.createElement("dialog"); dialog.open = true; document.body.append(dialog);
    try {
      await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/open-dialog/);
      app.coordinator.abortRuntimeCheckpoint();
      const updatePane = document.createElement("section"); updatePane.dataset.runtimeUpdateSafe = "true"; dialog.append(updatePane);
      await expect(app.coordinator.prepareRuntimeCheckpoint()).resolves.toMatchObject({ version: 1 });
      app.coordinator.abortRuntimeCheckpoint();
      const nested = document.createElement("div"); nested.setAttribute("role", "dialog"); updatePane.append(nested);
      await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/open-dialog/);
    } finally { dialog.remove(); app.coordinator.abortRuntimeCheckpoint(); }
  });
});
