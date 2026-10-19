import { beforeEach, describe, expect, it, vi } from "vitest";

const { scanMock } = vi.hoisted(() => ({ scanMock: vi.fn() }));
vi.mock("react-scan", () => ({ scan: scanMock }));
vi.mock("react-scan/install-hook", () => ({}));

const FLAG_KEY = "ccgui-next.reactScan:v1";
/** react-scan's own options key (not owned by this app). */
const MODULE_OPTIONS_KEY = "react-scan-options";

beforeEach(() => {
  vi.resetModules();
  scanMock.mockReset();
  localStorage.clear();
});

/** Fresh controller per test: the module caches the dynamic import. */
async function load() {
  return import("./react-scan");
}

describe("react-scan controller", () => {
  it("is off by default and applies the flag only when switched on", async () => {
    const controller = await load();
    expect(controller.isReactScanEnabled()).toBe(false);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("installs the devtools hook without loading the overlay", async () => {
    const controller = await load();
    await expect(controller.installReactScanHook()).resolves.toBeUndefined();
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("persists the switch and starts the overlay live", async () => {
    const controller = await load();
    await controller.setReactScanEnabled(true);
    expect(localStorage.getItem(FLAG_KEY)).toBe("1");
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        showToolbar: true,
        dangerouslyForceRunInProduction: true,
      }),
    );
  });

  it("clears react-scan's own paused option before scan() sees it", async () => {
    localStorage.setItem(
      MODULE_OPTIONS_KEY,
      JSON.stringify({ enabled: false, showToolbar: true }),
    );
    let optionsAtScan: unknown = null;
    scanMock.mockImplementation(() => {
      optionsAtScan = JSON.parse(localStorage.getItem(MODULE_OPTIONS_KEY)!);
    });
    const controller = await load();
    await controller.setReactScanEnabled(true);
    expect(optionsAtScan).toEqual({ enabled: true, showToolbar: true });
  });

  it("survives a corrupt react-scan options blob", async () => {
    localStorage.setItem(MODULE_OPTIONS_KEY, "not json");
    const controller = await load();
    await controller.setReactScanEnabled(true);
    expect(scanMock).toHaveBeenCalledOnce();
  });

  it("tears down without importing react-scan when it never started", async () => {
    const controller = await load();
    await controller.setReactScanEnabled(false);
    expect(scanMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(FLAG_KEY)).toBe("0");
  });

  it("disables an already loaded overlay", async () => {
    const controller = await load();
    await controller.setReactScanEnabled(true);
    await controller.setReactScanEnabled(false);
    expect(scanMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, showToolbar: false }),
    );
  });

  it("starts the overlay at boot from the persisted switch", async () => {
    localStorage.setItem(FLAG_KEY, "1");
    const controller = await load();
    expect(controller.isReactScanEnabled()).toBe(true);
    await controller.startReactScanOverlay();
    expect(scanMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});
