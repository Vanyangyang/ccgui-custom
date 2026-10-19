import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isWeb } from "@/lib/transport";
import { getAppVersion } from "@/lib/platform";
import { useReleaseNotesTabStore } from "./notes-tab";
import { IS_CUSTOM_DISTRIBUTION } from "@/version/distribution";

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "latest"
  | "error";

/**
 * 发现新版本时从更新清单抓下来的说明快照（Tauri manifest 的 notes）。升级后
 * 首启宣布的版本不写这里：那个场景没有待更新版本，版本号来自 `notes-tab` 的
 * unreadVersion，正文读本地版本记录（见 upgrade-announcement.ts）。
 */
export interface ReleaseNotesSnapshot {
  version: string;
  /** ISO publish date from the manifest, when it has one. */
  date?: string;
  /** Release notes markdown; absent when the manifest carries none. */
  body?: string;
}

interface UpdateStore {
  stage: UpdateStage;
  /** Version of the pending update, when one was found. */
  version?: string;
  /**
   * 最近一次发现新版本时的说明快照。**不随 `dismiss` 清空**：更新说明页签
   * （ReleaseNotesPane）在用户点了「稍后」之后仍要能继续读这份说明，只有
   * 下一次检测到别的版本才会被覆盖。
   */
  notesRelease?: ReleaseNotesSnapshot;
  /** Latest release on the server, shown on the "up to date" result so the
   *  user can see what the check compared against. `check()` returns null
   *  when current, so this comes from a separate manifest probe. */
  latestVersion?: string;
  /** ISO publish date of the latest release, when the manifest has one. */
  latestPubDate?: string;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
  /**
   * `interactive` surfaces failures and the "up to date" result to the user;
   * the background auto-check stays silent for both.
   */
  checkForUpdates: (options?: { interactive?: boolean }) => Promise<void>;
  startUpdate: () => Promise<void>;
  dismiss: () => void;
}

// plugin-updater's check() uses reqwest with no default timeout: when the
// update server is unreachable the promise never settles and the UI would
// sit on "checking" forever. Treat a timeout as a failed check.
const CHECK_TIMEOUT_MS = 15_000;

/** Download progress 0–100, null when the total size is unknown. Shared by
 *  every surface that renders the download stage (toast, settings row). */
export function downloadPercent(downloadedBytes: number, totalBytes?: number): number | null {
  return totalBytes && totalBytes > 0
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : null;
}

/** Mirrors `LatestReleaseInfo` in src-tauri/src/updater.rs. */
interface LatestReleaseInfo {
  version: string;
  pubDate?: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return result;
}

/** The plugin's Update handle lives outside React state; stale handles are
 *  closed so a superseded check never leaks a downloaded bundle. */
let pendingUpdate: Update | null = null;
let checkRequestId = 0;

async function closeUpdateHandle(update: Update | null) {
  try {
    await update?.close();
  } catch (error) {
    console.warn("[updater] failed to close update handle", error);
  }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  stage: "idle",
  downloadedBytes: 0,

  checkForUpdates: async (options) => {
    // The LAN web-access frontend has no native shell to update; the desktop
    // host serves it, so update checks are meaningless there.
    if (isWeb) return;

    // Custom source changes require an upstream merge and regression checks;
    // the official updater has no mechanism to preserve this patch set.
    if (IS_CUSTOM_DISTRIBUTION) {
      pendingUpdate = null;
      set({ stage: "idle", version: undefined, notesRelease: undefined, error: undefined });
      return;
    }

    const requestId = ++checkRequestId;
    const isStale = () => checkRequestId !== requestId;

    const applyNoUpdate = async (sameVersion: Update | null) => {
      const current = pendingUpdate;
      pendingUpdate = null;
      await closeUpdateHandle(current);

      if (!options?.interactive) {
        set({ stage: "idle" });
        return;
      }

      // The result stays visible until the next check — a "latest" message
      // that vanishes after two seconds reads as "no feedback at all".
      let latestVersion = sameVersion?.version.trim().replace(/^v/i, "");
      let latestPubDate = sameVersion?.date ?? undefined;
      if (!latestVersion) {
        // check() hands back null when already current, so the manifest's
        // version/date need a separate probe for the feedback line. Failing
        // that, the bare "up to date" message still shows.
        try {
          const info = await withTimeout(
            invoke<LatestReleaseInfo>("fetch_latest_release_info"),
            CHECK_TIMEOUT_MS,
            "latest release info timed out",
          );
          latestVersion = info.version.trim().replace(/^v/i, "");
          latestPubDate = info.pubDate ?? undefined;
        } catch (error) {
          console.warn("[updater] latest release info fetch failed", error);
        }
      }
      if (isStale()) return;
      set({ stage: "latest", latestVersion, latestPubDate, error: undefined });
    };

    let update: Update | null = null;
    try {
      set({ stage: "checking", error: undefined });
      update = await withTimeout(check(), CHECK_TIMEOUT_MS, "update check timed out");
      if (isStale()) return;

      if (!update) {
        await applyNoUpdate(null);
        return;
      }

      // The endpoint can momentarily point at the running release right after
      // publishing; don't nag the user to "update" to their own version.
      // Both sides normalized: the endpoint tags versions "v1.0.0".
      const currentVersion = (await getAppVersion())?.trim().replace(/^v/i, "") ?? null;
      if (currentVersion && update.version.trim().replace(/^v/i, "") === currentVersion) {
        await applyNoUpdate(update);
        return;
      }

      const previous = pendingUpdate;
      pendingUpdate = update;
      if (previous && previous !== update) void closeUpdateHandle(previous);

      set({
        stage: "available",
        version: update.version,
        notesRelease: { version: update.version, date: update.date, body: update.body },
        latestVersion: undefined,
        latestPubDate: undefined,
      });
      // 发现新版本 → 把更新说明开成中心页签（浮层提示照旧；关掉提示只收起
      // 提示本身，页签是用户可以自己关的面）。
      useReleaseNotesTabStore.getState().openTab();
    } catch (error) {
      if (isStale()) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[updater] check failed", message);
      set(
        options?.interactive
          ? { stage: "error", error: message }
          : { stage: "idle" },
      );
    } finally {
      if (update && (isStale() || pendingUpdate !== update)) {
        await closeUpdateHandle(update);
      }
    }
  },

  startUpdate: async () => {
    if (IS_CUSTOM_DISTRIBUTION) return;
    const update = pendingUpdate;
    if (!update) {
      await get().checkForUpdates({ interactive: true });
      return;
    }

    set({ stage: "downloading", downloadedBytes: 0, totalBytes: undefined, error: undefined });
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          set({ totalBytes: event.data.contentLength, downloadedBytes: 0 });
        } else if (event.event === "Progress") {
          set((state) => ({
            downloadedBytes: state.downloadedBytes + event.data.chunkLength,
          }));
        } else if (event.event === "Finished") {
          set({ stage: "installing" });
        }
      });

      set({ stage: "restarting" });
      await relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[updater] install failed", message);
      set({ stage: "error", error: message });
    }
  },

  dismiss: () => {
    checkRequestId += 1;
    const current = pendingUpdate;
    pendingUpdate = null;
    void closeUpdateHandle(current);
    set({
      stage: "idle",
      version: undefined,
      latestVersion: undefined,
      latestPubDate: undefined,
      error: undefined,
    });
  },
}));
