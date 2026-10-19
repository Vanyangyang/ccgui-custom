import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { GrantedRootsCard } from "./GrantedRootsCard";
import { builtinSearchEntries } from "./builtin-search";
import i18n from "@/lib/i18n";

vi.mock("@/lib/transport", () => ({ isWeb: true, listen: vi.fn(), invoke: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { listGrantedRoots: vi.fn(), revokeGrantedRoot: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let node: HTMLDivElement, root: Root;
const callbacks = new Map<string, (event: { payload: unknown }) => void>();
let unlisteners: Array<ReturnType<typeof vi.fn>>;
const onError = vi.fn(), onClearError = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en"); callbacks.clear(); unlisteners = [];
  vi.mocked(ipc.listGrantedRoots).mockReset().mockResolvedValue(["/host/data"]);
  vi.mocked(ipc.revokeGrantedRoot).mockReset().mockResolvedValue();
  vi.mocked(listen).mockReset().mockImplementation(async (event, callback) => {
    callbacks.set(event, callback); const off = vi.fn(); unlisteners.push(off); return off;
  });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
async function render() { await act(async () => root.render(<GrantedRootsCard onError={onError} onClearError={onClearError} />)); }
function confirmButton(text: string) { return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!; }

describe("remote directory grant management", () => {
  it("shows host roots and indexes the settings section in a browser", async () => {
    await render();
    expect(node.textContent).toContain("/host/data");
    expect(builtinSearchEntries).toContainEqual(expect.objectContaining({ page: "workspaces", anchor: "grantedRoots" }));
  });

  it("requires confirmation, cancels without a write, and reloads after revocation", async () => {
    await render();
    await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
    expect(ipc.revokeGrantedRoot).not.toHaveBeenCalled();
    await act(async () => confirmButton("Cancel").click());
    expect(ipc.revokeGrantedRoot).not.toHaveBeenCalled();
    await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
    vi.mocked(ipc.listGrantedRoots).mockResolvedValueOnce([]);
    await act(async () => confirmButton("Confirm").click());
    expect(ipc.revokeGrantedRoot).toHaveBeenCalledExactlyOnceWith("/host/data");
    expect(node.textContent).not.toContain("/host/data");
  });

  it("retains the root and reports a rejected revoke", async () => {
    const rejected = new Error("root revoke rejected");
    vi.mocked(ipc.revokeGrantedRoot).mockRejectedValueOnce(rejected);
    await render();
    await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => confirmButton("Confirm").click());
    expect(onError).toHaveBeenCalledWith(rejected); expect(node.textContent).toContain("/host/data");
  });

  it("refreshes shared changes and reconnections, recovers failures, and detaches on unmount", async () => {
    await render();
    vi.mocked(ipc.listGrantedRoots).mockResolvedValueOnce(["/host/new"]);
    await act(async () => callbacks.get("granted-roots://changed")!({ payload: null }));
    expect(node.textContent).toContain("/host/new"); expect(node.textContent).not.toContain("/host/data");
    const error = new Error("host disconnected"); vi.mocked(ipc.listGrantedRoots).mockRejectedValueOnce(error);
    await act(async () => callbacks.get("granted-roots://changed")!({ payload: null }));
    expect(onError).toHaveBeenCalledWith(error);
    await act(async () => callbacks.get("transport://connected")!({ payload: null }));
    expect(node.textContent).toContain("/host/data"); expect(onClearError).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    unlisteners.forEach((off) => expect(off).toHaveBeenCalledOnce());
    vi.mocked(ipc.listGrantedRoots).mockClear();
    callbacks.forEach((callback) => callback({ payload: null }));
    expect(ipc.listGrantedRoots).not.toHaveBeenCalled();
  });

  it("does not accept an old list response after a newer shared change", async () => {
    let resolve!: (roots: string[]) => void;
    vi.mocked(ipc.listGrantedRoots).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => callbacks.get("transport://connected")!({ payload: null }));
    expect(node.textContent).toContain("/host/data");
    await act(async () => resolve(["/host/stale"]));
    expect(node.textContent).not.toContain("/host/stale");
  });

  it("cleans both subscriptions resolving after unmount and ignores late read errors", async () => {
    const pending: Array<(off: () => void) => void> = [];
    let reject!: (error: Error) => void;
    vi.mocked(ipc.listGrantedRoots).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    vi.mocked(listen).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    await render(); await act(async () => root.unmount());
    const late = pending.map(() => vi.fn());
    await act(async () => { pending.forEach((resolve, index) => resolve(late[index])); reject(new Error("late error")); });
    late.forEach((off) => expect(off).toHaveBeenCalledOnce()); expect(onError).not.toHaveBeenCalled();
  });
});
