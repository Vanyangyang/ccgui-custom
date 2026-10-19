import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/version/distribution", () => ({ IS_CUSTOM_DISTRIBUTION: false, CUSTOM_UPSTREAM_RELEASE: "v1.1.0" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({
  getAppVersion: async () => "1.0.5",
  openExternal: vi.fn(),
}));

import "@/lib/i18n";
import { useUpdateStore } from "@/features/update/store";
import { UpdateSection } from "./UpdateSection";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const startUpdateSpy = vi.fn();
const checkForUpdatesSpy = vi.fn();

describe("UpdateSection update row", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    startUpdateSpy.mockReset();
    checkForUpdatesSpy.mockReset();
    // The update store is module-level session state: drive it directly and
    // swap the two actions for spies so button clicks are observable.
    useUpdateStore.setState({
      stage: "idle",
      version: undefined,
      latestVersion: undefined,
      latestPubDate: undefined,
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined,
      startUpdate: startUpdateSpy,
      checkForUpdates: checkForUpdatesSpy,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
    }
    container.remove();
  });

  async function render() {
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(<UpdateSection />);
    });
  }

  function rowButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }

  it("available: the row carries the version line and its own update CTA", async () => {
    useUpdateStore.setState({ stage: "available", version: "1.0.6" });
    await render();

    // Previously the row went blank here and the only affordance was the
    // toast (which the settings shell used to cover).
    expect(container.textContent).toContain("发现新版本 v1.0.6");

    const cta = rowButton("立即更新");
    expect(cta).not.toBeUndefined();
    expect(cta!.disabled).toBe(false);

    await act(async () => cta!.click());
    expect(startUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("available: the check button stays available for a re-check", async () => {
    useUpdateStore.setState({ stage: "available", version: "1.0.6" });
    await render();

    const check = rowButton("检查更新");
    expect(check).not.toBeUndefined();
    await act(async () => check!.click());
    expect(checkForUpdatesSpy).toHaveBeenCalledWith({ interactive: true });
  });

  it("downloading: progress replaces the actions instead of offering a race", async () => {
    useUpdateStore.setState({ stage: "downloading", downloadedBytes: 512, totalBytes: 1024 });
    await render();

    expect(container.textContent).toContain("正在下载更新… 50%");
    expect(rowButton("立即更新")!.disabled).toBe(true);
    expect(rowButton("检查更新")).toBeUndefined();
  });

  it("error: the row surfaces the failure and offers a retry", async () => {
    useUpdateStore.setState({ stage: "error", error: "network down" });
    await render();

    expect(container.textContent).toContain("更新失败：network down");
    expect(rowButton("立即更新")).toBeUndefined();
    expect(rowButton("检查更新")!.disabled).toBe(false);
  });
});
