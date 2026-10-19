import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { WebRelayDeployCard } from "./WebRelayDeployCard";
import i18n from "@/lib/i18n";
import { save } from "@tauri-apps/plugin-dialog";

vi.mock("@/lib/transport", () => ({ isWeb: true, webToken: null, serverVersion: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { relayDeployPack: vi.fn(), relayDeploy: vi.fn() } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let node: HTMLDivElement, root: Root;
const onRelayKeyChange = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  vi.mocked(ipc.relayDeployPack).mockReset().mockResolvedValue("generated-key");
  vi.spyOn(window, "prompt").mockReturnValue("/host/exports/ccgui-relay.zip");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
async function render(key = "") { await act(async () => root.render(<WebRelayDeployCard relayKey={key} onRelayKeyChange={onRelayKeyChange} onDeployed={() => {}} saveRelayFields={async () => {}} />)); }
const exportButton = () => [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === i18n.t("settings.webRelayExportSource"))!;

describe("remote relay export", () => {
  it("writes the confirmed host path and adopts a newly generated key", async () => {
    await render(); await act(async () => exportButton().click());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(ipc.relayDeployPack).toHaveBeenCalledExactlyOnceWith("/host/exports/ccgui-relay.zip", null);
    expect(onRelayKeyChange).toHaveBeenCalledWith("generated-key"); expect(save).not.toHaveBeenCalled();
  });
  it.each(["path", "overwrite"])("cancels %s without a write", async (where) => {
    if (where === "path") vi.mocked(window.prompt).mockReturnValueOnce(null);
    else vi.mocked(window.confirm).mockReturnValueOnce(false);
    await render(); await act(async () => exportButton().click());
    expect(ipc.relayDeployPack).not.toHaveBeenCalled(); expect(onRelayKeyChange).not.toHaveBeenCalled();
  });
  it("keeps the existing key and disables repeated export while the write is pending", async () => {
    let resolve!: (key: string) => void;
    vi.mocked(ipc.relayDeployPack).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render("existing-key"); await act(async () => exportButton().click());
    expect(exportButton().disabled).toBe(true);
    await act(async () => exportButton().click());
    expect(ipc.relayDeployPack).toHaveBeenCalledExactlyOnceWith("/host/exports/ccgui-relay.zip", "existing-key");
    await act(async () => resolve("existing-key"));
    expect(exportButton().disabled).toBe(false); expect(onRelayKeyChange).not.toHaveBeenCalled();
  });
  it("reports a failed export without adopting a key or leaving the button disabled", async () => {
    vi.mocked(ipc.relayDeployPack).mockRejectedValueOnce(new Error("host export denied"));
    await render(); await act(async () => exportButton().click());
    expect(node.querySelector('[aria-label="host export denied"]')).toBeTruthy();
    expect(exportButton().disabled).toBe(false); expect(onRelayKeyChange).not.toHaveBeenCalled();
  });
});
