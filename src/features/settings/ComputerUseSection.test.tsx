import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUsePermissionStatus } from "@/lib/ipc";

/**
 * 设置 → 电脑操控: the page is the grant/status surface `/ccgui-cua` points
 * at, so it has to render the real permission state rather than a claim, and
 * it must show which engines can actually receive the driver.
 */

const computerUsePermissionStatus = vi.fn();
const computerUseOpenPermissionSettings = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    computerUsePermissionStatus: () => computerUsePermissionStatus(),
    computerUseOpenPermissionSettings: (kind: string) =>
      computerUseOpenPermissionSettings(kind),
  },
}));

import "@/lib/i18n";
import i18n from "@/lib/i18n";
import { ComputerUseSection } from "./ComputerUseSection";
import { useChatStore } from "@/features/chat/store";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MAC_GRANTED: ComputerUsePermissionStatus = {
  accessibility: true,
  screenRecording: false,
  osPermissionsRequired: true,
};

let container: HTMLDivElement;
let root: Root;

async function render(status: ComputerUsePermissionStatus) {
  computerUsePermissionStatus.mockResolvedValue(status);
  await act(async () => {
    root.render(<ComputerUseSection />);
  });
}

beforeEach(() => {
  computerUsePermissionStatus.mockReset();
  computerUseOpenPermissionSettings.mockReset().mockResolvedValue(undefined);
  useChatStore.setState({
    engines: [
      {
        id: "codex",
        available: true,
        enabled: true,
        supportsImages: true,
        supportsComputerUse: true,
        permissions: ["auto"],
      },
      {
        id: "kimi",
        available: true,
        enabled: true,
        supportsImages: true,
        supportsComputerUse: false,
        permissions: ["auto"],
      },
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ComputerUseSection", () => {
  it("reports the real grant state instead of assuming it", async () => {
    await render(MAC_GRANTED);
    const text = container.textContent ?? "";
    expect(text).toContain(i18n.t("settings.computerUseGranted"));
    expect(text).toContain(i18n.t("settings.computerUseNotGranted"));
  });

  it("hides the grant flow where the OS asks for nothing", async () => {
    await render({
      accessibility: false,
      screenRecording: false,
      osPermissionsRequired: false,
    });
    const text = container.textContent ?? "";
    expect(text).toContain(i18n.t("settings.computerUseNoGrantNeeded"));
    // No un-granted rows that would send the user chasing a permission the
    // platform never asks for.
    expect(text).not.toContain(i18n.t("settings.computerUseAccessibility"));
  });

  it("lists each engine with whether it can mount the driver", async () => {
    await render(MAC_GRANTED);
    const text = container.textContent ?? "";
    expect(text).toContain("Codex CLI");
    expect(text).toContain("Kimi CLI");
    // Exact chip text: "不支持" contains "支持", so a substring count would
    // pass no matter which engines were supported.
    const chipTexts = [...container.querySelectorAll("span")].map((el) =>
      el.textContent?.trim(),
    );
    const count = (label: string) =>
      chipTexts.filter((value) => value === label).length;
    expect(count(i18n.t("settings.computerUseEngineSupported"))).toBe(1);
    expect(count(i18n.t("settings.computerUseEngineUnsupported"))).toBe(1);
  });

  it("states how a run starts and that the pointer cannot be switched off", async () => {
    await render(MAC_GRANTED);
    const text = container.textContent ?? "";
    expect(text).toContain("/ccgui-cua");
    expect(text).toContain(i18n.t("settings.computerUseCursor"));
  });
});
