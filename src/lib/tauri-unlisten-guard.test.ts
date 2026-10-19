import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTauriUnlistenGuard,
  type TauriEventPluginInternals,
} from "./tauri-unlisten-guard";

const invokeMock = vi.fn();

// transport.ts snapshots desktop-vs-web at import time, so the internals stub
// has to exist before the dynamic import below (static imports are hoisted).
// The real @tauri-apps/api/event runs on top of it: core.js's invoke and
// transformCallback are thin pass-throughs to window.__TAURI_INTERNALS__.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  transformCallback: (handler: unknown) => handler,
};
const { listen } = await import("@/lib/transport");

const LISTEN_ID = 7;

/**
 * Tauri's generated unlisten script (crates/tauri/src/event/mod.rs), reduced
 * to the lookup under test: `bucket` is the per-event-name object, which
 * exists because an earlier listener for that name landed, while the entry
 * for `eventId` is written by a separate eval that has not reached the
 * webview yet. WebKit words the resulting failure exactly like the crash
 * report: "undefined is not an object (evaluating 'listeners[eventId]
 * .handlerId')", and `_unlisten` aborts before `plugin:event|unlisten`.
 */
function tauriUnregisterListener(
  bucket: Record<number, { handlerId: number }>,
  unregisterCallback: (handlerId: number) => void = () => {},
): (event: string, eventId: number) => void {
  return (_event, eventId) => {
    const listeners = bucket;
    if (listeners) unregisterCallback(listeners[eventId].handlerId);
  };
}

/** Install fake plugin internals and return them for the guard. */
function stubInternals(
  unregisterListener: TauriEventPluginInternals["unregisterListener"],
): TauriEventPluginInternals {
  const internals: TauriEventPluginInternals = { unregisterListener };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = internals;
  return internals;
}

/** The type hides it, but the unlisten closure is async and rejecting. */
async function unlistenSettled(unlisten: () => void): Promise<void> {
  await (unlisten() as unknown as Promise<void>);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "plugin:event|listen" ? LISTEN_ID : undefined,
  );
  delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
});

describe("installTauriUnlistenGuard", () => {
  it("documents the unguarded path: the late unlisten rejects and skips the backend unlisten", async () => {
    stubInternals(tauriUnregisterListener({ 1: { handlerId: 1 } }));

    const unlisten = await listen("settings://changed", () => {});
    await expect(unlistenSettled(unlisten)).rejects.toThrow(TypeError);
    expect(invokeMock).not.toHaveBeenCalledWith("plugin:event|unlisten", expect.anything());
  });

  it("guarded: the late unlisten resolves and still unregisters the Rust listener", async () => {
    stubInternals(tauriUnregisterListener({ 1: { handlerId: 1 } }));
    installTauriUnlistenGuard();

    const unlisten = await listen("settings://changed", () => {});
    await expect(unlistenSettled(unlisten)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("plugin:event|unlisten", {
      event: "settings://changed",
      eventId: LISTEN_ID,
    });
  });

  it("keeps the normal path: a landed entry still drops its JS callback", async () => {
    const dropped: number[] = [];
    const internals = stubInternals(
      tauriUnregisterListener({ [LISTEN_ID]: { handlerId: 42 } }, (id) => dropped.push(id)),
    );
    installTauriUnlistenGuard(internals);

    const unlisten = await listen("settings://changed", () => {});
    await expect(unlistenSettled(unlisten)).resolves.toBeUndefined();
    expect(dropped).toEqual([42]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:event|unlisten", {
      event: "settings://changed",
      eventId: LISTEN_ID,
    });
  });

  it("is idempotent and no-ops without internals", () => {
    const internals = stubInternals(tauriUnregisterListener({}));
    installTauriUnlistenGuard(internals);
    const wrapped = internals.unregisterListener;
    installTauriUnlistenGuard(internals);
    expect(internals.unregisterListener).toBe(wrapped);

    expect(() => installTauriUnlistenGuard({})).not.toThrow();
  });
});
