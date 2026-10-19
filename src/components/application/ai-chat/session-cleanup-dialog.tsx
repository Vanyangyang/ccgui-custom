"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import Archive from "lucide-react/dist/esm/icons/archive";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore";
import X from "lucide-react/dist/esm/icons/x";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { useLeaderStore, manageLeader } from "@/features/leader/store";
import { relativeTime } from "@/features/chat/time";
import { getPromptCacheHeatRatio, promptCacheForEngine } from "@/features/chat/prompt-cache";
import { usePromptCacheHeat } from "@/features/chat/use-prompt-cache";
import { CacheHeatHoverBadge } from "@/components/application/ai-chat/repo-tree";
import {
  classifySessionForCleanup,
  type SessionCleanupCategory,
  type SessionCleanupItem,
  type SessionCleanupReason,
} from "@/features/chat/session-cleanup";
import { ipc, type AppCacheSummary, type SessionMeta } from "@/lib/ipc";
import { cx } from "@/utils/cx";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type FilterTab = "all" | "recommend" | "attention";

function CacheTimeBadge({ session, label }: { session: SessionMeta; label: string }) {
  const cache = promptCacheForEngine(session.engine, session.promptCache);
  const heat = usePromptCacheHeat(cache);
  const ratio = getPromptCacheHeatRatio(cache, session.updatedAt, false);
  return (
    <CacheHeatHoverBadge
      engine={session.engine}
      time={label}
      cache={cache}
      cacheHeat={heat}
      heatRatio={ratio}
      updatedAt={session.updatedAt}
    />
  );
}

const REASON_I18N_KEY: Record<SessionCleanupReason, string> = {
  settled_idle: "chat.cleanupReasonSettledIdle",
  settled_recent: "chat.cleanupReasonSettledRecent",
  running: "chat.cleanupReasonRunning",
  awaiting_confirm: "chat.cleanupReasonAwaitingConfirm",
  last_error: "chat.cleanupReasonLastError",
  unsent_draft: "chat.cleanupReasonUnsentDraft",
  unseen: "chat.cleanupReasonUnseen",
  pinned: "chat.cleanupReasonPinned",
  leader_group: "chat.cleanupReasonLeaderGroup",
};

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function SessionCleanupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { sessions, workspaces, workspaceAliases, archivedWorkspaces, bySession, streamingByKey, drafts, unseen } =
    useChatStore(
      useShallow((s) => ({
        sessions: s.sessions,
        workspaces: s.workspaces,
        workspaceAliases: s.workspaceAliases,
        archivedWorkspaces: s.archivedWorkspaces,
        bySession: s.bySession,
        streamingByKey: s.streamingByKey,
        drafts: s.drafts,
        unseen: s.unseen,
      })),
    );
  const archiveSession = useChatStore((s) => s.archiveSession);
  const restoreSession = useChatStore((s) => s.restoreSession);
  const leaderSnapshot = useLeaderStore((s) => s.snapshot);

  const [tab, setTab] = useState<FilterTab>("all");
  const [busy, setBusy] = useState(false);
  const [lastArchived, setLastArchived] = useState<{
    sessions: SessionMeta[];
    skipped: number;
  } | null>(null);

  const workspaceLabelByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workspaces) {
      map.set(w.path, workspaceAliases[w.id]?.trim() || w.name);
    }
    return map;
  }, [workspaces, workspaceAliases]);

  const visibleWorkspacePaths = useMemo(() => {
    const archivedSet = new Set(archivedWorkspaces);
    return new Set(workspaces.filter((w) => !archivedSet.has(w.id)).map((w) => w.path));
  }, [workspaces, archivedWorkspaces]);

  const items = useMemo<SessionCleanupItem[]>(() => {
    const now = Date.now();
    const visible = sessions
      .filter((s) => visibleWorkspacePaths.size === 0 || visibleWorkspacePaths.has(s.workspacePath))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return visible.map((session) => {
      const fullKey = sessionKey(session.engine, session.sessionId, session.workspacePath);
      const shortKey = `${session.engine}/${session.sessionId}`;
      return classifySessionForCleanup({
        session,
        state: bySession[fullKey] ?? bySession[shortKey],
        streaming: Boolean(streamingByKey[fullKey] || streamingByKey[shortKey]),
        unseen: Boolean(unseen[fullKey] || unseen[shortKey]),
        draftText: drafts[fullKey] ?? drafts[shortKey],
        leaderSnapshot,
        now,
      });
    });
  }, [sessions, visibleWorkspacePaths, bySession, streamingByKey, unseen, drafts, leaderSnapshot]);

  // Selection state initialized lazily from defaultSelected recommendations.
  const [selectedOverrides, setSelectedOverrides] = useState<Record<string, boolean>>({});

  const isSelected = useCallback(
    (item: SessionCleanupItem) => {
      if (!item.selectable) return false;
      return selectedOverrides[item.key] ?? item.defaultSelected;
    },
    [selectedOverrides],
  );

  const toggleItem = useCallback((item: SessionCleanupItem) => {
    if (!item.selectable) return;
    setSelectedOverrides((prev) => {
      const current = prev[item.key] ?? item.defaultSelected;
      return { ...prev, [item.key]: !current };
    });
  }, []);

  const selectRecommended = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const item of items) {
      if (!item.selectable) continue;
      next[item.key] = item.defaultSelected;
    }
    setSelectedOverrides(next);
  }, [items]);

  const selectAllSettled = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const item of items) {
      if (!item.selectable) continue;
      next[item.key] = item.category === "recommend";
    }
    setSelectedOverrides(next);
  }, [items]);

  const clearSelection = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const item of items) {
      if (!item.selectable) continue;
      next[item.key] = false;
    }
    setSelectedOverrides(next);
  }, [items]);

  const selectedItems = useMemo(
    () => items.filter((item) => isSelected(item)),
    [items, isSelected],
  );

  const filteredItems = useMemo(() => {
    if (tab === "recommend") return items.filter((item) => item.category === "recommend");
    if (tab === "attention") return items.filter((item) => item.category !== "recommend");
    return items;
  }, [items, tab]);

  const handleArchiveSelected = useCallback(async () => {
    if (busy || selectedItems.length === 0) return;
    setBusy(true);
    const archived: SessionMeta[] = [];
    let skipped = 0;
    try {
      const latestStore = useChatStore.getState();
      const latestLeader = useLeaderStore.getState().snapshot;
      for (const item of selectedItems) {
        const fullKey = sessionKey(item.session.engine, item.session.sessionId, item.session.workspacePath);
        const shortKey = `${item.session.engine}/${item.session.sessionId}`;
        const fresh = classifySessionForCleanup({
          session: item.session,
          state: latestStore.bySession[fullKey] ?? latestStore.bySession[shortKey],
          streaming: Boolean(latestStore.streamingByKey[fullKey] || latestStore.streamingByKey[shortKey]),
          unseen: Boolean(latestStore.unseen[fullKey] || latestStore.unseen[shortKey]),
          draftText: latestStore.drafts[fullKey] ?? latestStore.drafts[shortKey],
          leaderSnapshot: latestLeader,
        });
        if (!fresh.selectable) {
          skipped++;
          continue;
        }
        await archiveSession(item.session);
        if (useChatStore.getState().archivedSessionKeys[fullKey] || useChatStore.getState().archivedSessionKeys[shortKey]) {
          archived.push(item.session);
        } else {
          skipped++;
        }
      }
      if (archived.length > 0) {
        setLastArchived({ sessions: archived, skipped });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, selectedItems, archiveSession]);

  const handleUndo = useCallback(async () => {
    if (busy || !lastArchived || lastArchived.sessions.length === 0) return;
    setBusy(true);
    try {
      for (const session of lastArchived.sessions) {
        await restoreSession(session);
      }
      setLastArchived(null);
    } finally {
      setBusy(false);
    }
  }, [busy, lastArchived, restoreSession]);

  const [cacheSummary, setCacheSummary] = useState<AppCacheSummary | null>(null);
  const [pruningCache, setPruningCache] = useState(false);
  const [lastPrunedBytes, setLastPrunedBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLastPrunedBytes(null);
    if (typeof ipc.inspectAppCache === "function") {
      void ipc
        .inspectAppCache()
        .then((summary) => {
          if (!cancelled) setCacheSummary(summary);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handlePruneCache = useCallback(async () => {
    if (pruningCache || typeof ipc.pruneAppCache !== "function") return;
    setPruningCache(true);
    try {
      const result = await ipc.pruneAppCache();
      setCacheSummary(result.remaining);
      setLastPrunedBytes(result.freedBytes);
    } catch {
      // ignore
    } finally {
      setPruningCache(false);
    }
  }, [pruningCache]);

  if (!open) return null;

  const recommendCount = items.filter((item) => item.category === "recommend").length;
  const attentionCount = items.filter((item) => item.category !== "recommend").length;
  const reclaimableBytes = cacheSummary?.totalReclaimableBytes ?? 0;

  return (
    <ModalShell
      onClose={onClose}
      label={t("chat.cleanupTitle")}
      className="flex max-h-[calc(100vh-48px)] w-[580px] max-w-[calc(100vw-32px)] flex-col p-5"
      dialogClassName="flex min-h-0 flex-1 flex-col gap-3"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-title-3-medium text-text-primary">{t("chat.cleanupTitle")}</h3>
          <p className="text-caption-1-regular text-text-secondary">{t("chat.cleanupDesc")}</p>
        </div>
        <button
          type="button"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={onClose}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* Undo banner after batch archive */}
      {lastArchived && (
        <div
          role="status"
          data-testid="cleanup-undo-banner"
          className="flex items-center justify-between gap-3 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary"
        >
          <span>
            {lastArchived.skipped > 0
              ? t("chat.cleanupArchivedWithSkipped", {
                  count: lastArchived.sessions.length,
                  skipped: lastArchived.skipped,
                })
              : t("chat.cleanupArchivedDone", { count: lastArchived.sessions.length })}
          </span>
          <Button
            size="xs"
            variant="secondary"
            leadingIcon={ArchiveRestore}
            disabled={busy}
            onClick={() => void handleUndo()}
          >
            {t("chat.cleanupUndo")}
          </Button>
        </div>
      )}

      {/* Filter tabs + quick selection buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-separator-border pb-2">
        <div className="flex items-center gap-1" role="tablist">
          {(
            [
              { id: "all" as const, label: t("chat.cleanupTabAll", { count: items.length }) },
              { id: "recommend" as const, label: t("chat.cleanupTabRecommend", { count: recommendCount }) },
              { id: "attention" as const, label: t("chat.cleanupTabProtected", { count: attentionCount }) },
            ]
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cx(
                "cursor-pointer rounded-lg px-2.5 py-1 text-caption-1-medium transition-colors duration-150",
                tab === entry.id
                  ? "bg-background-secondary-hover text-text-primary"
                  : "text-text-tertiary hover:bg-background-secondary-default hover:text-text-secondary",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={selectRecommended}
            className="cursor-pointer rounded-md px-2 py-1 text-caption-2-medium text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
          >
            {t("chat.cleanupSelectIdle")}
          </button>
          <button
            type="button"
            onClick={selectAllSettled}
            className="cursor-pointer rounded-md px-2 py-1 text-caption-2-medium text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary"
          >
            {t("chat.cleanupSelectAllSettled")}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="cursor-pointer rounded-md px-2 py-1 text-caption-2-medium text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary"
          >
            {t("chat.cleanupSelectNone")}
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
        {filteredItems.length === 0 ? (
          <div className="py-8 text-center text-body-2-regular text-text-tertiary">
            {t("chat.cleanupEmpty")}
          </div>
        ) : (
          filteredItems.map((item) => {
            const checked = isSelected(item);
            const title =
              item.session.customTitle || item.session.title || item.session.sessionId.slice(0, 8);
            const wsName =
              workspaceLabelByPath.get(item.session.workspacePath) ||
              pathBaseName(item.session.workspacePath);
            const timeLabel = relativeTime(item.session.updatedAt);
            const categoryTone: Record<SessionCleanupCategory, string> = {
              recommend: "bg-background-tertiary-default text-text-secondary",
              attention: "bg-background-tertiary-warning text-text-warning-primary",
              protected: "bg-background-tertiary-default text-text-tertiary",
            };
            return (
              <div
                key={item.key}
                data-testid="cleanup-session-row"
                data-cleanup-reason={item.reason}
                onClick={() => toggleItem(item)}
                className={cx(
                  "flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors duration-150",
                  item.selectable ? "cursor-pointer" : "cursor-default opacity-75",
                  checked
                    ? "border-border-button-active bg-background-secondary-hover"
                    : "border-transparent hover:bg-background-secondary-default",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!item.selectable || busy}
                  onChange={() => toggleItem(item)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={title}
                  className="size-3.5 shrink-0 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
                />
                <EngineIcon
                  engine={item.session.engine}
                  size={14}
                  className="shrink-0 text-foreground-icon-secondary"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-primary" title={title}>
                      {title}
                    </span>
                    <span
                      className={cx(
                        "shrink-0 rounded px-1.5 py-px text-caption-2-medium whitespace-nowrap",
                        categoryTone[item.category],
                      )}
                    >
                      {t(REASON_I18N_KEY[item.reason])}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-caption-2-regular text-text-tertiary">
                    <span className="truncate">{wsName}</span>
                    {timeLabel && (
                      <>
                        <span>·</span>
                        <CacheTimeBadge session={item.session} label={timeLabel} />
                      </>
                    )}
                    {item.reason === "leader_group" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose();
                          manageLeader({
                            engine: item.session.engine,
                            sessionId: item.session.sessionId,
                            workspacePath: item.session.workspacePath,
                          });
                        }}
                        className="ml-auto cursor-pointer text-caption-2-medium text-text-secondary underline hover:text-text-primary"
                      >
                        {t("leader.manage")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {(reclaimableBytes > 0 || (lastPrunedBytes !== null && lastPrunedBytes > 0)) && (
        <div
          data-testid="cleanup-app-cache-bar"
          className="flex items-center justify-between gap-3 rounded-xl border border-separator-border bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary"
        >
          <span className="min-w-0 flex-1 truncate">
            {lastPrunedBytes !== null && lastPrunedBytes > 0 && reclaimableBytes === 0
              ? t("chat.cleanupCachePrunedDone", { size: formatBytes(lastPrunedBytes) })
              : t("chat.cleanupCacheReclaimable", { size: formatBytes(reclaimableBytes) })}
          </span>
          {reclaimableBytes > 0 && (
            <Button
              size="xs"
              variant="secondary"
              data-testid="cleanup-prune-cache-btn"
              disabled={pruningCache || busy}
              onClick={() => void handlePruneCache()}
            >
              {pruningCache ? t("chat.cleanupCachePruning") : t("chat.cleanupCachePruneBtn")}
            </Button>
          )}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-3 border-t border-separator-border pt-3">
        <span className="text-caption-1-regular text-text-tertiary">
          {t("chat.cleanupSelectedCount", { count: selectedItems.length })}
        </span>
        <div className="flex items-center gap-2">
          <Button size="small" variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            size="small"
            data-testid="cleanup-archive-selected-btn"
            leadingIcon={Archive}
            disabled={busy || selectedItems.length === 0}
            onClick={() => void handleArchiveSelected()}
          >
            {t("chat.cleanupArchiveSelected", { count: selectedItems.length })}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
