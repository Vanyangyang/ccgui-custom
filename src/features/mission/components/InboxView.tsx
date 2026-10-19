import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import Check from "lucide-react/dist/esm/icons/check";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Diamond from "lucide-react/dist/esm/icons/diamond";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { applyInboxAction } from "../runtime";
import { useMissionStore, type MissionInboxFilter } from "../store";
import type { MissionInboxItem, MissionRun, MissionTaskInstance } from "../types";
import { countRunUnits } from "../types";

/**
 * 收件箱：人工介入、失败与完成消息。
 * 已读不等于已处理——批准/反馈/重试才会推动任务；排除会明确计入例外。
 */
export function InboxView() {
  const { t } = useTranslation();
  const {
    inbox,
    runs,
    flows,
    inboxFilter,
    inboxSearch,
    selectedInboxId,
    setInboxFilter,
    setInboxSearch,
    selectInbox,
    markAllInboxRead,
    selectFlow,
    selectNode,
    setActiveView,
  } = useMissionStore(
    useShallow((s) => ({
      inbox: s.inbox,
      runs: s.runs,
      flows: s.flows,
      inboxFilter: s.inboxFilter,
      inboxSearch: s.inboxSearch,
      selectedInboxId: s.selectedInboxId,
      setInboxFilter: s.setInboxFilter,
      setInboxSearch: s.setInboxSearch,
      selectInbox: s.selectInbox,
      markAllInboxRead: s.markAllInboxRead,
      selectFlow: s.selectFlow,
      selectNode: s.selectNode,
      setActiveView: s.setActiveView,
    })),
  );
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const flowsById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow])), [flows]);
  const filtered = useMemo(() => {
    const search = inboxSearch.trim().toLowerCase();
    return inbox.filter((item) => {
      if (inboxFilter !== "all" && item.type !== inboxFilter) return false;
      if (!search) return true;
      const flowName = flowsById.get(item.flowId)?.name ?? "";
      return `${item.title} ${flowName}`.toLowerCase().includes(search);
    });
  }, [inbox, inboxFilter, inboxSearch, flowsById]);

  const selected =
    filtered.find((item) => item.id === selectedInboxId) ??
    inbox.find((item) => item.id === selectedInboxId) ??
    null;

  const contextOf = (item: MissionInboxItem): {
    run: MissionRun | null;
    task: MissionTaskInstance | null;
  } => {
    const run = runs[item.runId] ?? null;
    const task = item.taskId ? (run?.tasks.find((row) => row.id === item.taskId) ?? null) : null;
    return { run, task };
  };

  const actionable = (item: MissionInboxItem): boolean => {
    const { task } = contextOf(item);
    if (!task || item.resolved) return false;
    return (
      (item.type === "attention" && task.status === "waiting_human") ||
      (item.type === "failed" && task.status === "failed")
    );
  };

  const runAction = (item: MissionInboxItem, action: Parameters<typeof applyInboxAction>[1]) => {
    const result = applyInboxAction(item.id, action);
    if (!result.ok && result.error) {
      setFeedbackError(result.error);
      return;
    }
    setFeedbackFor(null);
    setFeedbackText("");
    setFeedbackError(null);
  };

  const locate = (item: MissionInboxItem) => {
    if (!item.runId) return;
    selectFlow(item.flowId, "run", item.runId);
    selectNode(item.nodeKey);
    setActiveView("studio");
  };

  const filters: Array<{ id: MissionInboxFilter; label: string }> = [
    { id: "all", label: t("mission.filterAll") },
    { id: "attention", label: t("mission.filterHuman") },
    { id: "failed", label: t("mission.filterFailed") },
    { id: "done", label: t("mission.filterDone") },
  ];

  const unread = inbox.filter((item) => !item.read).length;

  return (
    <div className="h-full overflow-auto bg-background-secondary-default/20 px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-caption-1-medium uppercase tracking-widest text-text-tertiary">
              {t("mission.inboxEyebrow")}
            </div>
            <h1 className="mt-2 text-title-2-medium text-text-primary">
              {t("mission.inboxTitle")}
            </h1>
            <p className="mt-1.5 text-body-2-regular text-text-tertiary">
              {t("mission.inboxSubtitle")}
            </p>
          </div>
          <Button size="small" variant="secondary" disabled={unread === 0} onClick={() => markAllInboxRead()}>
            {t("mission.readAll")}
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setInboxFilter(filter.id)}
              className={cx(
                "cursor-pointer rounded-md border px-2.5 py-1 text-caption-1-medium transition-colors",
                inboxFilter === filter.id
                  ? "border-status-blue-text/40 bg-status-blue-background/30 text-status-blue-text"
                  : "border-transparent text-text-tertiary hover:text-text-secondary",
              )}
            >
              {filter.label}
            </button>
          ))}
          <input
            value={inboxSearch}
            onChange={(event) => setInboxSearch(event.target.value)}
            placeholder={t("mission.inboxSearchPlaceholder")}
            aria-label={t("mission.inboxSearchPlaceholder")}
            className="ml-auto min-w-[180px] rounded-md border border-border-button-default bg-background-primary-default px-3 py-1.5 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-status-blue-text/60"
          />
        </div>

        <div className="mt-4 grid min-h-[390px] overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default lg:grid-cols-[minmax(260px,1fr)_380px]">
          <div className="max-h-[600px] overflow-auto border-b border-separator-border lg:border-b-0 lg:border-r">
            {filtered.length === 0 && (
              <div className="p-10 text-center text-body-2-regular text-text-tertiary">
                {t("mission.inboxEmpty")}
              </div>
            )}
            {filtered.map((item) => {
              const flow = flowsById.get(item.flowId);
              const icon =
                item.type === "attention" ? (
                  <Diamond className="size-3.5" aria-hidden />
                ) : item.type === "failed" ? (
                  <CircleAlert className="size-3.5" aria-hidden />
                ) : (
                  <Check className="size-3.5" aria-hidden />
                );
              return (
                <button
                  key={item.id}
                  type="button"
                  data-notice={item.id}
                  data-resolved={String(item.resolved)}
                  onClick={() => selectInbox(item.id)}
                  className={cx(
                    "flex w-full cursor-pointer items-start gap-3 border-b border-separator-border px-4 py-3 text-left transition-colors last:border-b-0",
                    selected?.id === item.id
                      ? "bg-status-blue-background/20"
                      : "hover:bg-background-secondary-hover/50",
                  )}
                >
                  <span
                    className={cx(
                      "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md",
                      item.type === "attention" && "bg-status-yellow-background/40 text-status-yellow-text",
                      item.type === "failed" && "bg-status-rose-background/40 text-status-rose-text",
                      item.type === "done" && "bg-status-green-background/40 text-status-green-text",
                    )}
                  >
                    {icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-2-medium text-text-primary">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-caption-1-regular text-text-tertiary">
                      {flow?.name ?? ""}
                      {item.resolved && item.type !== "done" ? " · ✓" : ""}
                    </span>
                  </span>
                  {!item.read && (
                    <span aria-label="unread" className="mt-2 size-1.5 shrink-0 rounded-full bg-status-blue-text" />
                  )}
                </button>
              );
            })}
          </div>

          <section className="max-h-[600px] overflow-auto p-5" aria-label={t("mission.inboxTitle")}>
            {!selected ? (
              <div className="whitespace-pre-line py-16 text-center text-body-2-regular leading-relaxed text-text-tertiary">
                {t("mission.inboxDetailEmpty")}
              </div>
            ) : (
              <NoticeDetail
                item={selected}
                run={contextOf(selected).run}
                task={contextOf(selected).task}
                actionable={actionable(selected)}
                feedbackOpen={feedbackFor === selected.id}
                feedbackText={feedbackText}
                feedbackError={feedbackError}
                onFeedbackText={setFeedbackText}
                onOpenFeedback={() => {
                  setFeedbackFor(selected.id);
                  setFeedbackText("");
                  setFeedbackError(null);
                }}
                onSubmitFeedback={() => {
                  const text = feedbackText.trim();
                  if (!text) {
                    setFeedbackError(t("mission.feedbackRequired"));
                    return;
                  }
                  runAction(selected, { kind: "feedback", text });
                }}
                onAction={(action) => runAction(selected, action)}
                onLocate={() => locate(selected)}
              />
            )}
          </section>
        </div>
        <p className="mt-4 text-caption-1-regular leading-relaxed text-text-tertiary">
          {t("mission.inboxNote")}
        </p>
      </div>
    </div>
  );
}

function NoticeDetail({
  item,
  run,
  task,
  actionable,
  feedbackOpen,
  feedbackText,
  feedbackError,
  onFeedbackText,
  onOpenFeedback,
  onSubmitFeedback,
  onAction,
  onLocate,
}: {
  item: MissionInboxItem;
  run: MissionRun | null;
  task: MissionTaskInstance | null;
  actionable: boolean;
  feedbackOpen: boolean;
  feedbackText: string;
  feedbackError: string | null;
  onFeedbackText: (value: string) => void;
  onOpenFeedback: () => void;
  onSubmitFeedback: () => void;
  onAction: (action: Parameters<typeof applyInboxAction>[1]) => void;
  onLocate: () => void;
}) {
  const { t } = useTranslation();
  const flowName = useMissionStore(
    (s) => s.flows.find((flow) => flow.id === item.flowId)?.name ?? "",
  );
  const counts = run ? countRunUnits(run) : null;
  const taskLine = task
    ? t("mission.noticeTaskLine", { item: task.itemLabel ?? task.title, attempt: task.attempt })
    : "";
  return (
    <div>
      <div className="text-caption-1-medium uppercase tracking-wide text-text-tertiary">
        {item.type === "attention"
          ? t("mission.eyebrowAttention")
          : item.type === "failed"
            ? t("mission.eyebrowFailed")
            : t("mission.eyebrowDone")}
      </div>
      <h2 className="mt-2 text-title-3-medium leading-snug text-text-primary">{item.title}</h2>
      <p className="mt-2 whitespace-pre-wrap text-body-2-regular leading-relaxed text-text-secondary">
        {item.body}
      </p>
      <div className="mt-4 whitespace-pre-wrap rounded-lg border border-separator-border bg-background-secondary-default/60 p-3 text-caption-1-regular leading-relaxed text-text-secondary">
        {t("mission.noticeMeta", {
          flow: flowName,
          runId: item.runId,
          version: run?.snapshot.version ?? 1,
          taskLine,
        })}
        {item.resolution ? `\n${t("mission.noticeResolution", { resolution: item.resolution })}` : ""}
      </div>
      {task && task.feedback.length > 0 && (
        <div className="mt-3 whitespace-pre-wrap text-caption-1-regular text-text-secondary">
          {t("mission.feedbackList", { text: task.feedback.join("\n") })}
        </div>
      )}
      {!task && item.type === "done" && counts && (
        <div className="mt-3 whitespace-pre-wrap rounded-lg border border-separator-border bg-background-secondary-default/60 p-3 text-caption-1-regular leading-relaxed text-text-secondary">
          {t("mission.resultBlock", {
            done: counts.done,
            excluded: counts.excluded,
            total: counts.total,
          })}
        </div>
      )}

      <NoticeActions
        item={item}
        actionable={actionable}
        feedbackOpen={feedbackOpen}
        feedbackText={feedbackText}
        feedbackError={feedbackError}
        onFeedbackText={onFeedbackText}
        onOpenFeedback={onOpenFeedback}
        onSubmitFeedback={onSubmitFeedback}
        onAction={onAction}
        onLocate={onLocate}
      />

      <p className="mt-4 text-caption-1-regular leading-relaxed text-text-tertiary">
        {t("mission.inboxDecisionNote")}
      </p>
    </div>
  );
}

/** Decision area: buttons for actionable notices, or the read-only reason
 *  the notice cannot be acted on; the feedback form appears once opened. */
function NoticeActions({
  item,
  actionable,
  feedbackOpen,
  feedbackText,
  feedbackError,
  onFeedbackText,
  onOpenFeedback,
  onSubmitFeedback,
  onAction,
  onLocate,
}: {
  item: MissionInboxItem;
  actionable: boolean;
  feedbackOpen: boolean;
  feedbackText: string;
  feedbackError: string | null;
  onFeedbackText: (value: string) => void;
  onOpenFeedback: () => void;
  onSubmitFeedback: () => void;
  onAction: (action: Parameters<typeof applyInboxAction>[1]) => void;
  onLocate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {actionable ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.type === "attention" ? (
            <>
              <Button size="small" onClick={() => onAction({ kind: "approve" })}>
                {t("mission.actionApprove")}
              </Button>
              {!feedbackOpen && (
                <Button size="small" variant="secondary" onClick={onOpenFeedback}>
                  {t("mission.actionFeedback")}
                </Button>
              )}
            </>
          ) : (
            <Button size="small" onClick={() => onAction({ kind: "retry" })}>
              {t("mission.actionRetry")}
            </Button>
          )}
          <Button size="small" variant="secondary" onClick={() => onAction({ kind: "exclude" })}>
            {t("mission.actionExclude")}
          </Button>
          <Button size="small" variant="ghost" onClick={onLocate}>
            {t("mission.actionLocate")}
          </Button>
        </div>
      ) : (
        item.type !== "done" && (
          <p className="mt-4 text-caption-1-regular text-text-tertiary">
            {item.resolved ? t("mission.alreadyResolved") : t("mission.staleTask")}
          </p>
        )
      )}

      {feedbackOpen && actionable && (
        <form
          className="mt-4 border-t border-separator-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitFeedback();
          }}
        >
          <label
            htmlFor="mission-inbox-feedback"
            className="block text-caption-1-medium text-text-secondary"
          >
            {t("mission.feedbackLabel")}
          </label>
          <textarea
            id="mission-inbox-feedback"
            value={feedbackText}
            maxLength={1200}
            rows={3}
            onChange={(event) => onFeedbackText(event.target.value)}
            placeholder={t("mission.feedbackPlaceholder")}
            className="mt-2 w-full rounded-md border border-border-button-default bg-background-primary-default px-2.5 py-2 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-status-blue-text/60"
          />
          <Button type="submit" size="small" className="mt-2">
            {t("mission.feedbackSubmit")}
          </Button>
          {feedbackError && (
            <p role="alert" className="mt-2 text-caption-1-regular text-status-rose-text">
              {feedbackError}
            </p>
          )}
        </form>
      )}
    </>
  );
}
