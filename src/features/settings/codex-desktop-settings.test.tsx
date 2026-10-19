import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/lib/ipc";

const { getAppSettings, updateAppSettings } = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { getAppSettings, updateAppSettings } }));

import i18n from "@/lib/i18n";
import { CodexDesktopHandoffRow } from "./CodexDesktopHandoffRow";
import { builtinSearchEntries } from "./builtin-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let persisted: AppSettings;

beforeEach(() => {
  persisted = { theme: "dark", autoTitleModel: "haiku", autoTitleEffort: "low" } as AppSettings;
  getAppSettings.mockReset().mockImplementation(async () => persisted);
  updateAppSettings.mockReset().mockImplementation(async (next: AppSettings) => { persisted = next; });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const toggle = () => container.querySelector<HTMLInputElement>('input[role="switch"]')!;
const mount = async () => { await act(async () => root.render(<CodexDesktopHandoffRow />)); };
const click = async () => { await act(async () => toggle().click()); };

describe("Codex Desktop handoff preference", () => {
  it("legacy settings render off with a searchable, visible explanation without writing", async () => {
    await mount();
    expect(toggle().checked).toBe(false);
    expect(updateAppSettings).not.toHaveBeenCalled();
    const anchor = container.querySelector('[data-setting-anchor="codexDesktopHandoffEnabled"]')!;
    expect(anchor.textContent).toContain(i18n.t("settings.codexDesktopHandoffDesc"));
    expect(builtinSearchEntries.find((entry) => entry.anchor === "codexDesktopHandoffEnabled"))
      .toMatchObject({ page: "cli:codex", keywords: expect.arrayContaining(["desktop", "交接"]) });
  });

  it("saves explicit on/off against fresh shared settings and restores on reopening", async () => {
    await mount();
    persisted = { ...persisted, autoTitleEffort: "xhigh", futurePreference: { keep: true } } as AppSettings;
    const fresh = persisted;
    await click();
    expect(updateAppSettings).toHaveBeenLastCalledWith({ ...fresh, codexDesktopHandoffEnabled: true });
    expect(toggle().checked).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(toggle().checked).toBe(true);
    await click();
    expect(persisted).toMatchObject({ codexDesktopHandoffEnabled: false, autoTitleEffort: "xhigh", futurePreference: { keep: true } });
    expect(toggle().checked).toBe(false);
  });

  it("a failed save leaves the persisted selection and shows the error", async () => {
    await mount();
    updateAppSettings.mockRejectedValueOnce(new Error("save denied"));
    await click();
    expect(toggle().checked).toBe(false);
    expect(persisted.codexDesktopHandoffEnabled).toBeUndefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("save denied");
  });

  it("a failed fresh read never writes a stale settings snapshot", async () => {
    await mount();
    getAppSettings.mockRejectedValueOnce(new Error("read denied"));
    await click();
    expect(updateAppSettings).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("read denied");
  });

  it("disables the control on initial read failure", async () => {
    getAppSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    await mount();
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(false);
    expect(updateAppSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("settings unavailable");
  });

  it("blocks repeated writes while a save is pending", async () => {
    await mount();
    let finish!: () => void;
    updateAppSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await click();
    expect(toggle().disabled).toBe(true);
    await click();
    expect(updateAppSettings).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
  });
});
