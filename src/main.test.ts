import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules(); window.location.hash = "#/";
  vi.doMock("./lib/engine-compat", () => ({}));
  vi.doMock("./lib/profile-storage", () => ({}));
  vi.doMock("./index.css", () => ({}));
  vi.doMock("./lib/id", () => ({ installCryptoRandomUUIDPolyfill: () => {} }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("starts global update and built-in notice watchers only after bootstrap recovery finishes", async () => {
  vi.stubGlobal("window", { location: { hash: "#/" }, __TAURI_INTERNALS__: {} });
  vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
  const recovery = Promise.withResolvers<void>();
  const order: string[] = [];
  const watch = vi.fn(() => { order.push("watch"); return () => {}; });
  const notices = vi.fn(() => { order.push("notices"); return () => {}; });
  const finish = vi.fn(async () => { order.push("recovery:start"); await recovery.promise; order.push("recovery:finished"); });
  const startApp = vi.fn(() => { order.push("App:start"); });
  vi.doMock("./lib/engine-compat", () => ({}));
  vi.doMock("./lib/profile-storage", () => ({}));
  vi.doMock("./index.css", () => ({}));
  vi.doMock("./lib/id", () => ({ installCryptoRandomUUIDPolyfill: () => {} }));
  vi.doMock("./lib/react-scan", () => ({ installReactScanHook: async () => {}, isReactScanEnabled: () => false, startReactScanOverlay: async () => {} }));
  vi.doMock("./lib/live-update-bootstrap", () => ({ prepareLiveUpdateBootstrap: async () => finish }));
  vi.doMock("./bootstrap", () => ({ startApp }));
  vi.doMock("./features/update/live-update", () => { order.push("update:import"); return { startLiveUpdateRuntime: watch }; });
  vi.doMock("./features/assistant-notices/runtime", () => { order.push("notices:import"); return { startAssistantNoticesRuntime: notices }; });

  await import("./main");
  await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  expect(startApp).toHaveBeenCalledTimes(1);
  expect(watch).not.toHaveBeenCalled();
  expect(notices).not.toHaveBeenCalled();
  expect(order).not.toContain("update:import");
  recovery.resolve();
  await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(1));
  expect(watch).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["App:start", "recovery:start", "recovery:finished", "update:import", "watch", "notices:import", "notices"]);
});

it("loads the real overlay entry without importing the chat store or main application", async () => {
  const forbiddenImport = vi.fn();
  vi.doMock("./features/chat/store", () => { forbiddenImport("chat store"); return {}; });
  vi.doMock("./App", () => { forbiddenImport("main app"); return {}; });
  vi.doMock("./features/plugins", () => { forbiddenImport("plugin system"); return {}; });
  vi.doMock("./lib/live-update-bootstrap", () => { forbiddenImport("handoff"); return {}; });
  vi.doMock("./features/update/live-update", () => { forbiddenImport("live updates"); return {}; });
  vi.doMock("./features/assistant-notices/runtime", () => { forbiddenImport("main notice runtime"); return {}; });
  const entry = await vi.importActual<typeof import("./features/assistant-notices/bootstrap")>("./features/assistant-notices/bootstrap");
  expect(entry.startAssistantNoticesApp).toBeTypeOf("function");
  expect(forbiddenImport).not.toHaveBeenCalled();
});

it.each([
  { hash: "#/assistant-notices", label: "assistant-notices" },
  { hash: "#/assistant-notices?display=compact", label: "main" },
  { hash: "#/", label: "assistant-notices" },
])("isolates the native overlay bootstrap for $hash / $label", async ({ hash, label }) => {
  vi.stubGlobal("window", { location: { hash }, __TAURI_INTERNALS__: {} });
  const overlay = vi.fn();
  const forbiddenImport = vi.fn();
  const hook = vi.fn();
  vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label }) }));
  vi.doMock("./lib/engine-compat", () => ({}));
  vi.doMock("./lib/profile-storage", () => ({}));
  vi.doMock("./index.css", () => ({}));
  vi.doMock("./lib/id", () => ({ installCryptoRandomUUIDPolyfill: () => {} }));
  vi.doMock("./lib/react-scan", () => ({ installReactScanHook: hook, isReactScanEnabled: () => true, startReactScanOverlay: hook }));
  vi.doMock("./features/assistant-notices/bootstrap", () => ({ startAssistantNoticesApp: overlay }));
  vi.doMock("./lib/live-update-bootstrap", () => { forbiddenImport("recovery"); return {}; });
  vi.doMock("./bootstrap", () => { forbiddenImport("main app and plugins"); return {}; });
  vi.doMock("./features/chat/store", () => { forbiddenImport("chat store"); return {}; });
  vi.doMock("./features/update/live-update", () => { forbiddenImport("live update"); return {}; });
  vi.doMock("./features/assistant-notices/runtime", () => { forbiddenImport("main notice runtime"); return {}; });
  await import("./main");
  await vi.waitFor(() => expect(overlay).toHaveBeenCalledOnce());
  expect(hook).not.toHaveBeenCalled();
  expect(forbiddenImport).not.toHaveBeenCalled();
});

it("does not select the desktop overlay bootstrap from a web URL", async () => {
  window.location.hash = "#/assistant-notices";
  const overlay = vi.fn();
  const startApp = vi.fn();
  const notices = vi.fn(() => () => {});
  vi.doMock("./lib/react-scan", () => ({ installReactScanHook: async () => {}, isReactScanEnabled: () => false }));
  vi.doMock("./features/assistant-notices/bootstrap", () => ({ startAssistantNoticesApp: overlay }));
  vi.doMock("./lib/live-update-bootstrap", () => ({ prepareLiveUpdateBootstrap: async () => async () => {} }));
  vi.doMock("./bootstrap", () => ({ startApp }));
  vi.doMock("./features/update/live-update", () => ({ startLiveUpdateRuntime: () => () => {} }));
  vi.doMock("./features/assistant-notices/runtime", () => ({ startAssistantNoticesRuntime: notices }));
  await import("./main");
  await vi.waitFor(() => expect(notices).toHaveBeenCalledOnce());
  expect(startApp).toHaveBeenCalledOnce();
  expect(overlay).not.toHaveBeenCalled();
});

it("unfreezes crash controls on boot failure without starting the update watcher", async () => {
  const error = new Error("Runtime checkpoint is blocked: chat:ledger-not-restored");
  const report = vi.fn();
  const watch = vi.fn();
  const notices = vi.fn();
  vi.stubGlobal("document", { documentElement: { inert: true } });
  vi.doMock("./lib/engine-compat", () => ({}));
  vi.doMock("./lib/profile-storage", () => ({}));
  vi.doMock("./index.css", () => ({}));
  vi.doMock("./lib/id", () => ({ installCryptoRandomUUIDPolyfill: () => {} }));
  vi.doMock("./lib/react-scan", () => ({ installReactScanHook: async () => {}, isReactScanEnabled: () => false }));
  vi.doMock("./lib/live-update-bootstrap", () => ({ prepareLiveUpdateBootstrap: async () => async () => { throw error; } }));
  vi.doMock("./bootstrap", () => ({ startApp: vi.fn() }));
  vi.doMock("./lib/crash", () => ({ reportCrash: report }));
  vi.doMock("./features/update/live-update", () => ({ startLiveUpdateRuntime: watch }));
  vi.doMock("./features/assistant-notices/runtime", () => ({ startAssistantNoticesRuntime: notices }));
  await import("./main");
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith("unhandledrejection", error));
  expect(document.documentElement.inert).toBe(false);
  expect(watch).not.toHaveBeenCalled();
  expect(notices).not.toHaveBeenCalled();
});
