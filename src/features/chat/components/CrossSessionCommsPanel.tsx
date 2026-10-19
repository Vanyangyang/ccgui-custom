import { useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Dialog, DialogTrigger, Popover, Pressable } from "react-aria-components";
import { useShallow } from "zustand/react/shallow";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
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
import {
  crossSessionParticipantKey,
  crossSessionRecordMatchesParticipant,
  isCrossSessionActiveStatus,
  isCrossSessionRecordUnread,
  useCrossSessionActivityStore,
  type CrossSessionCommunicationRecord,
  type CrossSessionParticipant,
} from "../cross-session";

function resolveParticipantLabel(
  participant: CrossSessionParticipant,
  sessions: ReturnType<typeof useChatStore.getState>["sessions"],
): string {
  const match = sessions.find((s) => s.engine === participant.engine &&
    s.sessionId === participant.sessionId && s.workspacePath === participant.workspacePath);
  const title = match?.customTitle || match?.title || participant.title;
  if (title?.trim()) return title.trim();
  return `${CLI_DISPLAY_NAMES[participant.engine] ?? participant.engine} · ${participant.sessionId.slice(0, 8)}`;
}

function needsAttention(record: CrossSessionCommunicationRecord, participant?: CrossSessionParticipant) {
  return isCrossSessionActiveStatus(record.status) || isCrossSessionRecordUnread(record, participant);
}

function threadParticipant(threadId?: string, workspacePath?: string): CrossSessionParticipant | undefined {
  const separator = threadId?.indexOf("/") ?? -1;
  if (!threadId || separator <= 0 || separator === threadId.length - 1 || !workspacePath) return undefined;
  return { engine: threadId.slice(0, separator), sessionId: threadId.slice(separator + 1), workspacePath };
}

// Transient emphasis only; never changes selection, disclosure or read state.
const useCommsEmphasis = create<{ owner?: string; participant?: CrossSessionParticipant }>(() => ({}));

export function useCrossSessionThreadActivity(threadId?: string, workspacePath?: string) {
  const { t } = useTranslation();
  const participant = threadParticipant(threadId, workspacePath);
  const records = useCrossSessionActivityStore(useShallow((state) => participant
    ? state.records.filter((record) => crossSessionRecordMatchesParticipant(record, participant)) : []));
  const emphasized = useCommsEmphasis((state) => state.participant);
  const active = records.find((record) => isCrossSessionActiveStatus(record.status));
  const outgoing = !!active && !!participant && crossSessionParticipantKey(active.sender) === crossSessionParticipantKey(participant);
  const other = active ? outgoing ? active.target : active.sender : undefined;
  const title = useChatStore((state) => other ? resolveParticipantLabel(other, state.sessions) : "");
  const summary = active ? t(active.status === "awaiting_permission" ? "crossSession.rowAwaitingPermission" :
    outgoing ? "crossSession.rowAsking" : active.status === "executing" ? "crossSession.rowReplying" : "crossSession.rowReceiving", { title }) : undefined;
  const related = !!participant && !!emphasized && crossSessionParticipantKey(participant) !== crossSessionParticipantKey(emphasized) &&
    records.some((record) => crossSessionRecordMatchesParticipant(record, emphasized) && needsAttention(record, emphasized));
  return { active: !!active, summary, related };
}

function StatusIcon({ status }: { status: CrossSessionCommunicationRecord["status"] }) {
  if (status === "failed" || status === "unknown" || status === "awaiting_permission") {
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
export function CrossSessionThreadIndicator({ threadId, workspacePath }: { threadId: string; workspacePath?: string }) {
  const participant = threadParticipant(threadId, workspacePath);
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
  const primary = attention.find((r) => ["failed", "awaiting_permission", "unknown"].includes(r.status)) ??
    attention.find((r) => isCrossSessionActiveStatus(r.status)) ?? attention[0];
  let summary = activeCount ? t("crossSession.activeBadge", { count: activeCount }) :
    unreadCount ? t("crossSession.unreadBadge", { count: unreadCount }) : t("crossSession.title");
  if (participant && primary) {
    const outgoing = crossSessionParticipantKey(primary.sender) === crossSessionParticipantKey(participant);
    const other = resolveParticipantLabel(outgoing ? primary.target : primary.sender, useChatStore.getState().sessions);
    summary = `${t(outgoing ? "crossSession.outgoing" : "crossSession.incoming", { title: other })} · ${t(`crossSession.status.${primary.status}`)}`;
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
    setNavigationError(undefined);
    const meta = sessions.find((s) => s.engine === target.engine && s.sessionId === target.sessionId && s.workspacePath === target.workspacePath);
    try {
      await useChatStore.getState().selectSession(target.engine, target.sessionId, target.workspacePath, meta ? { meta } : undefined);
      onClose();
    } catch {
      setNavigationError(t("crossSession.openFailed"));
    }
  };
  return <div data-testid="cross-session-details" className="flex select-text flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-body-2-medium text-text-primary">{t("crossSession.title")}</h3>
      <Button size="xs" aria-label={t("crossSession.closePanel")} title={t("crossSession.closePanel")} onClick={onClose}>
        <X className="size-3" aria-hidden />
      </Button>
    </div>
    {navigationError && <p role="alert" className="text-caption-1-regular text-notification-error">{navigationError}</p>}
    {!records.length && <p className="text-caption-1-regular text-text-tertiary">{t("crossSession.empty")}</p>}
    {records.map((record) => <section key={record.scopedId} data-testid="cross-session-comm-card" data-comm-status={record.status}
      className="flex flex-col gap-2 rounded-lg border border-border-secondary bg-background-secondary/60 p-2">
      <div className="flex items-center gap-1 text-caption-2-medium">
        {[record.sender, record.target].map((target, index) => {
          const title = resolveParticipantLabel(target, sessions);
          return <div key={index} className="contents">
            {index === 1 && <ArrowRight className="size-3 shrink-0 text-foreground-icon-tertiary" aria-hidden />}
            <button type="button" onClick={() => void selectParticipant(target)}
              aria-label={t(index === 0 ? "crossSession.openSender" : "crossSession.openTarget", { title })}
              title={title}
              className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm px-1 py-1 text-left text-text-secondary outline-none hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring">
              <EngineIcon engine={target.engine} size={12} className="size-3 shrink-0" />
              <span className="truncate">{title}</span>
            </button>
          </div>;
        })}
      </div>
      <div className="flex items-center justify-between gap-2 text-caption-2-medium text-text-secondary">
        <span className="inline-flex items-center gap-1.5"><StatusIcon status={record.status} />{t(`crossSession.status.${record.status}`)}</span>
        <span className="text-text-tertiary">{t("crossSession.elapsedSeconds", { seconds: Math.max(0, Math.floor(((isCrossSessionActiveStatus(record.status) ? now : record.updatedAt) - record.acceptedAt) / 1000)) })}</span>
      </div>
      <p className="whitespace-pre-wrap text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]">
        <span className="font-medium">{t("crossSession.promptLabel")}： </span>{record.message}
      </p>
      {record.replyText && <div className="rounded-md bg-background-primary-default p-2 text-caption-1-regular text-text-secondary">
        <span className="font-medium">{t(record.status === "executing" ? "crossSession.replyStreamingLabel" : "crossSession.replyDoneLabel")}： </span>
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{record.replyText}</span>
        {record.truncated && <span className="text-text-tertiary">{t("crossSession.truncated")}</span>}
      </div>}
      {record.error && <p role="alert" className="text-caption-1-regular text-notification-error [overflow-wrap:anywhere]">{record.error}</p>}
    </section>)}
    {!participant && records.some((r) => !isCrossSessionActiveStatus(r.status)) &&
      <Button size="xs" data-testid="cross-session-clear-btn" onClick={clearFinished}>{t("crossSession.clearFinished")}</Button>}
  </div>;
}
