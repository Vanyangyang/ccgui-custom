import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appVersion: "1.0.6" as string | null,
  isWeb: false,
}));

vi.mock("@/lib/platform", () => ({
  get isWeb() {
    return mocks.isWeb;
  },
  getAppVersion: async () => mocks.appVersion,
}));

import { CHANGELOG_DATA } from "@/version/changelog";
import { useReleaseNotesTabStore } from "./notes-tab";
import {
  LAST_SEEN_VERSION_KEY,
  announceReleaseAfterUpgrade,
  compareVersions,
} from "./upgrade-announcement";

/** A version the local changelog has an entry for — the announcement needs
 *  one to open the tab with. */
const CURRENT = CHANGELOG_DATA[0].version;
/** A version guaranteed to be older than CURRENT in these tests. */
const OLDER = "0.0.1";
/** A version with no local entry (asserts the empty-tab guard). */
const UNKNOWN = "9.9.9";

function reset() {
  mocks.appVersion = CURRENT;
  mocks.isWeb = false;
  localStorage.clear();
  useReleaseNotesTabStore.setState({ open: false, active: false, unreadVersion: undefined });
}

describe("announceReleaseAfterUpgrade", () => {
  beforeEach(reset);

  it("records the baseline silently on a fresh install", async () => {
    await announceReleaseAfterUpgrade();

    // 首次安装没有可对比的旧版本，谈不上「更新」：只记基线，不弹说明。
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(CURRENT);
    expect(useReleaseNotesTabStore.getState()).toMatchObject({
      open: false,
      unreadVersion: undefined,
    });
  });

  it("opens the release notes and marks them unread when the version moved forward", async () => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, OLDER);

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState()).toMatchObject({
      open: true,
      active: true,
      unreadVersion: CURRENT,
    });
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(CURRENT);
  });

  it("stays silent when the running version did not change", async () => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, CURRENT);

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState().open).toBe(false);
  });

  it("normalizes the v prefix on both sides", async () => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, `v${OLDER}`);
    mocks.appVersion = `v${CURRENT}`;

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState().open).toBe(true);
  });

  it("does not announce a downgrade and re-baselines it", async () => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, CHANGELOG_DATA[0].version);
    mocks.appVersion = CHANGELOG_DATA[1].version;

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState().open).toBe(false);
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(CHANGELOG_DATA[1].version);
  });

  it("does not announce a version the local changelog has no entry for", async () => {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, OLDER);
    mocks.appVersion = UNKNOWN;

    await announceReleaseAfterUpgrade();

    // 本地没有这个版本的说明：不打开空页签；基线照样前进，下次启动不再重来。
    expect(useReleaseNotesTabStore.getState().open).toBe(false);
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(UNKNOWN);
  });

  it("does nothing in the remote web frontend (no local shell version)", async () => {
    mocks.isWeb = true;
    localStorage.setItem(LAST_SEEN_VERSION_KEY, OLDER);

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState().open).toBe(false);
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(OLDER);
  });

  it("does nothing when the app version is unavailable", async () => {
    mocks.appVersion = null;
    localStorage.setItem(LAST_SEEN_VERSION_KEY, OLDER);

    await announceReleaseAfterUpgrade();

    expect(useReleaseNotesTabStore.getState().open).toBe(false);
    expect(localStorage.getItem(LAST_SEEN_VERSION_KEY)).toBe(OLDER);
  });
});

describe("compareVersions", () => {
  it("orders numeric segments and pads missing ones", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.9", "1.0.10")).toBeLessThan(0);
    expect(compareVersions("1.1", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.9", "1.0.9")).toBe(0);
  });

  it("treats unparsable versions as equal instead of announcing them", () => {
    // 预发布后缀之类认不出的版本号：宁可少宣布一次。
    expect(compareVersions("1.1.0-beta.1", "1.0.9")).toBe(0);
    expect(compareVersions("1.0.9-beta.1", "1.0.9")).toBe(0);
  });
});
