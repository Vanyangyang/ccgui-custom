import { useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Dialog, DialogTrigger, Popover, Pressable } from "react-aria-components";
import { useShallow } from "zustand/react/shallow";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Clock from "lucide-react/dist/esm/icons/clock";
import Check from "lucide-react/dist/esm/icons/check";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import { cx } from "@/utils/cx";
import { useChatStore } from "../store";
import { CrossSessionCostApproval } from "./CrossSessionCostApproval";
import {
  crossSessionParticipantKey,
  crossSessionRecordMatchesParticipant,
  isCrossSessionActiveStatus,
  isCrossSessionRecordUnread,
  useCrossSessionActivityStore,
  type CrossSessionCommunicationRecord,
  type CrossSessionParticipant,
} from "../cross-session";
import { sameLeaderWorkspace } from "@/features/leader/workspace-path";

function resolveParticipantLabel(
  participant: CrossSessionParticipant,
  sessions: ReturnType<typeof useChatStore.getState>["sessions"],
): string {
  const match = sessions.find((s) => s.engine === participant.engine &&
    s.sessionId === participant.sessionId && sameLeaderWorkspace(s.workspacePath, participant.workspacePath));
  const title = match?.customTitle || match?.title || participant.title;
  if (title?.trim()) return title.trim();
  return `${CLI_DISPLAY_NAMES[participant.engine] ?? participant.engine} · ${participant.sessionId.slice(0, 8)}`;
}

function needsAttention(record: CrossSessionCommunicationRecord, participant?: CrossSessionParticipant) {
  return isCrossSessionActiveStatus(record.status) || isCrossSessionRecordUnread(record, participant);
}

function threadParticipant(threadId?: string, workspacePath?: string, leaderBranch?: { id: string; engine: string; sessionId: string | null; workspacePath: string; title?: string }): CrossSessionParticipant | undefined {
  if (leaderBranch) {
    return {
      engine: leaderBranch.engine,
      sessionId: leaderBranch.sessionId ?? `leader-branch:${leaderBranch.id}`,
      workspacePath: workspacePath ?? leaderBranch.workspacePath,
      title: leaderBranch.title,
    };
  }
  const separator = threadId?.indexOf("/") ?? -1;
  if (!threadId || separator <= 0 || separator === threadId.length - 1 || !workspacePath) return undefined;
  return { engine: threadId.slice(0, separator), sessionId: threadId.slice(separator + 1), workspacePath };
}

// Transient emphasis only; never changes selection, disclosure or read state.
const useCommsEmphasis = create<{ owner?: string; participant?: CrossSessionParticipant }>(() => ({}));

export function useCrossSessionThreadActivity(
  threadId?: string,
  workspacePath?: string,
  leaderBranch?: { id: string; engine: string; sessionId: string | null; workspacePath: string; title?: string },
) {
  const { t } = useTranslation();
  const participant = threadParticipant(threadId, workspacePath, leaderBranch);
  const records = useCrossSessionActivityStore(useShallow((state) => participant
    ? state.records.filter((record) => crossSessionRecordMatchesParticipant(record, participant)) : []));
  const emphasized = useCommsEmphasis((state) => state.participant);
  const active = records.find((record) => record.status === "awaiting_cost_approval") ??
    records.find((record) => isCrossSessionActiveStatus(record.status));
  const outgoing = !!active && !!participant && crossSessionParticipantKey(active.sender) === crossSessionParticipantKey(participant);
  const other = active ? outgoing ? active.target : active.sender : undefined;
  const title = useChatStore((state) => other ? resolveParticipantLabel(other, state.sessions) : "");
  const isSubtask = active?.kind === "subtask";
  const summary = active ? t(active.status === "awaiting_cost_approval" ? "crossSession.rowAwaitingCostApproval" :
    active.status === "awaiting_permission" ? "crossSession.rowAwaitingPermission" :
    outgoing ? (isSubtask ? "crossSession.rowDelegating" : "crossSession.rowAsking") :
    active.status === "executing" ? (isSubtask ? "crossSession.rowSubtaskRunning" : "crossSession.rowReplying") :
    (isSubtask ? "crossSession.rowSubtaskStarting" : "crossSession.rowReceiving"), { title }) : undefined;
  const related = !!participant && !!emphasized && crossSessionParticipantKey(participant) !== crossSessionParticipantKey(emphasized) &&
    records.some((record) => crossSessionRecordMatchesParticipant(record, emphasized) && needsAttention(record, emphasized));
  return { active: !!active, summary, related };
}

function StatusIcon({ status }: { status: CrossSessionCommunicationRecord["status"] }) {
  if (status === "failed" || status === "unknown" || status === "awaiting_permission" || status === "awaiting_cost_approval") {
    return <CircleAlert className={cx("size-3 shrink-0", status === "failed" ? "text-notification-error" : "text-text-warning-primary")} aria-hidden />;
  }
  if (status === "executing") return <span className="sidebar-thread-status sidebar-thread-status-processing" aria-hidden />;
  if (status === "completed") return <Check className="size-3 shrink-0 text-notification-success-foreground" aria-hidden />;
  return <Clock className="size-3 shrink-0 text-text-tertiary" aria-hidden />;
}

/** One unobtrusive overview entry; incoming activity never opens it. */
export function CrossSessionCommsToggleButton() {
  return <CommsPopover />;
}

/** Shared by workspace, recent, worktree and nested real-session rows. */
export function CrossSessionThreadIndicator({
  threadId,
  workspacePath,
  leaderBranch,
}: {
  threadId: string;
  workspacePath?: string;
  leaderBranch?: { id: string; engine: string; sessionId: string | null; workspacePath: string; title?: string };
}) {
  const participant = threadParticipant(threadId, workspacePath, leaderBranch);
  return participant ? <CommsPopover participant={participant} /> : null;
}

function CommsPopover({ participant }: { participant?: CrossSessionParticipant }) {
  const { t } = useTranslation();
  // Only matching records update a row; streaming in other conversations does
  // not invalidate every sidebar row or the chat's regular status indicator.
  const records = useCrossSessionActivityStore(useShallow((state) => participant
    ? state.records.filter((record) => crossSessionRecordMatchesParticipant(record, participant))
    : state.records));
  const popover = usePopoverState();
  const emphasisOwner = useId();
  const hovered = useRef(false);
  const emphasize = () => participant && useCommsEmphasis.setState({ owner: emphasisOwner, participant });
  const clearEmphasis = () => {
    if (useCommsEmphasis.getState().owner === emphasisOwner) useCommsEmphasis.setState({ owner: undefined, participant: undefined });
  };
  const rowBodyRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const attention = records.filter((record) => needsAttention(record, participant));
  const participantKey = participant ? crossSessionParticipantKey(participant) : undefined;
  useEffect(() => {
    if (!attention.length) clearEmphasis();
  }, [attention.length, emphasisOwner]);
  useEffect(() => clearEmphasis, [participantKey, emphasisOwner]);
  const activeCount = attention.filter((record) => isCrossSessionActiveStatus(record.status)).length;
  const unreadCount = attention.length - activeCount;
  // Prioritize something requiring intervention, then active work, then replies.
  const primary = attention.find((r) => r.status === "awaiting_cost_approval") ??
    attention.find((r) => ["failed", "awaiting_permission", "unknown"].includes(r.status)) ??
    attention.find((r) => isCrossSessionActiveStatus(r.status)) ?? attention[0];
  let summary = activeCount ? t("crossSession.activeBadge", { count: activeCount }) :
    unreadCount ? t("crossSession.unreadBadge", { count: unreadCount }) : t("crossSession.title");
  if (participant && primary) {
    const outgoing = crossSessionParticipantKey(primary.sender) === crossSessionParticipantKey(participant);
    const other = resolveParticipantLabel(outgoing ? primary.target : primary.sender, useChatStore.getState().sessions);
    const isSubtask = primary.kind === "subtask";
    summary = `${t(outgoing ? (isSubtask ? "crossSession.subtaskOutgoing" : "crossSession.outgoing") : (isSubtask ? "crossSession.subtaskIncoming" : "crossSession.incoming"), { title: other })} · ${t(`crossSession.status.${primary.status}`)}`;
    if (attention.length > 1) summary += ` · ${t("crossSession.recordCount", { count: attention.length })}`;
  }
  const label = participant ? t("crossSession.showDetails", { summary }) :
    `${t("crossSession.togglePanel")}${attention.length ? ` · ${summary}` : ""}`;

  useEffect(() => {
    // A reviewed terminal indicator disappears when its popover closes. Return
    // keyboard focus to the row only if dismissal did not focus another control.
    if (wasOpen.current && !popover.isOpen && participant && !attention.length &&
      document.activeElement === document.body) rowBodyRef.current?.focus();
    wasOpen.current = popover.isOpen;
  }, [popover.isOpen, participant, attention.length]);

  if (participant && !attention.length && !popover.isOpen) return null;
  return <DialogTrigger isOpen={popover.isOpen} onOpenChange={(open) => {
    if (open && participant) rowBodyRef.current = popover.triggerRef.current?.parentElement?.querySelector("button[data-thread-select]") ?? null;
    popover.setOpen(open);
  }}>
    {/* A native Pressable trigger retains its title and compact row metrics;
        base IconButton's 32px minimum would increase the row height. */}
    <Pressable><button type="button" ref={popover.triggerRef}
      data-testid={participant ? "thread-cross-session-btn" : "sidebar-cross-session-btn"}
      data-comm-status={primary?.status}
      aria-label={label} title={label}
      onMouseEnter={() => { hovered.current = true; emphasize(); }}
      onMouseLeave={() => { hovered.current = false; if (document.activeElement !== popover.triggerRef.current) clearEmphasis(); }}
      onFocus={emphasize}
      onBlur={() => { if (!hovered.current) clearEmphasis(); }}
      className={cx("relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full text-foreground-icon-secondary outline-none transition-colors duration-150 hover:bg-background-tertiary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none",
        participant ? "h-5 min-w-5 px-0.5" : "h-7 px-1.5",
        popover.isOpen && "bg-background-tertiary-default text-foreground-icon-primary")}
    >
      <span className="relative inline-flex">
        <MessagesSquare className={participant ? "size-3.5" : "size-4"} aria-hidden />
        {primary && <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-background-secondary-default [&_svg]:size-2.5"><StatusIcon status={primary.status} /></span>}
      </span>
      {attention.length > (participant ? 1 : 0) && <span data-testid="cross-session-count" className="text-caption-2-medium">{attention.length}</span>}
    </button></Pressable>
    <Popover ref={popover.popoverRef} isNonModal placement="right top" offset={8}
      className="max-h-[min(32rem,calc(100dvh-2rem))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none">
      <Dialog aria-label={t("crossSession.title")} className="outline-none">
        <CommsDetails records={records} participant={participant} onClose={popover.close} />
      </Dialog>
    </Popover>
  </DialogTrigger>;
}

type CommsCategory = "all" | "active" | "finished" | "subtask" | "consultation";

function isCollapsibleRecord(record: CrossSessionCommunicationRecord): boolean {
  const text = `${record.message ?? ""}\n${record.replyText ?? ""}`;
  return text.length > 120 || text.split("\n").length > 3;
}

function CommsDetails({ records, participant, onClose }: {
  records: CrossSessionCommunicationRecord[];
  participant?: CrossSessionParticipant;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const sessions = useChatStore((s) => s.sessions);
  const markReviewed = useCrossSessionActivityStore((s) => s.markReviewed);
  const clearFinished = useCrossSessionActivityStore((s) => s.clearFinished);
  const [now, setNow] = useState(Date.now);
  const [category, setCategory] = useState<CommsCategory>("all");
  const [detailed, setDetailed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const active = records.some((record) => isCrossSessionActiveStatus(record.status));
  const [navigationError, setNavigationError] = useState<string>();
  useEffect(() => {
    markReviewed(records, participant);
  }, [records, participant, markReviewed]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const selectParticipant = async (target: CrossSessionParticipant) => {
    if (target.sessionId.startsWith("leader-branch:")) return;
    setNavigationError(undefined);
    const meta = sessions.find((s) => s.engine === target.engine && s.sessionId === target.sessionId && sameLeaderWorkspace(s.workspacePath, target.workspacePath));
    try {
      await useChatStore.getState().selectSession(target.engine, target.sessionId, meta?.workspacePath ?? target.workspacePath, meta ? { meta } : undefined);
      onClose();
    } catch {
      setNavigationError(t("crossSession.openFailed"));
    }
  };
  const activeCount = records.filter((r) => isCrossSessionActiveStatus(r.status)).length;
  const finishedCount = records.length - activeCount;
  const subtaskCount = records.filter((r) => r.kind === "subtask").length;
  const consultationCount = records.length - subtaskCount;
  const categories: Array<{ id: CommsCategory; label: string; count: number }> = [
    { id: "all", label: t("crossSession.filterAll"), count: records.length },
    { id: "active", label: t("crossSession.filterActive"), count: activeCount },
    { id: "finished", label: t("crossSession.filterFinished"), count: finishedCount },
    { id: "subtask", label: t("crossSession.filterSubtask"), count: subtaskCount },
    { id: "consultation", label: t("crossSession.filterConsultation"), count: consultationCount },
  ];
  const filteredRecords = records.filter((record) => {
    if (category === "active") return isCrossSessionActiveStatus(record.status);
    if (category === "finished") return !isCrossSessionActiveStatus(record.status);
    if (category === "subtask") return record.kind === "subtask";
    if (category === "consultation") return record.kind !== "subtask";
    return true;
  });
  const toggleDensity = () => {
    setDetailed((prev) => !prev);
    setExpandedIds({});
  };
  const toggleCardExpanded = (scopedId: string, currentExpanded: boolean) => {
    setExpandedIds((prev) => ({ ...prev, [scopedId]: !currentExpanded }));
  };
  const densityLabel = t(detailed ? "crossSession.toggleDensityToCompact" : "crossSession.toggleDensityToDetailed");
  return <div data-testid="cross-session-details" data-density={detailed ? "detailed" : "compact"} className="flex select-text flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-body-2-medium text-text-primary">{t("crossSession.title")}</h3>
      <div className="flex items-center gap-1">
        {records.length > 0 && <Button size="xs" data-testid="cross-session-density-btn"
          aria-pressed={detailed} aria-label={densityLabel} title={densityLabel} onClick={toggleDensity}>
          {t(detailed ? "crossSession.detailedMode" : "crossSession.compactMode")}
        </Button>}
        <Button size="xs" aria-label={t("crossSession.closePanel")} title={t("crossSession.closePanel")} onClick={onClose}>
          <X className="size-3" aria-hidden />
        </Button>
      </div>
    </div>
    {records.length > 0 && <div role="group" aria-label={t("crossSession.filterLabel")} data-testid="cross-session-filter-bar" className="flex flex-wrap items-center gap-1">
      {categories.map((item) => {
        const selected = category === item.id;
        return <button key={item.id} type="button" data-testid={`cross-session-filter-${item.id}`}
          aria-pressed={selected} onClick={() => setCategory(item.id)}
          className={cx(
            "inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-caption-2-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none",
            selected
              ? "bg-background-tertiary-default text-text-primary"
              : "text-text-tertiary hover:bg-background-tertiary-hover hover:text-text-secondary",
          )}>
          <span>{item.label}</span>
          <span className="text-text-tertiary">{item.count}</span>
        </button>;
      })}
    </div>}
    {navigationError && <p role="alert" className="text-caption-1-regular text-notification-error">{navigationError}</p>}
    {!records.length && <p className="text-caption-1-regular text-text-tertiary">{t("crossSession.empty")}</p>}
    {records.length > 0 && !filteredRecords.length && <p data-testid="cross-session-filter-empty" className="text-caption-1-regular text-text-tertiary">{t("crossSession.filterEmpty")}</p>}
    {filteredRecords.map((record) => {
      const cardExpanded = expandedIds[record.scopedId] ?? detailed;
      const canToggleCard = isCollapsibleRecord(record) || expandedIds[record.scopedId] !== undefined;
      return <section key={record.scopedId} data-testid="cross-session-comm-card" data-comm-status={record.status} data-expanded={cardExpanded}
        className="flex flex-col gap-2 rounded-lg border border-border-secondary bg-background-secondary/60 p-2">
        <div className="flex items-center gap-1 text-caption-2-medium">
          {[record.sender, record.target].map((target, index) => {
            const title = resolveParticipantLabel(target, sessions);
            const pendingTarget = target.sessionId.startsWith("leader-branch:");
            return <div key={index} className="contents">
              {index === 1 && <ArrowRight className="size-3 shrink-0 text-foreground-icon-tertiary" aria-hidden />}
              <button type="button" disabled={pendingTarget} onClick={() => void selectParticipant(target)}
                aria-label={t(index === 0 ? "crossSession.openSender" : "crossSession.openTarget", { title })}
                title={title}
                className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm px-1 py-1 text-left text-text-secondary outline-none hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-default disabled:hover:bg-transparent">
                <EngineIcon engine={target.engine} size={12} className="size-3 shrink-0" />
                <span className="truncate">{title}</span>
              </button>
            </div>;
          })}
        </div>
        <div className="flex items-center justify-between gap-2 text-caption-2-medium text-text-secondary">
          <span className="inline-flex items-center gap-1.5"><StatusIcon status={record.status} />{t(`crossSession.status.${record.status}`)}</span>
          <div className="flex items-center gap-1.5">
            <span className="text-text-tertiary">{t("crossSession.elapsedSeconds", { seconds: Math.max(0, Math.floor(((isCrossSessionActiveStatus(record.status) ? now : record.updatedAt) - record.acceptedAt) / 1000)) })}</span>
            {canToggleCard && <button type="button" data-testid="cross-session-card-toggle"
              aria-expanded={cardExpanded}
              aria-label={t(cardExpanded ? "crossSession.collapseCard" : "crossSession.expandCard")}
              title={t(cardExpanded ? "crossSession.collapseCard" : "crossSession.expandCard")}
              onClick={() => toggleCardExpanded(record.scopedId, cardExpanded)}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-caption-2-medium text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none">
              <span>{t(cardExpanded ? "crossSession.collapseCard" : "crossSession.expandCard")}</span>
              {cardExpanded ? <ChevronUp className="size-3 shrink-0" aria-hidden /> : <ChevronDown className="size-3 shrink-0" aria-hidden />}
            </button>}
          </div>
        </div>
        <p data-testid="cross-session-card-prompt" className={cx("whitespace-pre-wrap text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]", !cardExpanded && "line-clamp-3")}>
          <span className="font-medium">{t(record.kind === "subtask" ? "crossSession.subtaskPromptLabel" : "crossSession.promptLabel")}： </span>{record.message}
        </p>
        {record.status === "awaiting_cost_approval" && <CrossSessionCostApproval record={record} />}
        {record.replyText && <div data-testid="cross-session-card-reply" className={cx("rounded-md bg-background-primary-default p-2 text-caption-1-regular text-text-secondary", !cardExpanded && "line-clamp-3")}>
          <span className="font-medium">{t(record.status === "executing" ? "crossSession.replyStreamingLabel" : "crossSession.replyDoneLabel")}： </span>
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{record.replyText}</span>
          {record.truncated && <span className="text-text-tertiary">{t("crossSession.truncated")}</span>}
        </div>}
        {record.error && <p role="alert" className="text-caption-1-regular text-notification-error [overflow-wrap:anywhere]">{record.error}</p>}
      </section>;
    })}
    {!participant && records.some((r) => !isCrossSessionActiveStatus(r.status)) &&
      <Button size="xs" data-testid="cross-session-clear-btn" onClick={clearFinished}>{t("crossSession.clearFinished")}</Button>}
  </div>;
}
