import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAppVersion, isWeb } from "@/lib/platform";
import Activity from "lucide-react/dist/esm/icons/activity";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useRunningFeedback } from "@/components/base/action-feedback";
import { ipc, type AppMetrics } from "@/lib/ipc";
import { listenScanProgress, type ScanProgress } from "@/lib/events";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { cx } from "@/utils/cx";
import { compareByOrder, pluginIdFromRegistryKey, statusBarRegistry, useRegistry } from "@ccgui/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { useReleaseNotesTabStore } from "@/features/update/notes-tab";
import { SelfUpdateStatusChip } from "@/features/update/SelfUpdateStatusChip";
import { registerShortcutHandler } from "@/features/shortcuts/runtime";
import { PerformanceDiagnosticsDialog } from "@/features/settings/PerformanceDiagnostics";

import { applyZoom, changeZoom, onZoomChange, readZoomPct, ZOOM_STEP } from "@/lib/zoom";

const METRICS_POLL_MS = 3000;

function formatMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * App-wide bottom chrome: performance, zoom, history-sync status, version.
 *
 * The builtin items stay hand-wired here and are intentionally NOT migrated
 * into statusBarRegistry: they are deeply coupled to ipc/listen hooks, so
 * registration would buy little. The registry is the plugin extension point
 * (plan §4.2 #8): entries registered via ctx.ui.registerStatusBarItem render
 * after the sync status, before the version, each inside a PluginBoundary.
 * zone:"start" entries (SDK 0.3.8) render left-aligned ahead of the cluster.
 */
export function AppStatusBar() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [zoomPct, setZoomPct] = useState(readZoomPct);
  const [sync, setSync] = useState<ScanProgress | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const pluginItems = useRegistry(statusBarRegistry);
  // zone (SDK 0.3.8): "start" chips render left-aligned ahead of the
  // builtin cluster; everything else keeps the legacy right-side slot.
  const startItems = pluginItems.filter((def) => def.zone === "start");
  const endItems = pluginItems.filter((def) => def.zone !== "start");

  // Re-apply the persisted zoom on startup; Tauri does not restore it.
  useEffect(() => applyZoom(readZoomPct()), []);

  // Follow zoom changes from every entry point (shortcuts below, Settings →
  // 通用 → 外观 → 界面缩放) so the percent label never goes stale.
  useEffect(() => onZoomChange(setZoomPct), []);
  // Zoom keys live in the shortcut runtime (defaults ⌘= / ⌘- / ⌘0,
  // configurable in Settings → Shortcuts). Web mode skips registration:
  // browsers own ⌘± natively. readZoomPct() keeps handlers stale-free.
  useEffect(() => {
    if (isWeb) return;
    const unIn = registerShortcutHandler("zoomIn", () => changeZoom(readZoomPct() + ZOOM_STEP));
    const unOut = registerShortcutHandler("zoomOut", () => changeZoom(readZoomPct() - ZOOM_STEP));
    const unReset = registerShortcutHandler("zoomReset", () => changeZoom(100));
    return () => {
      unIn();
      unOut();
      unReset();
    };
  }, []);

  useEffect(() => {
    void getAppVersion().then((v) => {
      if (v) setVersion(v);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const poll = () => {
      // Skip ticks while the window is hidden (background tab / minimized):
      // the numbers are invisible anyway, so polling then is pure waste.
      if (document.hidden || polling) return;
      polling = true;
      ipc
        .appMetrics()
        .then((m) => {
          if (!cancelled) setMetrics(m);
        })
        .catch(() => { if (!cancelled) setMetrics(null); })
        .finally(() => { polling = false; });
    };
    void poll();
    const timer = setInterval(poll, METRICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useTauriEvent(() => listenScanProgress(setSync));

  const syncPct = sync && sync.total > 0 ? Math.round((sync.done / sync.total) * 100) : 0;
  const syncing = !!sync && !sync.finished;
  // Spin while the rescan runs, check when it reports finished (same feedback
  // as the git panel's refresh).
  const syncFeedback = useRunningFeedback(syncing);
  const triggerSync = useCallback(() => {
    void ipc.rescanSessions().catch(() => {});
  }, []);
  const iconButton =
    "flex size-5 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-secondary";

  return (
    <div
      className="flex h-7 shrink-0 items-center justify-end border-t border-separator-border bg-background-primary-default px-3 text-caption-1-medium text-text-tertiary select-none max-md:hidden"
    >
      {startItems.length > 0 && (
        <div className="me-auto flex min-w-0 items-center gap-3">
          {[...startItems].sort(compareByOrder).map((def, i) => {
            const pluginId = pluginIdFromRegistryKey(def.id);
            const Chip = def.component;
            return (
              <Fragment key={def.id}>
                {i > 0 && <span className="text-text-disabled">·</span>}
                <PluginBoundary pluginId={pluginId}>
                  <Chip />
                </PluginBoundary>
              </Fragment>
            );
          })}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={() => setShowDiagnostics(true)}
          aria-label={t("diagnostics.open")}
          className="flex cursor-pointer items-center gap-1 rounded transition-colors hover:bg-background-tertiary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus-ring"
          title={
            metrics
              ? t("statusbar.perfDetail", {
                  mb: formatMb(metrics.memoryBytes),
                  cpu: metrics.cpuPercent.toFixed(1),
                })
              : undefined
          }
        >
          <Activity className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <span className="whitespace-nowrap">
            {t("statusbar.performance")}
            {metrics ? ` ${formatMb(metrics.memoryBytes)} MB` : ""}
          </span>
        </button>

        <span className="text-text-disabled">·</span>

        {/* Zoom drives the native webview; browsers zoom natively. */}
        {!isWeb && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("statusbar.zoomOut")}
            title={t("statusbar.zoomOut")}
            className={iconButton}
            onClick={() => changeZoom(zoomPct - ZOOM_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("statusbar.resetZoom")}
            title={t("statusbar.resetZoom")}
            className="min-w-9 cursor-pointer rounded text-center transition-colors hover:text-text-secondary"
            onClick={() => changeZoom(100)}
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            aria-label={t("statusbar.zoomIn")}
            title={t("statusbar.zoomIn")}
            className={iconButton}
            onClick={() => changeZoom(zoomPct + ZOOM_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </span>
        )}

        <span className="text-text-disabled">·</span>

        <button
          type="button"
          aria-label={t("statusbar.syncNow")}
          title={t("statusbar.syncNow")}
          disabled={syncing}
          className={cx(iconButton, syncing && "cursor-default opacity-60")}
          onClick={triggerSync}
        >
          <ActionFeedbackIcon
            icon={RefreshCw}
            feedback={syncFeedback}
            spin
            iconClassName="size-3.5"
          />
        </button>

        {sync && (
          <>
            <span className="text-text-disabled">·</span>
            <span
              className={cx(
                "whitespace-nowrap",
                sync.finished ? "text-text-tertiary" : "text-notification-success-foreground",
              )}
            >
              {sync.finished
                ? t("statusbar.synced")
                : t("statusbar.syncing", { pct: syncPct, done: sync.done, total: sync.total })}
            </span>
          </>
        )}
        {/* Plugin status-bar chips (plan §4.2 #8), placed right-aligned after
         *  the sync status and before the version. Each chip renders in its
         *  own PluginBoundary so a render crash unmounts only that chip; the
         *  plugin owns the chip's look — the host provides placement and the
         *  row gap only. */}
        {[...endItems]
          // compareByOrder: undefined order sorts last, ties break by id.
          .sort(compareByOrder)
          .map((def) => {
            // Non-plugin ids (host/test registrations) pass through as their
            // own boundary id.
            const pluginId = pluginIdFromRegistryKey(def.id);
            const Chip = def.component;
            return (
              <Fragment key={def.id}>
                <span className="text-text-disabled">·</span>
                <PluginBoundary pluginId={pluginId}>
                  <Chip />
                </PluginBoundary>
              </Fragment>
            );
          })}
        {version && (
          <>
            <span className="text-text-disabled">·</span>
            <button
              type="button"
              aria-label={t("changelog.title")}
              title={t("commands.openReleaseNotes")}
              className="shrink-0 cursor-pointer rounded px-1 transition-colors hover:bg-background-tertiary-hover hover:text-text-secondary"
              // 版本号打开版本更新页签：先清掉其他中心面（同插件入口），再打开/
              // 聚焦更新说明页签（版本历史翻页入口已随弹窗下线，见
              // ReleaseNotesPane）。
              onClick={() => {
                dismissCenterSurfaces();
                useReleaseNotesTabStore.getState().openTab();
              }}
            >
              v{version}
            </button>
          </>
        )}
        <SelfUpdateStatusChip />
        {showDiagnostics && <PerformanceDiagnosticsDialog onClose={() => setShowDiagnostics(false)} />}
      </div>
    </div>
  );
}
