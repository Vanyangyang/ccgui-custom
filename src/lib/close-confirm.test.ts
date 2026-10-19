import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mirrors `EXIT_REQUESTED_EVENT` in src-tauri/src/quit_guard.rs. Asserted as
 * a literal (not re-exported from the module under test) so drifting either
 * side fails here instead of silently disabling the macOS quit guard.
 */
const EXIT_REQUESTED_EVENT = "app://exit-requested";

const env = vi.hoisted(() => ({ isWeb: false }));
const transport = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
const windows = vi.hoisted(() => ({
  closeHandlers: [] as Array<(event: { preventDefault: () => void }) => void>,
  destroy: vi.fn(),
}));

vi.mock("./transport", () => ({
  isWeb: env.isWeb,
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    transport.listeners.set(name, cb);
    return Promise.resolve(() => transport.listeners.delete(name));
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (cb: (event: { preventDefault: () => void }) => void) => {
      windows.closeHandlers.push(cb);
      return Promise.resolve(() => {});
    },
    destroy: windows.destroy,
  }),
}));

type CloseConfirm = typeof import("./close-confirm");
let confirm: CloseConfirm;

/** Fresh module per case: `installed` is module state. */
beforeEach(async () => {
  env.isWeb = false;
  transport.listeners.clear();
  windows.closeHandlers.length = 0;
  windows.destroy.mockReset();
  vi.resetModules();
  confirm = await import("./close-confirm");
});

describe("app close confirmation", () => {
  it("intercepts the window X and asks instead of closing", () => {
    confirm.installCloseConfirm();
    const event = { preventDefault: vi.fn() };
    for (const handler of windows.closeHandlers) handler(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(confirm.closeConfirmPending()).toBe(true);
  });

  it("raises the dialog for a system quit cancelled by the macOS guard", () => {
    confirm.installCloseConfirm();
    // The backend only emits this after answering NSTerminateCancel, so the
    // app is still alive and the user decides. Without the listener this was
    // a silent no-op and one quit — a mispressed shortcut or an agent's
    // `osascript … quit` — killed every live run mid-turn.
    expect(transport.listeners.has(EXIT_REQUESTED_EVENT)).toBe(true);
    transport.listeners.get(EXIT_REQUESTED_EVENT)?.({ payload: undefined });
    expect(confirm.closeConfirmPending()).toBe(true);
  });

  it("destroys the window only after an explicit confirm", () => {
    confirm.installCloseConfirm();
    transport.listeners.get(EXIT_REQUESTED_EVENT)?.({ payload: undefined });
    confirm.confirmAppClose();
    expect(windows.destroy).toHaveBeenCalledTimes(1);
    expect(confirm.closeConfirmPending()).toBe(false);
  });

  it("a cancel keeps the app running", () => {
    confirm.installCloseConfirm();
    transport.listeners.get(EXIT_REQUESTED_EVENT)?.({ payload: undefined });
    confirm.cancelAppClose();
    expect(windows.destroy).not.toHaveBeenCalled();
    expect(confirm.closeConfirmPending()).toBe(false);
  });

  it("subscribes once and notifies store listeners on both paths", () => {
    confirm.installCloseConfirm();
    confirm.installCloseConfirm();
    expect(windows.closeHandlers).toHaveLength(1);
    const seen: boolean[] = [];
    confirm.subscribeCloseConfirm(() => seen.push(confirm.closeConfirmPending()));
    for (const handler of windows.closeHandlers) handler({ preventDefault: vi.fn() });
    confirm.cancelAppClose();
    transport.listeners.get(EXIT_REQUESTED_EVENT)?.({ payload: undefined });
    expect(seen).toEqual([true, false, true]);
  });

  it("stays out of the web-access browser bridge", async () => {
    vi.resetModules();
    // A doMock override (not the hoisted factory) so this import path sees
    // the browser transport regardless of mock-module caching.
    vi.doMock("./transport", () => ({ isWeb: true, listen: vi.fn() }));
    const webModule = await import("./close-confirm");
    webModule.installCloseConfirm();
    expect(windows.closeHandlers).toHaveLength(0);
    expect(transport.listeners.size).toBe(0);
  });
});
