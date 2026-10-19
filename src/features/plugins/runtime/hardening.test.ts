import { describe, expect, it, vi } from "vitest";
import { installHardening, resetHardeningForTests, runAsPlugin } from "./hardening";

describe("hardening", () => {
  it("blocks direct Tauri IPC while plugin code is on the stack, allows host calls", async () => {
    const calls: string[] = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
    };
    installHardening();

    // Host context: passes through.
    await window.__TAURI_INTERNALS__.invoke!("host_cmd");
    expect(calls).toEqual(["host_cmd"]);

    // Plugin context: rejected without reaching the real invoke.
    await expect(
      runAsPlugin(() => window.__TAURI_INTERNALS__!.invoke!("plugin_cmd")),
    ).rejects.toThrow(/blocked/);
    expect(calls).toEqual(["host_cmd"]);
  });

  it("runAsPlugin restores the host context even when plugin code throws", async () => {
    expect(() =>
      runAsPlugin(() => {
        throw new Error("plugin bug");
      }),
    ).toThrow("plugin bug");
    await window.__TAURI_INTERNALS__!.invoke!("after_crash");
  });

  it("does not throw when Tauri marks invoke non-writable", async () => {
    resetHardeningForTests();
    const calls: string[] = [];
    const invoke = async (cmd: string) => {
      calls.push(cmd);
      return null;
    };
    const internals = {};
    // Same descriptor Tauri 2.11 uses: defineProperty defaults to
    // writable:false, configurable:false. Assignment must not abort bootstrap.
    Object.defineProperty(internals, "invoke", { value: invoke });
    window.__TAURI_INTERNALS__ = internals as typeof window.__TAURI_INTERNALS__;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => installHardening()).not.toThrow();
      await window.__TAURI_INTERNALS__!.invoke!("still_works");
      expect(calls).toEqual(["still_works"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
