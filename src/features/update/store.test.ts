import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/version/distribution", () => ({ IS_CUSTOM_DISTRIBUTION: false }));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({ getAppVersion: async () => "1.0.5" }));

// vi.mock calls above are hoisted, so this static import sees the mocks.
import { useReleaseNotesTabStore } from "./notes-tab";
import { useUpdateStore } from "./store";

function reset() {
  useUpdateStore.setState({
    stage: "idle",
    version: undefined,
    notesRelease: undefined,
    latestVersion: undefined,
    latestPubDate: undefined,
    error: undefined,
    downloadedBytes: 0,
    totalBytes: undefined,
  });
  useReleaseNotesTabStore.setState({ open: false, active: false, unreadVersion: undefined });
  invokeMock.mockReset();
  checkMock.mockReset();
}

describe("checkForUpdates no-update feedback", () => {
  beforeEach(reset);

  it("interactive check with no update reports the latest release version and date", async () => {
    checkMock.mockResolvedValue(null);
    invokeMock.mockResolvedValue({ version: "1.0.5", pubDate: "2026-09-18T04:13:02Z" });

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBe("1.0.5");
    expect(state.latestPubDate).toBe("2026-09-18T04:13:02Z");
    expect(invokeMock).toHaveBeenCalledWith("fetch_latest_release_info", undefined);
  });

  it("keeps the latest result visible instead of auto-resetting to idle", async () => {
    vi.useFakeTimers();
    try {
      checkMock.mockResolvedValue(null);
      invokeMock.mockResolvedValue({ version: "1.0.5", pubDate: null });

      await useUpdateStore.getState().checkForUpdates({ interactive: true });
      // The old 2s auto-reset made the feedback vanish; any scheduled reset
      // timer would fire here.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(useUpdateStore.getState().stage).toBe("latest");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the bare message when the manifest probe fails", async () => {
    checkMock.mockResolvedValue(null);
    invokeMock.mockRejectedValue(new Error("offline"));

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBeUndefined();
  });

  it("silent background checks stay silent and skip the manifest probe", async () => {
    checkMock.mockResolvedValue(null);

    await useUpdateStore.getState().checkForUpdates();

    expect(useUpdateStore.getState().stage).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reuses the update handle's version/date when the endpoint points at the running release", async () => {
    checkMock.mockResolvedValue({
      version: "v1.0.5",
      date: "2026-09-17T00:00:00Z",
      close: vi.fn(),
    });

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBe("1.0.5");
    expect(state.latestPubDate).toBe("2026-09-17T00:00:00Z");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("release-notes tab", () => {
  beforeEach(reset);

  it("opens the tab and keeps the manifest notes when an update is found", async () => {
    checkMock.mockResolvedValue({
      version: "1.0.9",
      date: "2026-10-01T00:00:00Z",
      body: "## Fixes\n- crash on quit",
      close: vi.fn(),
    });

    // 后台自动检查（非 interactive）同样要把说明开成页签。
    await useUpdateStore.getState().checkForUpdates();

    expect(useReleaseNotesTabStore.getState()).toMatchObject({ open: true, active: true });
    expect(useUpdateStore.getState().notesRelease).toEqual({
      version: "1.0.9",
      date: "2026-10-01T00:00:00Z",
      body: "## Fixes\n- crash on quit",
    });
  });

  it("keeps the notes snapshot after the user defers the update", async () => {
    checkMock.mockResolvedValue({ version: "1.0.9", body: "notes", close: vi.fn() });
    await useUpdateStore.getState().checkForUpdates();

    useUpdateStore.getState().dismiss();

    // 「稍后」只收起待更新状态与浮层；已打开的说明页签还能继续读。
    expect(useUpdateStore.getState().stage).toBe("idle");
    expect(useUpdateStore.getState().version).toBeUndefined();
    expect(useUpdateStore.getState().notesRelease).toEqual({ version: "1.0.9", date: undefined, body: "notes" });
  });

  it("a discovered update leaves no unread marker (the toast already asks for action)", async () => {
    checkMock.mockResolvedValue({ version: "1.0.9", body: "notes", close: vi.fn() });

    await useUpdateStore.getState().checkForUpdates();

    expect(useReleaseNotesTabStore.getState().unreadVersion).toBeUndefined();
  });

  it("closing the tab clears the upgrade announcement's unread marker", () => {
    useReleaseNotesTabStore.getState().announceNewVersion("1.0.9");
    expect(useReleaseNotesTabStore.getState()).toMatchObject({
      open: true,
      active: true,
      unreadVersion: "1.0.9",
    });

    useReleaseNotesTabStore.getState().close();

    // 关掉页签 = 看过了：页签圆点与页头「新版本」一起消失。
    expect(useReleaseNotesTabStore.getState()).toMatchObject({
      open: false,
      active: false,
      unreadVersion: undefined,
    });
  });
});
