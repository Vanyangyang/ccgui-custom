import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({
  getAppVersion: async () => "1.0.5",
  openExternal: vi.fn(),
}));

import i18n from "@/lib/i18n";
import { CHANGELOG_DATA } from "@/version/changelog";
import { ReleaseNotesPane } from "./ReleaseNotesPane";
import { useReleaseNotesTabStore } from "./notes-tab";
import { useUpdateStore } from "./store";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const startUpdateSpy = vi.fn();
const checkForUpdatesSpy = vi.fn(async () => {});

/** The local changelog's newest entry, whose body the pane falls back to
 *  when no release was discovered (manual open / idle app). */
const newest = CHANGELOG_DATA[0];

/** First bolded title of the newest entry; asserting on this instead of a
 *  hard-coded phrase keeps the test valid across releases. */
const newestMarker = newest.content.zh.match(/\*\*(.+?)\*\*/)?.[1] ?? "";

describe("ReleaseNotesPane", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    startUpdateSpy.mockReset();
    useUpdateStore.setState({
      stage: "idle",
      version: undefined,
      notesRelease: undefined,
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined,
      latestVersion: undefined,
      latestPubDate: undefined,
      startUpdate: startUpdateSpy,
      checkForUpdates: checkForUpdatesSpy,
    });
    useReleaseNotesTabStore.setState({ open: true, active: true, unreadVersion: undefined });
    checkForUpdatesSpy.mockClear();
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
      nextRoot.render(<ReleaseNotesPane />);
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    );
  }

  /** 页头版本号旁的「新版本」胶囊：按元素精确匹配，不在正文里找这个词——
   *  更新说明正文本来就会写「新版本」。 */
  function hasNewVersionPill(): boolean {
    const label = i18n.t("changelog.newVersion");
    return [...container.querySelectorAll("span")].some((el) => el.textContent === label);
  }

  it("renders the discovered release's manifest notes, not the local entry", async () => {
    useUpdateStore.setState({
      stage: "available",
      version: "1.0.9",
      notesRelease: {
        version: "1.0.9",
        date: "2026-10-01T00:00:00Z",
        body: "## New Features\n- Release notes open as a tab",
      },
    });
    await render();

    expect(container.textContent).toContain("v1.0.9");
    expect(container.textContent).toContain("Release notes open as a tab");
    // The local newest entry must not leak under the v1.0.9 heading.
    expect(container.textContent).not.toContain(newestMarker);
  });

  it("falls back to the local version history when no release was discovered", async () => {
    await render();

    expect(container.textContent).toContain(`v${newest.version}`);
    expect(container.textContent).toContain(newestMarker);
    // 手动打开（没有升级宣布）不带「新版本」标记。
    expect(hasNewVersionPill()).toBe(false);
  });

  it("announces the upgraded version from the local history with the 新版本 marker", async () => {
    // 升级后首启：没有待更新版本（version/notesRelease 都空），版本号来自
    // 页签 store 的 unreadVersion——正文必须是那个版本自己的条目。
    const upgraded = CHANGELOG_DATA[1];
    const upgradedMarker = upgraded.content.zh.match(/\*\*(.+?)\*\*/)?.[1] ?? "";
    useReleaseNotesTabStore.setState({ open: true, active: true, unreadVersion: upgraded.version });
    await render();

    expect(container.textContent).toContain(`v${upgraded.version}`);
    expect(container.textContent).toContain(upgradedMarker);
    expect(hasNewVersionPill()).toBe(true);
    // 最新一条的说明不能顶替宣布版本（版本号与正文同源）。
    expect(container.textContent).not.toContain(newestMarker);
    // 没有待更新版本就不摆「立即更新」。
    expect(button("立即更新")).toBeUndefined();
  });

  it("checks for updates in place and reports the already-latest result", async () => {
    // 交互式检查：store 把最新版本与发布时间写进 latestVersion/latestPubDate
    // （见 store.ts 的 applyNoUpdate），页签跟随呈现。
    checkForUpdatesSpy.mockImplementation(async () => {
      useUpdateStore.setState({
        stage: "latest",
        latestVersion: "1.0.7",
        latestPubDate: "2026-09-23T00:00:00Z",
      });
    });
    await render();

    const check = button(i18n.t("settings.checkUpdates"));
    expect(check).not.toBeUndefined();
    await act(async () => check!.click());

    expect(checkForUpdatesSpy).toHaveBeenCalledWith({ interactive: true });
    expect(container.textContent).toContain("当前已是最新版本");
    // 日期跟随 UI 语言格式化：只断言「vX（… 发布）」结构，不钉死本地化格式。
    expect(container.textContent).toMatch(/最新版为 v1\.0\.7（.+ 发布）/);
  });

  it("disables the check while one is already running", async () => {
    useUpdateStore.setState({ stage: "checking" });
    await render();

    expect(container.textContent).toContain("正在检查更新…");
    expect(button(i18n.t("settings.checkUpdates"))!.disabled).toBe(true);
  });

  it("says so instead of borrowing another version's notes", async () => {
    // 检测到的版本清单没带 notes、本地也没有这个版本的条目。版本号不写死
    // 「下一个发布号」——那个号一旦真的进了 CHANGELOG_DATA，这条用例的前提
    // 就失效了，用一个本地记录保证不会有的号。
    const unknown = "9.9.9";
    useUpdateStore.setState({ notesRelease: { version: unknown } });
    await render();

    expect(container.textContent).toContain(`v${unknown}`);
    expect(container.textContent).toContain("这个版本没有附带更新说明。");
    expect(container.textContent).not.toContain(newestMarker);
  });

  it("offers the in-place update while a release is available", async () => {
    useUpdateStore.setState({
      stage: "available",
      version: "1.0.9",
      notesRelease: { version: "1.0.9", body: "notes" },
    });
    await render();

    expect(container.textContent).toContain("发现新版本 v1.0.9");
    const cta = button("立即更新");
    expect(cta).not.toBeUndefined();

    await act(async () => cta!.click());
    expect(startUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("swaps the CTA for download progress so it cannot be clicked twice", async () => {
    useUpdateStore.setState({
      stage: "downloading",
      version: "1.0.9",
      notesRelease: { version: "1.0.9", body: "notes" },
      downloadedBytes: 512,
      totalBytes: 1024,
    });
    await render();

    expect(container.textContent).toContain("正在下载更新… 50%");
    expect(button("立即更新")).toBeUndefined();
  });

  it("surfaces a failed install and keeps the check button as the retry", async () => {
    useUpdateStore.setState({
      stage: "error",
      version: "1.0.9",
      notesRelease: { version: "1.0.9", body: "notes" },
      error: "network down",
    });
    await render();

    expect(container.textContent).toContain("更新失败：network down");
    // 失败行是 alert（读屏会报），重试就是页头那个「检查更新」，不再另开一个按钮。
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("更新失败：network down");
    expect(button(i18n.t("settings.checkUpdates"))!.disabled).toBe(false);
  });
});
