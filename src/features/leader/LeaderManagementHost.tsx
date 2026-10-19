import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell, ConfirmDialog } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { errorText } from "@/lib/errors";
import { branchDeletionState, useLeaderStore } from "./store";
import { isDirectChild, leaderGroupRoot, leaderGroupBranches, sameIdentity, type LeaderBranch, type LeaderIdentity } from "./types";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { useClaudeContextWindow } from "@/features/chat/components/use-claude-context-window";
import { leaderContextInfo, leaderDeadlineInfo, leaderRenewSeconds } from "./branch-health";
import { useBranchUsage } from "./use-branch-usage";

export function LeaderManagementHost() {
  const parent = useLeaderStore((s) => s.managing);
  const deleting = useLeaderStore((s) => s.deletingBranch);
  return <>{parent && <LeaderManagement key={`${parent.engine}/${parent.sessionId}/${parent.workspacePath}`} parent={parent} />}{deleting && <BranchDeleteConfirmation parent={deleting.parent} branchId={deleting.branchId} />}</>;
}

function BranchDeleteConfirmation({ parent, branchId }: { parent: LeaderIdentity; branchId: string }) {
  const { t } = useTranslation();
  const snapshot = useLeaderStore((s) => s.snapshot);
  const busy = useLeaderStore((s) => s.busy);
  const error = useLeaderStore((s) => s.error);
  const chat = useChatStore();
  const { branches, available, active } = branchDeletionState(snapshot, branchId, chat);
  const branch = branches[0];
  const session = branch?.sessionId ? chat.sessions.find((candidate) => sameIdentity(candidate, {
    engine: branch.engine, sessionId: branch.sessionId!, workspacePath: branch.workspacePath,
  })) : undefined;
  const title = session?.customTitle || session?.title || branch?.title || branchId;
  const close = () => { if (!useLeaderStore.getState().busy) useLeaderStore.setState({ deletingBranch: null, error: null }); };
  const label = t(branches.length > 1 ? "leader.deleteSubtree" : "leader.deleteBranch");
  return <ModalShell label={label} onClose={close}>
    <h2 className="text-body-medium text-text-primary">{label}</h2>
    <p className="mt-3 text-body-2-medium text-text-secondary">{t("leader.deleteBranchConfirm", { title, count: branches.length })}</p>
    {(!available || active) && <p role="alert" className="mt-2 text-body-2-medium text-text-error">{t(active ? "leader.deleteBranchIdle" : "leader.deleteBranchUnavailable")}</p>}
    {error && <p role="alert" className="mt-2 text-body-2-medium text-text-error">{error}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="secondary" size="small" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
      <Button variant="danger" size="small" disabled={busy || !available || active} onClick={() => { void useLeaderStore.getState().deleteBranch(parent, branchId, branches.map((b) => b.id)).catch(() => {}); }}>{label}</Button>
    </div>
  </ModalShell>;
}

function LeaderManagement({ parent }: { parent: LeaderIdentity }) {
  const { t } = useTranslation();
  const snapshot = useLeaderStore((s) => s.snapshot);
  const error = useLeaderStore((s) => s.error);
  const busy = useLeaderStore((s) => s.busy);
  const [ttlMinutes, setTtlMinutes] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const sessions = useChatStore((s) => s.sessions);
  const bySession = useChatStore((s) => s.bySession);
  const refreshFeedback = useActionFeedback({ spin: true });
  const children = snapshot.branches.filter((b) => isDirectChild(b, parent) && b.state !== "reclaimed");
  const usage = useBranchUsage(children, bySession);
  const claudeContext = useClaudeContextWindow(children.some((branch) => branch.engine === "claude") ? "claude" : "");
  const ttlSeconds = leaderRenewSeconds(ttlMinutes);
  const groupRoot = leaderGroupRoot(snapshot, parent);
  const isRoot = sameIdentity(groupRoot, parent);
  const descendants = leaderGroupBranches(snapshot, groupRoot);
  const archivedGroup = snapshot.archivedGroups?.find((group) => sameIdentity(group.root, groupRoot));
  const groupTitle = sessions.find((s) => sameIdentity(s, groupRoot));
  const title = groupTitle?.customTitle || groupTitle?.title || archivedGroup?.title || groupRoot.sessionId.slice(0, 8);
  const displayedError = localError ?? error;
  const hasActivity = descendants.some((b) => ["starting", "running", "waiting", "reclaiming"].includes(b.state))
    || [groupRoot, ...descendants.flatMap((b) => b.sessionId ? [{ engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath }] : [])].some((identity) => {
      const session = bySession[sessionKey(identity.engine, identity.sessionId, identity.workspacePath)];
      return session && (session.streaming || session.queue.length > 0 || session.messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" || ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? "")));
    });
  const close = () => { if (!busy) useLeaderStore.setState({ managing: null }); };
  const act = (branch: LeaderBranch, action: "stop" | "renew") => {
    if (useLeaderStore.getState().busy) return;
    setLocalError(null);
    if (action === "renew" && ttlSeconds === null) return;
    void useLeaderStore.getState().act(parent, branch.id, action, action === "renew" ? ttlSeconds ?? undefined : undefined)
      .catch((error) => setLocalError(errorText(error)));
  };
  const groupAction = (action: "archive" | "delete") => {
    if (useLeaderStore.getState().busy) return;
    setLocalError(null);
    setConfirmDelete(false);
    void useLeaderStore.getState().groupAction(groupRoot, action).then(close).catch((error) => setLocalError(errorText(error)));
  };
  const open = (branch: LeaderBranch) => {
    if (!branch.sessionId) return;
    void useChatStore.getState().selectSession(branch.engine, branch.sessionId, branch.workspacePath);
    close();
  };
  return <>
    <ModalShell label={t("leader.manage")} onClose={close} className="w-[min(640px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto">
      <div className="flex flex-col gap-3">
        <h2 className="text-body-medium text-text-primary">{t("leader.manage")}</h2>
        <p className="break-all text-caption-1-medium text-text-tertiary">{parent.engine} / {parent.sessionId}</p>
        <p className="text-body-2-medium text-text-secondary">{t("leader.managementHint")}</p>
        {isRoot ? <div className="rounded-lg border border-border-button-default p-3">
          {archivedGroup?.deletionStarted
            ? <p role="alert" className="text-body-2-medium text-text-error">{t("leader.groupDeletionIncomplete")}</p>
            : <p className="text-body-2-medium text-text-secondary">{t("leader.groupArchiveHint", { count: descendants.length })}</p>}
          {hasActivity && <p className="mt-1 text-caption-1-medium text-text-tertiary">{t("leader.groupArchiveIdle")}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="small" disabled={busy || hasActivity || archivedGroup?.deletionStarted === true} onClick={() => groupAction("archive")}>{t("leader.archiveGroup")}</Button>
            <Button variant="danger" size="small" disabled={busy || hasActivity} onClick={() => setConfirmDelete(true)}>{t(archivedGroup?.deletionStarted ? "leader.retryDeleteGroup" : "leader.deleteGroup")}</Button>
          </div>
        </div> : <div className="text-body-2-medium text-text-secondary">
          <p>{t("leader.rootOnly")}</p>
          <Button variant="secondary" size="small" disabled={busy} onClick={() => useLeaderStore.setState({ managing: groupRoot, error: null })}>{t("leader.manageRoot")}</Button>
        </div>}
        {displayedError && <p role="alert" className="text-body-2-medium text-text-error">{displayedError}</p>}
        <div>
          <label className="flex flex-wrap items-center gap-2 text-body-2-medium text-text-secondary">
            {t("leader.ttlMinutes")}
            <input type="number" min={1} max={1440} step={1} value={ttlMinutes} placeholder={t("leader.ttlDefault")} aria-invalid={ttlSeconds === null} onChange={(e) => setTtlMinutes(e.target.value)} className="w-24 rounded border border-border-button-default p-1" />
          </label>
          <p className="mt-1 text-caption-1-medium text-text-tertiary">{t("leader.ttlDefaultHint")}</p>
          {ttlSeconds === null && <p className="mt-1 text-caption-1-medium text-text-error">{t("leader.ttlRangeError")}</p>}
        </div>
        {!children.length && <p className="text-body-2-medium text-text-tertiary">{t("leader.noChildren")}</p>}
        {children.map((branch) => {
          const deadline = leaderDeadlineInfo(branch);
          const session = branch.sessionId ? bySession[sessionKey(branch.engine, branch.sessionId, branch.workspacePath)] : undefined;
          const context = leaderContextInfo({ branch, sample: usage.sampleFor(branch), cachedUsage: session?.usage,
            model: session?.activeModel, claudeWindow: claudeContext.window, claudeConfigKnown: claudeContext.block !== "unavailable" });
          return <div key={branch.id} data-leader-branch={branch.id} className="rounded-lg border border-border-button-default p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-body-2-medium text-text-primary" title={branch.title}>{branch.title}</span>
            <span className="shrink-0 text-caption-1-medium text-text-secondary">{branch.engine} · {t(`leader.state.${branch.state}`)}</span>
          </div>
          <p className="mt-1 text-caption-1-medium text-text-tertiary">
            {deadline.known ? t(deadline.expired ? "leader.expiredDeadline" : "leader.deadline", { time: new Date(branch.deadlineAt).toLocaleString() }) : t("leader.deadlineUnknown")}
          </p>
          <p className="mt-1 text-caption-1-medium text-text-tertiary">
            {t("leader.contextUsage", { tokens: context.tokens?.toLocaleString() ?? t("leader.unknown"), max: context.max?.toLocaleString() ?? t("leader.unknown"), percent: context.percent === undefined ? t("leader.unknown") : `${context.percent}%` })}
          </p>
          {context.source === "history" && <p className="mt-1 text-caption-1-medium text-text-tertiary">{t("leader.contextHistory", { time: new Date(context.fetchedAt!).toLocaleString() })}</p>}
          {usage.readFailedFor(branch) && <p className="mt-1 text-caption-1-medium text-text-error">{t("leader.contextReadFailed")}</p>}
          {context.suggestCompact && <p className="mt-2 text-body-2-medium text-text-secondary">{t("leader.compactSuggestion")}</p>}
          {branch.task && <p className="mt-2 whitespace-pre-wrap break-words text-body-2-medium text-text-secondary">{branch.task}</p>}
          {branch.error && <p role="alert" className="mt-2 whitespace-pre-wrap text-body-2-medium text-text-error">{branch.error}</p>}
          {branch.result && <details className="mt-2 text-body-2-medium text-text-secondary"><summary>{t("leader.result")}{branch.resultTruncated ? ` · ${t("leader.truncated")}` : ""}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{branch.result}</pre></details>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="small" disabled={!branch.sessionId || busy} onClick={() => open(branch)}>{t("leader.openChild")}</Button>
            <Button variant="secondary" size="small" disabled={busy || branch.state === "reclaiming" || ttlSeconds === null} onClick={() => act(branch, "renew")}>{t("leader.renew")}</Button>
            <Button variant="secondary" size="small" disabled={busy || ["completed", "failed", "stopped", "reclaiming"].includes(branch.state)} onClick={() => act(branch, "stop")}>{t("leader.stop")}</Button>
          </div>
        </div>; })}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="small" disabled={busy || refreshFeedback.feedback === "running"} onClick={() => { setLocalError(null); void refreshFeedback.start(async () => { await Promise.all([useLeaderStore.getState().refresh(), usage.refresh(), claudeContext.refresh()]); }, () => !!useLeaderStore.getState().error || usage.hasReadFailure()); }}>
            <ActionFeedbackIcon icon={RefreshCw} feedback={refreshFeedback.feedback} spin />{t("leader.refresh")}
          </Button>
          <Button variant="secondary" size="small" disabled={busy} onClick={close}>{t("common.close")}</Button>
        </div>
      </div>
    </ModalShell>
    {confirmDelete && <ConfirmDialog danger message={t("leader.deleteGroupConfirm", { title, count: descendants.length })} confirmLabel={t("leader.deleteGroup")} onCancel={() => setConfirmDelete(false)} onConfirm={() => groupAction("delete")} />}
  </>;
}
