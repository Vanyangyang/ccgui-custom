import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type WebDevice } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { listenWebDevices } from "@/lib/events";
import { WebDevicesCard } from "./WebDevicesCard";
import i18n from "@/lib/i18n";

vi.mock("@/lib/ipc", () => ({ ipc: { webDevices: vi.fn(), webDeviceApprove: vi.fn(), webDeviceRevoke: vi.fn(), webDeviceRename: vi.fn() } }));
vi.mock("@/lib/transport", () => ({ isWeb: true, listen: vi.fn() }));
vi.mock("@/lib/events", () => ({ listenWebDevices: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const device: WebDevice = { id: "remote-browser-id", name: "Original device", userAgent: "Windows Chrome/1", createdAt: 1, lastSeenAt: 2, approvedAt: 1 };
let node: HTMLDivElement, root: Root;
let connected: (event: { payload: unknown }) => void, changed: () => void;
let offConnected: ReturnType<typeof vi.fn>, offChanged: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  vi.mocked(ipc.webDevices).mockReset().mockResolvedValue([device]);
  vi.mocked(ipc.webDeviceApprove).mockReset().mockResolvedValue(true);
  vi.mocked(ipc.webDeviceRevoke).mockReset().mockResolvedValue(true);
  vi.mocked(ipc.webDeviceRename).mockReset().mockResolvedValue(true);
  offConnected = vi.fn(); offChanged = vi.fn();
  vi.mocked(listen).mockReset().mockImplementation(async (_event, callback) => { connected = callback; return offConnected; });
  vi.mocked(listenWebDevices).mockReset().mockImplementation(async (callback) => { changed = callback; return offChanged; });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
async function render() { await act(async () => root.render(<WebDevicesCard />)); }
function button(key: string) { return [...node.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === i18n.t(key) || item.getAttribute("aria-label") === i18n.t(key))!; }

describe("remote device management feedback", () => {
  it("reports loading failures and refreshes to retry", async () => {
    vi.mocked(ipc.webDevices).mockRejectedValueOnce(new Error("device read denied"));
    await render();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("device read denied");
    await act(async () => button("common.refresh").click());
    expect(node.querySelector('[role="alert"]')).toBeNull(); expect(node.textContent).toContain(device.name);
  });

  it.each(["approve", "revoke"] as const)("preserves the device on %s failure and permits retry", async (action) => {
    const call = action === "approve" ? ipc.webDeviceApprove : ipc.webDeviceRevoke;
    const label = action === "approve" ? "settings.webDeviceApprove" : "settings.webDeviceRevoke";
    if (action === "approve") vi.mocked(ipc.webDevices).mockResolvedValue([{ ...device, approvedAt: null }]);
    vi.mocked(call).mockRejectedValueOnce(new Error(`${action} rejected`));
    await render(); await act(async () => button(label).click());
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(`${action} rejected`);
    expect(node.textContent).toContain(device.name); expect(button(label).disabled).toBe(false);
    await act(async () => button(label).click());
    expect(call).toHaveBeenCalledTimes(2); expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a failed rename in the editor, treats false as a failure, and retries without duplicated blur writes", async () => {
    vi.mocked(ipc.webDeviceRename).mockResolvedValueOnce(false);
    await render(); await act(async () => button("settings.webDeviceRename").click());
    const input = node.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Revised name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(ipc.webDeviceRename).toHaveBeenCalledExactlyOnceWith(device.id, "Revised name");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("settings.webDeviceActionFailed"));
    expect(node.querySelector<HTMLInputElement>("input")?.value).toBe("Revised name");
    vi.mocked(ipc.webDevices).mockResolvedValueOnce([{ ...device, name: "Revised name" }]);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(ipc.webDeviceRename).toHaveBeenCalledTimes(2);
    expect(node.querySelector("input")).toBeNull(); expect(node.textContent).toContain("Revised name");
  });

  it("serializes repeated approval clicks while the request is pending", async () => {
    let resolve!: (ok: boolean) => void;
    vi.mocked(ipc.webDevices).mockResolvedValue([{ ...device, approvedAt: null }]);
    vi.mocked(ipc.webDeviceApprove).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => { button("settings.webDeviceApprove").click(); button("settings.webDeviceApprove").click(); });
    expect(ipc.webDeviceApprove).toHaveBeenCalledOnce(); expect(button("settings.webDeviceApprove").disabled).toBe(true);
    await act(async () => resolve(true));
    expect(button("settings.webDeviceApprove").disabled).toBe(false);
  });

  it("reconciles changed/reconnected lists and ignores a late initial result", async () => {
    let resolve!: (devices: WebDevice[]) => void;
    vi.mocked(ipc.webDevices).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => connected({ payload: null }));
    expect(node.textContent).toContain(device.name);
    await act(async () => resolve([{ ...device, name: "Stale device" }]));
    expect(node.textContent).not.toContain("Stale device");
    vi.mocked(ipc.webDevices).mockResolvedValueOnce([{ ...device, name: "Shared new name" }]);
    await act(async () => changed()); expect(node.textContent).toContain("Shared new name");
    await act(async () => root.unmount());
    expect(offConnected).toHaveBeenCalledOnce(); expect(offChanged).toHaveBeenCalledOnce();
    vi.mocked(ipc.webDevices).mockClear(); connected({ payload: null }); changed();
    expect(ipc.webDevices).not.toHaveBeenCalled();
  });

  it("cleans late subscriptions and late action failure after unmount", async () => {
    const pending: Array<(off: () => void) => void> = [];
    vi.mocked(listen).mockImplementation(() => new Promise((done) => pending.push(done)));
    vi.mocked(listenWebDevices).mockImplementation(() => new Promise((done) => pending.push(done)));
    let reject!: (error: Error) => void;
    vi.mocked(ipc.webDeviceRevoke).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    await render(); await act(async () => button("settings.webDeviceRevoke").click());
    await act(async () => root.unmount());
    const late = pending.map(() => vi.fn());
    await act(async () => { pending.forEach((done, index) => done(late[index])); reject(new Error("late failure")); });
    late.forEach((off) => expect(off).toHaveBeenCalledOnce());
    expect(node.querySelector('[role="alert"]')).toBeNull();
  });
});
