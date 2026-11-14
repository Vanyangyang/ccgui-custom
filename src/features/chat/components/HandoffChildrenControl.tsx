import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import type { SessionMeta } from "@/lib/ipc";
import { workspaceCatalogPathKey } from "@/lib/workspace-path";
import { cx } from "@/utils/cx";
import type { HandoffChildCandidate } from "../handoff-children";
import { useHandoffStore, type PendingHandoffSession } from "../session-cleanup";
import { useChatStore } from "../store";
import { relativeTime } from "../time";
import { parseInternalMessage } from "./internal-message";

const TRUNCATED_INTERNAL_HEADER_PREFIX = "[Message from CC GUI ";

function extractReadableTitle(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = parseInternalMessage(trimmed);
  const unwrapped = parsed ? parsed.text : trimmed;
  if (!parsed && unwrapped.startsWith(TRUNCATED_INTERNAL_HEADER_PREFIX)) return null;
  const firstLine = unwrapped.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine || null;
}

function cleanCandidateTitle(candidate: HandoffChildCandidate, sessions: readonly SessionMeta[]): string {
  const { branch } = candidate;
  if (branch.sessionId) {
    const matches = sessions.filter(
      (session) =>
        session.engine === branch.engine &&
        session.sessionId === branch.sessionId &&
        (!branch.workspacePath ||
          !session.workspacePath ||
          workspaceCatalogPathKey(session.workspacePath) === workspaceCatalogPathKey(branch.workspacePath)),
    );
    const meta = matches[0] ?? sessions.find((s) => s.engine === branch.engine && s.sessionId === branch.sessionId);
    const fromMeta = extractReadableTitle(meta?.customTitle) ?? extractReadableTitle(meta?.title);
    if (fromMeta) return fromMeta;
  }
  return extractReadableTitle(branch.title) ?? extractReadableTitle(branch.task) ?? branch.id;
}

export function HandoffChildrenControl({
  workspacePath,
  entry,
}: {
  workspacePath: string;
  entry: PendingHandoffSession;
}) {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const setSelectedChildIds = useHandoffStore((s) => s.setSelectedChildIds);
  const recompressSelectedChildren = useHandoffStore((s) => s.recompressSelectedChildren);

  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setExpanded(false);
    setQuery("");
  }, [entry.id]);

  const candidates = entry.childCandidates ?? [];
  const selectedIds = entry.selectedChildIds ?? [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const displayItems = useMemo(() => {
    const ordered = [...candidates].sort((a, b) => {
      if (a.relation !== b.relation) return a.relation === "descendant" ? -1 : 1;
      return (
        b.branch.updatedAt - a.branch.updatedAt ||
        (a.branch.id < b.branch.id ? -1 : a.branch.id > b.branch.id ? 1 : 0)
      );
    });
    return ordered.map((candidate) => ({
      candidate,
      title: cleanCandidateTitle(candidate, sessions),
      shortRef: candidate.branch.sessionId
        ? `${candidate.branch.engine}/${candidate.branch.sessionId.slice(0, 8)}`
        : candidate.branch.id.slice(0, 8),
      fullRef: candidate.branch.sessionId
        ? `${candidate.branch.engine}/${candidate.branch.sessionId}`
        : candidate.branch.id,
    }));
  }, [candidates, sessions]);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return displayItems;
    return displayItems.filter(
      ({ candidate, title, fullRef }) =>
        title.toLowerCase().includes(keyword) ||
        fullRef.toLowerCase().includes(keyword) ||
        candidate.branch.task.toLowerCase().includes(keyword),
    );
  }, [displayItems, query]);

  const hasCandidates = candidates.length > 0;
  const shouldRender =
    entry.childrenStatus === "loading" ||
    entry.childrenStatus === "error" ||
    hasCandidates ||
    Boolean(entry.children?.total);

  if (!shouldRender) return null;

  if (entry.childrenStatus === "loading") {
    return (
      <div data-testid="handoff-children-status" role="status" className="text-caption-1-regular text-text-tertiary">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          {t("chat.handoffChildrenLoading")}
        </span>
      </div>
    );
  }

  if (entry.childrenStatus === "error") {
    return (
      <div data-testid="handoff-children-status" role="status" className="text-caption-1-regular text-text-tertiary">
        <span title={entry.childrenError}>{t("chat.handoffChildrenFailed")}</span>
      </div>
    );
  }

  const allIds = candidates.map((c) => c.branch.id);
  const allSelected = candidates.length > 0 && selectedSet.size === candidates.length;
  const completedIds = candidates
    .filter((c) => c.branch.state === "completed")
    .map((c) => c.branch.id);
  const attentionIds = candidates
    .filter((c) => c.branch.state !== "completed")
    .map((c) => c.branch.id);
  const isExactSelection = (ids: readonly string[]) =>
    ids.length > 0 && selectedSet.size === ids.length && ids.every((id) => selectedSet.has(id));
  const completedSelected = isExactSelection(completedIds);
  const attentionSelected = isExactSelection(attentionIds);

  const toggleOne = (branchId: string, checked: boolean) => {
    if (entry.sending) return;
    if (checked) {
      setSelectedChildIds(workspacePath, [...selectedIds, branchId]);
    } else {
      setSelectedChildIds(workspacePath, selectedIds.filter((id) => id !== branchId));
    }
  };

  const needsRecompress =
    entry.mode === "grok" &&
    entry.childrenSelectionModified === true &&
    entry.grokStatus !== "running";

  return (
    <div data-testid="handoff-children-status" role="status" className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {hasCandidates && (
            <>
              <span className="shrink-0 text-caption-1-medium text-text-secondary">
                {t("chat.handoffChildrenLabel")}
              </span>
              <button
                type="button"
                data-testid="handoff-children-toggle"
                aria-expanded={expanded}
                disabled={entry.sending === true}
                onClick={() => setExpanded((prev) => !prev)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-0.5 text-caption-1-medium text-text-primary transition-colors duration-150 hover:bg-background-secondary-hover disabled:cursor-wait disabled:opacity-60"
              >
                <ChevronRight
                  className={cx("size-3.5 shrink-0 text-text-tertiary transition-transform duration-150", expanded && "rotate-90")}
                  aria-hidden
                />
                <span>{t("chat.handoffChildrenSelectBtn")}</span>
                <span className="rounded-sm bg-background-tertiary-default px-1.5 py-px font-mono text-caption-2-medium text-text-secondary">
                  {t("chat.handoffChildrenSelectedCount", {
                    selected: selectedSet.size,
                    total: candidates.length,
                  })}
                </span>
              </button>
            </>
          )}

          <span className="text-caption-1-regular text-text-tertiary">
            {entry.childrenApplied === false ? (
              t("chat.handoffChildrenNotApplied")
            ) : selectedSet.size === 0 && hasCandidates ? (
              t("chat.handoffChildrenNoneSelected", { total: candidates.length })
            ) : (
              <>
                <span>
                  {t("chat.handoffChildrenLoaded", {
                    count: entry.children?.included ?? 0,
                    attention: entry.children?.attention ?? 0,
                  })}
                </span>
                {!!entry.children?.omitted && (
                  <span className="ml-2">
                    {t("chat.handoffChildrenOmitted", {
                      count: entry.children.omitted,
                      attention: entry.children.omittedAttention,
                    })}
                  </span>
                )}
              </>
            )}
          </span>
        </div>

        {needsRecompress && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption-1-regular text-text-warning-primary">
              {t("chat.handoffChildrenSelectionStale")}
            </span>
            <button
              type="button"
              data-testid="handoff-children-compress-btn"
              disabled={entry.sending === true}
              onClick={() => recompressSelectedChildren(workspacePath)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-0.5 text-caption-1-medium text-text-primary transition-colors duration-150 hover:bg-background-secondary-hover disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className="size-3" aria-hidden />
              <span>
                {selectedSet.size > 0
                  ? t("chat.handoffChildrenCompressSelected")
                  : t("chat.handoffGrokRetry")}
              </span>
            </button>
          </div>
        )}
      </div>

      {expanded && hasCandidates && (
        <div
          data-testid="handoff-children-picker"
          className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default p-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                data-testid="handoff-children-select-all"
                aria-pressed={allSelected}
                disabled={entry.sending === true}
                onClick={() => setSelectedChildIds(workspacePath, allSelected ? [] : allIds)}
                className={cx(
                  "cursor-pointer rounded-md px-2 py-0.5 text-caption-2-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50",
                  allSelected
                    ? "bg-background-secondary-hover text-text-primary ring-1 ring-border-button-default"
                    : "bg-background-tertiary-default text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
                )}
              >
                {t(
                  allSelected ? "chat.handoffChildrenDeselectAll" : "chat.handoffChildrenSelectAll",
                  { count: candidates.length },
                )}
              </button>
              {completedIds.length > 0 && completedIds.length < candidates.length && (
                <button
                  type="button"
                  data-testid="handoff-children-select-completed"
                  aria-pressed={completedSelected}
                  disabled={entry.sending === true}
                  onClick={() => setSelectedChildIds(workspacePath, completedSelected ? [] : completedIds)}
                  className={cx(
                    "cursor-pointer rounded-md px-2 py-0.5 text-caption-2-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50",
                    completedSelected
                      ? "bg-background-secondary-hover text-text-primary ring-1 ring-border-button-default"
                      : "bg-background-tertiary-default text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
                  )}
                >
                  {t("chat.handoffChildrenSelectCompleted", { count: completedIds.length })}
                </button>
              )}
              {attentionIds.length > 0 && attentionIds.length < candidates.length && (
                <button
                  type="button"
                  data-testid="handoff-children-select-attention"
                  aria-pressed={attentionSelected}
                  disabled={entry.sending === true}
                  onClick={() => setSelectedChildIds(workspacePath, attentionSelected ? [] : attentionIds)}
                  className={cx(
                    "cursor-pointer rounded-md px-2 py-0.5 text-caption-2-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50",
                    attentionSelected
                      ? "bg-background-secondary-hover text-text-primary ring-1 ring-border-button-default"
                      : "bg-background-tertiary-default text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
                  )}
                >
                  {t("chat.handoffChildrenSelectAttention", { count: attentionIds.length })}
                </button>
              )}
              <button
                type="button"
                data-testid="handoff-children-clear"
                disabled={entry.sending === true || selectedSet.size === 0}
                onClick={() => setSelectedChildIds(workspacePath, [])}
                className="cursor-pointer rounded-md bg-background-tertiary-default px-2 py-0.5 text-caption-2-medium text-text-secondary transition-colors duration-150 hover:bg-background-secondary-hover hover:text-text-primary disabled:cursor-default disabled:opacity-50"
              >
                {t("chat.handoffChildrenClearSelection")}
              </button>
            </div>

            {candidates.length >= 5 && (
              <div className="relative flex min-w-44 flex-1 items-center sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2 size-3 text-text-tertiary" aria-hidden />
                <input
                  type="search"
                  data-testid="handoff-children-search"
                  value={query}
                  disabled={entry.sending === true}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("chat.handoffChildrenSearchPlaceholder")}
                  aria-label={t("chat.handoffChildrenSearchPlaceholder")}
                  className="w-full rounded-md border border-border-button-default bg-background-secondary-default py-0.5 pr-2 pl-6 text-caption-1-regular text-text-primary placeholder:text-text-tertiary focus:outline-none"
                />
              </div>
            )}
          </div>

          <div className="max-h-52 divide-y divide-border-secondary/60 overflow-y-auto rounded-md border border-border-secondary/60">
            {filteredItems.length === 0 ? (
              <p className="px-2.5 py-2 text-caption-1-regular text-text-tertiary">
                {t("chat.handoffChildrenNoMatch")}
              </p>
            ) : (
              filteredItems.map(({ candidate, title, shortRef, fullRef }) => {
                const { branch, relation } = candidate;
                const checked = selectedSet.has(branch.id);
                const stateTone =
                  branch.state === "completed"
                    ? "text-notification-success-foreground"
                    : branch.state === "failed" || branch.state === "stopped"
                      ? "text-text-warning-primary"
                      : "text-text-tertiary";
                const timeText = branch.updatedAt > 0 ? relativeTime(branch.updatedAt) : "";
                return (
                  <label
                    key={branch.id}
                    data-testid={`handoff-child-item-${branch.id}`}
                    className={cx(
                      "flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1.5 text-caption-1-regular transition-colors duration-150 hover:bg-background-secondary-hover",
                      checked && "bg-background-secondary-default/60",
                      entry.sending && "cursor-wait opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={entry.sending === true}
                      onChange={(e) => toggleOne(branch.id, e.target.checked)}
                      className="size-3.5 shrink-0 cursor-pointer rounded border-border-button-default accent-background-brand-solid-default"
                    />
                    <EngineIcon engine={branch.engine} size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-caption-1-medium text-text-primary" title={title}>
                      {title}
                    </span>
                    {relation === "sibling" && (
                      <span className="shrink-0 rounded-sm bg-background-tertiary-default px-1.5 py-px text-caption-2-medium text-text-tertiary">
                        {t("chat.handoffChildrenSiblingBadge")}
                      </span>
                    )}
                    <span className={cx("shrink-0 text-caption-2-medium", stateTone)}>
                      {t(`leader.state.${branch.state}`)}
                    </span>
                    <span className="shrink-0 font-mono text-caption-2-medium text-text-tertiary" title={fullRef}>
                      {shortRef}
                    </span>
                    {timeText && (
                      <span className="shrink-0 text-caption-2-regular text-text-tertiary">
                        {timeText}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>

          <p className="text-caption-2-regular text-text-tertiary">
            {t("chat.handoffChildrenSelectionHint")}
          </p>
        </div>
      )}
    </div>
  );
}
