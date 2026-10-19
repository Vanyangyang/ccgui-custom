import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AppSettings } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { listenSettingsChanged } from "@/lib/events";
import { WebAuthCard } from "./WebAuthCard";
import i18n from "@/lib/i18n";

vi.mock("@/lib/ipc", () => ({ ipc: { refreshAppSettings: vi.fn(), getAppSettings: vi.fn(), updateAppSettings: vi.fn(), rotateWebPairKey: vi.fn(), webDeviceRevoke: vi.fn() } }));
vi.mock("@/lib/transport", () => ({ isWeb: true, listen: vi.fn() }));
vi.mock("@/lib/events", () => ({ listenSettingsChanged: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const initial = { webAuthEnabled: true, webAuthKey: "OLD-CODE" } as AppSettings;
let node: HTMLDivElement, root: Root;
let connected: (event: { payload: unknown }) => void, changed: () => void;
let offConnected: ReturnType<typeof vi.fn>, offChanged: ReturnType<typeof vi.fn>;
const writeText = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  vi.mocked(ipc.refreshAppSettings).mockReset().mockResolvedValue(initial);
  vi.mocked(ipc.getAppSettings).mockReset().mockResolvedValue(initial);
  vi.mocked(ipc.updateAppSettings).mockReset().mockResolvedValue();
  vi.mocked(ipc.rotateWebPairKey).mockReset().mockResolvedValue("NEW-CODE");
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  offConnected = vi.fn(); offChanged = vi.fn();
  vi.mocked(listen).mockReset().mockImplementation(async (_event, callback) => { connected = callback; return offConnected; });
  vi.mocked(listenSettingsChanged).mockReset().mockImplementation(async (callback) => { changed = callback; return offChanged; });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
async function render() { await act(async () => root.render(<WebAuthCard />)); }
function button(key: string) { return [...node.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === i18n.t(key) || item.getAttribute("aria-label") === i18n.t(key))!; }

describe("remote pairing settings feedback", () => {
  it("shows read failures and retries without manufacturing a pairing code", async () => {
    vi.mocked(ipc.refreshAppSettings).mockRejectedValueOnce(new Error("auth read denied"));
    await render();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("auth read denied");
    expect(button("settings.webAuthCopy").disabled).toBe(true);
    await act(async () => button("common.refresh").click());
    expect(node.textContent).toContain("OLD-CODE"); expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves the pairing code on rotation failure and retries without revoking devices", async () => {
    vi.mocked(ipc.rotateWebPairKey).mockRejectedValueOnce(new Error("rotation denied"));
    await render(); await act(async () => button("settings.webAuthRotate").click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("rotation denied");
    expect(node.textContent).toContain("OLD-CODE"); expect(button("settings.webAuthRotate").disabled).toBe(false);
    await act(async () => button("settings.webAuthRotate").click());
    expect(node.textContent).toContain("NEW-CODE"); expect(node.querySelector('[role="alert"]')).toBeNull();
    expect(ipc.webDeviceRevoke).not.toHaveBeenCalled(); expect(ipc.updateAppSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty rotation result while retaining the current code", async () => {
    vi.mocked(ipc.rotateWebPairKey).mockResolvedValueOnce("");
    await render(); await act(async () => button("settings.webAuthRotate").click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("settings.webAuthRotateFailed"));
    expect(node.textContent).toContain("OLD-CODE");
  });

  it("reports clipboard failure and allows copying the same valid key again", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));
    await render(); await act(async () => button("settings.webAuthCopy").click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("clipboard blocked");
    expect(node.textContent).toContain("OLD-CODE");
    await act(async () => button("settings.webAuthCopy").click());
    expect(writeText).toHaveBeenLastCalledWith("OLD-CODE"); expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves current settings on a rejected toggle and retains the existing successful write shape", async () => {
    vi.mocked(ipc.updateAppSettings).mockRejectedValueOnce(new Error("toggle rejected"));
    await render(); await act(async () => button("settings.webAuthDisable").click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("toggle rejected");
    expect(node.textContent).toContain("OLD-CODE"); expect(button("settings.webAuthDisable").disabled).toBe(false);
    vi.mocked(ipc.refreshAppSettings).mockResolvedValueOnce({ ...initial, webAuthEnabled: false, webAuthKey: null });
    await act(async () => button("settings.webAuthDisable").click());
    expect(ipc.updateAppSettings).toHaveBeenLastCalledWith({ ...initial, webAuthEnabled: false, webAuthKey: null });
    expect(button("settings.webAuthEnable")).toBeTruthy(); expect(button("settings.webAuthCopy").disabled).toBe(true);
  });

  it("reloads shared settings and reconnects, fencing a late rotation result", async () => {
    let resolve!: (key: string) => void;
    vi.mocked(ipc.rotateWebPairKey).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(); await act(async () => button("settings.webAuthRotate").click());
    vi.mocked(ipc.refreshAppSettings).mockResolvedValueOnce({ ...initial, webAuthKey: "SHARED-CODE" });
    await act(async () => changed());
    await act(async () => resolve("STALE-CODE"));
    expect(node.textContent).toContain("SHARED-CODE"); expect(node.textContent).not.toContain("STALE-CODE");
    await act(async () => connected({ payload: null })); expect(node.textContent).toContain("OLD-CODE");
    await act(async () => root.unmount());
    expect(offConnected).toHaveBeenCalledOnce(); expect(offChanged).toHaveBeenCalledOnce();
    vi.mocked(ipc.refreshAppSettings).mockClear(); connected({ payload: null }); changed();
    expect(ipc.refreshAppSettings).not.toHaveBeenCalled();
  });

  it("ignores a late initial settings read after reconnection", async () => {
    let resolve!: (settings: AppSettings) => void;
    vi.mocked(ipc.refreshAppSettings).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(); await act(async () => connected({ payload: null }));
    await act(async () => resolve({ ...initial, webAuthKey: "STALE-CODE" }));
    expect(node.textContent).toContain("OLD-CODE"); expect(node.textContent).not.toContain("STALE-CODE");
  });

  it("cleans subscriptions resolving after unmount and ignores a late rejected read", async () => {
    const pending: Array<(off: () => void) => void> = [];
    vi.mocked(listen).mockImplementation(() => new Promise((done) => pending.push(done)));
    vi.mocked(listenSettingsChanged).mockImplementation(() => new Promise((done) => pending.push(done)));
    let reject!: (error: Error) => void;
    vi.mocked(ipc.refreshAppSettings).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    await render(); await act(async () => root.unmount());
    const late = pending.map(() => vi.fn());
    await act(async () => { pending.forEach((done, index) => done(late[index])); reject(new Error("late read")); });
    late.forEach((off) => expect(off).toHaveBeenCalledOnce());
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });
});
