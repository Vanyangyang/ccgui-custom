import { describe, expect, it, vi } from "vitest";
const plugin = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({ getAppVersion: async () => "1.1.1+protected.1" }));
vi.mock("@/version/distribution", () => ({ IS_CUSTOM_DISTRIBUTION: true }));
import { useUpdateStore } from "./store";

describe("custom distribution update boundary", () => {
  it("never starts the official installer or restarts during update checks", async () => {
    await useUpdateStore.getState().checkForUpdates({ interactive: true });
    await useUpdateStore.getState().startUpdate();
    expect(plugin.check).not.toHaveBeenCalled();
    expect(plugin.relaunch).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().stage).toBe("idle");
  });
});
