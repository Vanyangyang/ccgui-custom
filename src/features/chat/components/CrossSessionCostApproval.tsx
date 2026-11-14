import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/base/buttons/button";
import { approveCrossSessionMessage, cancelCrossSessionMessage, type CrossSessionCommunicationRecord } from "../cross-session";
import { crossSessionCostReview, hasConflictingSessionCostTab, requiresSessionSendCostApproval, sameSessionCostWorkspace, useSessionSendCostGuardStore, type CrossSessionCostReview } from "../cross-session-cost";
import { useHandoffStore } from "../session-cleanup";
import { sessionKey, useChatStore, type ActiveSession } from "../store";
import { usePromptCacheHeat } from "../use-prompt-cache";
import { usesUnlimitedPromptCache } from "../prompt-cache";
import { handoffLeaderCostApproval, resolveLeaderCostApproval } from "@/features/leader/cost-approval";
import { canPrepareCrossSessionHandoff, prepareCrossSessionHandoff } from "../cross-session-handoff";
import { newId } from "@/lib/id";
import { ManagedChildHandoff } from "./ManagedChildHandoff";
import { estimatePendingRequestCost } from "../pending-request-cost";
import { pendingRequestCostLines } from "../pending-request-cost-display";

function CostReviewTelemetry({
  review,
  snapshotFallback,
  showQueueWarning,
  engine,
  prompt,
  imageCount,
}: {
  review: CrossSessionCostReview | undefined;
  snapshotFallback?: boolean;
  showQueueWarning?: boolean;
  engine: string;
  prompt: string;
  imageCount?: number;
}) {
  const { t } = useTranslation();
  const liveCacheHeat = usePromptCacheHeat(review?.cacheExpiryDisabled ? undefined : review?.cache);
  const cacheHeat = review?.cache ? liveCacheHeat : review?.cacheHeat ?? "unknown";
  const context = review?.context;
  const used = context?.used;
  const max = context?.capacityKnown ? context.max : undefined;
  const exact = context?.kind === "current_context" && !context.modelMismatch && !context.reference &&
    used !== undefined && max !== undefined && max > 0;
  const estimate = estimatePendingRequestCost({ engine, model: review?.model ?? "", prompt, imageCount,
    context: context ?? { kind: "unknown" } });
  const estimateLines = pendingRequestCostLines(estimate, t);

  return <>
    <p>{review?.model ? t("crossSession.costModel", { model: review.model }) : t("crossSession.costModelUnknown")}</p>
    <div data-testid="pending-request-cost" className="flex flex-col gap-1">
      {estimateLines.slice(0, 3).map((line, index) => <p key={index}>{line}</p>)}
      <details><summary>{t("crossSession.pendingEstimateDetails")}</summary>
        {estimateLines.slice(3).map((line, index) => <p key={index}>{line}</p>)}
      </details>
    </div>
    <div data-testid="cost-context">
      {exact ? <p>{t("crossSession.costContext", { used: used.toLocaleString(), max: max.toLocaleString(), pct: Math.round(used / max * 100) })}</p> : <>
        <p>{used === undefined ? t("crossSession.costContextUnknown") :
          t(context?.kind === "last_request" || context?.modelMismatch ? "crossSession.costLastRequest" : "crossSession.costContextUsed", { used: used.toLocaleString() })}</p>
        {max !== undefined && <p>{t("crossSession.costContextCapacity", { max: max.toLocaleString() })}</p>}
      </>}
      {context?.reference && <p>{t("crossSession.costReference")}</p>}
      {context?.modelMismatch && <p>{t("crossSession.costModelChanged", { model: context.usageModel ?? t("crossSession.costModelUnknown") })}</p>}
    </div>
    {review && <p className="text-text-tertiary">{t("crossSession.costSampledAt", { time: new Date(review.capturedAt).toLocaleString() })}</p>}
    {snapshotFallback && review && <p className="text-text-tertiary">{t("crossSession.costSnapshotFallback")}</p>}
    {!review?.cacheExpiryDisabled && <p>{t(cacheHeat === "hot" ? "crossSession.costCacheHot" : cacheHeat === "cold" ? "crossSession.costCacheCold" : "crossSession.costCacheUnknown")}</p>}
    <p>{t("crossSession.costHistoryWarning")}</p>
    {showQueueWarning && review && review.targetStatus !== "idle" && <p>{t(review.cacheExpiryDisabled ? "crossSession.costQueuePending" : "crossSession.costQueueWarning")}</p>}
  </>;
}

/** A snapshot for an explicit human decision; rendering never sends anything. */
export function CrossSessionCostApproval({ record }: { record: CrossSessionCommunicationRecord }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [managedHandoff, setManagedHandoff] = useState<{ record: CrossSessionCommunicationRecord; operationId: string }>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const target = record.target;
  const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
  const sessions = useChatStore((state) => state.sessions);
  const tabs = useChatStore((state) => state.openTabs);
  // Only these scalar/usage changes invalidate the sample. Streaming text does
  // not scan all sessions or repeatedly recalculate the context snapshot.
  const inputs = useChatStore(useShallow((state) => {
    const session = state.bySession?.[key];
    return [!!session, session?.usage, session?.activeModel, session?.streaming,
      session?.queue.length, state.models?.[target.engine]] as const;
  }));
  const meta = useMemo(() => {
    const candidates = sessions.filter((s) => s.engine === target.engine && s.sessionId === target.sessionId);
    return candidates.length === 1 && !hasConflictingSessionCostTab(target, tabs) && sameSessionCostWorkspace(candidates[0].workspacePath, target.workspacePath) ? candidates[0] : undefined;
  }, [sessions, tabs, target.engine, target.sessionId, target.workspacePath]);
  const tabModel = useMemo(() => tabs?.find((tab) => tab.engine === target.engine &&
    tab.sessionId === target.sessionId && sameSessionCostWorkspace(tab.workspacePath, target.workspacePath))?.model,
  [tabs, target.engine, target.sessionId, target.workspacePath]);
  const review = useMemo(() => {
    if (!meta || !inputs[0]) {
      if (!record.costReview) return undefined;
      const model = record.leaderCostApproval ? record.leaderCostApproval.model ?? undefined : record.costReview.model;
      return { ...record.costReview, model, cacheExpiryDisabled: usesUnlimitedPromptCache(target.engine, model) };
    }
    const state = useChatStore.getState();
    const session = state.bySession[key];
    const awaiting = session.messages.some((m) => m.question?.status === "pending" || m.grant?.status === "pending" ||
      ["awaiting_review", "deferred", "submitting"].includes(m.planReview?.status ?? ""));
    const sample = crossSessionCostReview({ ...meta, workspacePath: target.workspacePath }, state, awaiting ? "awaiting_permission" : session.streaming || session.queue.length ? "busy" : "idle",
      Date.now(), record.leaderCostApproval ? record.leaderCostApproval.model ?? null : undefined);
    return record.leaderCostApproval && record.costReview
      ? { ...record.costReview, model: sample.model, capturedAt: sample.capturedAt, context: sample.context, cacheExpiryDisabled: sample.cacheExpiryDisabled } : sample;
  }, [meta, inputs, tabModel, key, target.workspacePath, record.costReview, record.leaderCostApproval]);
  const act = async (action: (id: string) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action(record.scopedId);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message === "Host chat target model changed before cost approval"
        ? t("crossSession.costApprovalModelChanged")
        : t("crossSession.costActionFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const canHandoff = canPrepareCrossSessionHandoff(record, review);
  const prepareHandoff = async () => prepareCrossSessionHandoff(record, review);

  return <div data-testid="cross-session-cost-approval" aria-busy={pending}
    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-secondary bg-background-primary-default p-2 text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]">
    <div>
      <p className="font-medium text-text-warning-primary">{t("crossSession.costApprovalTitle")}</p>
      <p>{t(record.leaderCostApproval ? "crossSession.taskCostApprovalPending" : "crossSession.costApprovalPending")}</p>
    </div>
    <CostReviewTelemetry review={review} engine={target.engine} prompt={record.message} imageCount={record.leaderCostApproval ? record.imageRefs?.length ?? 0 : undefined} snapshotFallback={!meta || !inputs[0]} showQueueWarning={!record.leaderCostApproval} />
    {canHandoff && record.leaderCostApproval && <p className="text-text-tertiary">{t("crossSession.managedHandoffPreparationCost")}</p>}
    {canHandoff && !record.leaderCostApproval && <p>{t("crossSession.costHandoffPending")}</p>}
    {error && <p role="alert" className="text-notification-error [overflow-wrap:anywhere]">{error}</p>}
    {managedHandoff ? <ManagedChildHandoff record={managedHandoff.record} onCancel={() => setManagedHandoff(undefined)} onSubmit={async (summary, targetSelection) => {
      if (targetSelection) await handoffLeaderCostApproval(managedHandoff.record, summary, managedHandoff.operationId, targetSelection);
      else await handoffLeaderCostApproval(managedHandoff.record, summary, managedHandoff.operationId);
      if (mounted.current) setManagedHandoff(undefined);
    }} /> : <div className="flex flex-wrap gap-2">
      {canHandoff && <Button size="xs" variant="secondary" disabled={pending} onClick={() => record.leaderCostApproval
        ? setManagedHandoff({ record: structuredClone(record), operationId: newId() }) : void act(prepareHandoff)}>{t(record.leaderCostApproval ? "crossSession.managedHandoffOpen" : "crossSession.costHandoff")}</Button>}
      <Button size="xs" variant="primary" disabled={pending} onClick={() => void act((id) => record.leaderCostApproval
        ? resolveLeaderCostApproval(record, true) : approveCrossSessionMessage(id, undefined, review?.model ?? null))}>{t("crossSession.costApprove")}</Button>
      <Button size="xs" variant="secondary" disabled={pending} onClick={() => void act((id) => record.leaderCostApproval
        ? resolveLeaderCostApproval(record, false) : cancelCrossSessionMessage(id))}>{t("crossSession.costCancel")}</Button>
    </div>}
  </div>;
}

/** Daily send & queue-drain cost confirmation card in the active conversation. */
export function SessionSendCostApproval({ active, className }: { active: ActiveSession | null; className?: string }) {
  const { t } = useTranslation();
  const key = active?.sessionId ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  const pendingGuard = useSessionSendCostGuardStore((state) => (key ? state.bySessionKey[key] : undefined));
  const sessions = useChatStore((state) => state.sessions);
  const tabs = useChatStore((state) => state.openTabs);
  const inputs = useChatStore(useShallow((state) => {
    const session = key ? state.bySession?.[key] : undefined;
    return [!!session, session?.usage, session?.activeModel, session?.streaming,
      session?.queue.length, active ? state.models?.[active.engine] : undefined, state.drafts?.[key]] as const;
  }));
  const meta = useMemo(() => {
    if (!active?.sessionId || hasConflictingSessionCostTab({ ...active, sessionId: active.sessionId }, tabs)) return undefined;
    const candidates = sessions?.filter((s) => s.engine === active.engine && s.sessionId === active.sessionId) ?? [];
    return candidates.length === 1 && (!candidates[0].workspacePath || sameSessionCostWorkspace(candidates[0].workspacePath, active.workspacePath)) ? candidates[0] : undefined;
  }, [sessions, tabs, active?.engine, active?.sessionId, active?.workspacePath]);
  const tabModel = useMemo(() => active?.sessionId
    ? tabs?.find((tab) => tab.engine === active.engine && tab.sessionId === active.sessionId && sameSessionCostWorkspace(tab.workspacePath, active.workspacePath))?.model
    : undefined, [tabs, active?.engine, active?.sessionId, active?.workspacePath]);
  const review = useMemo(() => {
    if (!pendingGuard) return undefined;
    if (!meta || !inputs[0]) return { ...pendingGuard.review,
      cacheExpiryDisabled: usesUnlimitedPromptCache(pendingGuard.engine, pendingGuard.review.model) };
    const state = useChatStore.getState();
    return crossSessionCostReview({ ...meta, workspacePath: active!.workspacePath }, state, "idle");
  }, [pendingGuard, meta, inputs, tabModel, key, active?.workspacePath]);

  useEffect(() => {
    if (!pendingGuard || pendingGuard.mode !== "send" || !meta || !inputs[0] || !review) return;
    const session = useChatStore.getState().bySession?.[key];
    if (session && !requiresSessionSendCostApproval(review, meta, session)) {
      useSessionSendCostGuardStore.getState().dismiss(key);
    }
  }, [pendingGuard, meta, inputs, review, key]);

  if (!pendingGuard || !active?.sessionId) return null;

  const canHandoff = !review?.cache?.reference;
  const handleHandoff = () => {
    const state = useChatStore.getState();
    const latestDraft = pendingGuard.mode === "send" && state.drafts?.[key]?.trim()
      ? state.drafts[key]
      : pendingGuard.prompt;
    useSessionSendCostGuardStore.getState().dismiss(key);
    if (pendingGuard.mode === "queue_drain" && pendingGuard.queuedItemId) {
      state.removeQueued?.(pendingGuard.queuedItemId, key);
    } else {
      state.setDraft?.(key, "");
    }
    const title = meta?.customTitle || meta?.title || active.sessionId!.slice(0, 8);
    useHandoffStore.getState().startHandoff({
      workspacePath: active.workspacePath,
      sourceEngine: active.engine,
      sourceSessionId: active.sessionId!,
      sourceTitle: title,
      sourceMeta: meta,
      sourceState: state.bySession?.[key],
      nextTask: latestDraft,
      archiveSourceOnSend: false,
    });
  };

  const handleSendAnyway = () => {
    const effectiveReview = review ?? pendingGuard.review;
    useSessionSendCostGuardStore.getState().markApproved(key, effectiveReview);
    if (pendingGuard.onApproveSend) {
      pendingGuard.onApproveSend();
      return;
    }
    if (pendingGuard.mode === "queue_drain" && pendingGuard.queuedItemId) {
      void useChatStore.getState().sendQueuedNow?.(pendingGuard.queuedItemId, key);
    }
  };

  return <section className={className} data-testid="session-send-cost-approval">
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-secondary bg-background-secondary-default p-2.5 text-caption-1-regular text-text-secondary [overflow-wrap:anywhere]">
      <div>
        <p className="font-medium text-text-warning-primary">{t("crossSession.costApprovalTitle")}</p>
        <p>{t(review?.context.modelMismatch
          ? pendingGuard.mode === "queue_drain" ? "crossSession.selfCostModelQueuePending" : "crossSession.selfCostModelApprovalPending"
          : review?.cacheExpiryDisabled ? "crossSession.selfCostHeldPending"
          : pendingGuard.mode === "queue_drain" ? "crossSession.selfCostQueuePending" : "crossSession.selfCostApprovalPending")}</p>
      </div>
      <CostReviewTelemetry review={review} engine={pendingGuard.engine} prompt={pendingGuard.mode === "send" && inputs[6]?.trim() ? inputs[6] : pendingGuard.prompt} imageCount={pendingGuard.images.length} />
      <div className="flex flex-wrap gap-2">
        {canHandoff && (
          <Button size="xs" variant="primary" data-testid="session-cost-handoff-btn" onClick={handleHandoff}>
            {t("crossSession.selfCostHandoff")}
          </Button>
        )}
        <Button size="xs" variant={canHandoff ? "secondary" : "primary"} data-testid="session-cost-send-btn" onClick={handleSendAnyway}>
          {t("crossSession.selfCostSendAnyway")}
        </Button>
        <Button size="xs" variant="ghost" data-testid="session-cost-cancel-btn" onClick={() => useSessionSendCostGuardStore.getState().dismiss(key)}>
          {t("crossSession.costCancel")}
        </Button>
      </div>
    </div>
  </section>;
}
