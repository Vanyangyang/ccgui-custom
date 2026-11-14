import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { ipc, type HandoffCompressionSelection } from "@/lib/ipc";
import type { CrossSessionCommunicationRecord } from "../cross-session";
import { sameSessionCostWorkspace } from "../cross-session-cost";
import { sessionKey, useChatStore } from "../store";
import { confirmHost, managedHandoffConfirmation } from "@/features/host-confirmation/request";
import type { HostHandoffSnapshot, HostTaskSelection } from "@ccgui/plugin-sdk";
import { invoke } from "@/lib/transport";
import { resolveHandoffTargetSelection } from "@/features/leader/cost-approval";
import { ManagedChildTargetPicker } from "./ManagedChildTargetPicker";
import { managedChildHistoryText, managedChildSummaryService, type ManagedChildSummaryService } from "../managed-child-summary";
import { HandoffModelPicker } from "./HandoffCompressionControls";

interface Props {
  record: CrossSessionCommunicationRecord;
  onSubmit(summary: string, targetSelection?: HostTaskSelection): Promise<void>;
  onCancel(): void;
  summaryService?: ManagedChildSummaryService;
}

/** A draft editor only. The caller owns native validation and atomic submission. */
export function ManagedChildHandoff(props: Props) {
  const { record } = props;
  const identity = JSON.stringify([record.scopedId, record.requestId, record.leaderCostApproval,
    record.sender, record.target, record.message, record.imageRefs ?? []]);
  return <HandoffEditor key={identity} {...props} />;
}

function HandoffEditor({ record, onSubmit, onCancel, summaryService }: Props) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState("");
  const [history, setHistory] = useState<"loading" | "loaded" | "unavailable">("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [attemptedSummary, setAttemptedSummary] = useState<string>();
  const [targetSelection, setTargetSelection] = useState<HostTaskSelection>();
  const [attemptedTarget, setAttemptedTarget] = useState<HostTaskSelection>();
  const [targetSupported, setTargetSupported] = useState<boolean>();
  const [compression, setCompression] = useState<HostHandoffSnapshot>();
  const [preparingCompression, setPreparingCompression] = useState(false);
  const [selection, setSelection] = useState<HandoffCompressionSelection>();
  const service = useMemo(() => summaryService ?? managedChildSummaryService(), [summaryService]);
  const sourceHistory = useRef<{ text: string; version: string; isCurrent: () => boolean }>();
  const compressionIdentity = useRef<{ handoffId: string; requestId: string; revision: number }>();
  const edited = useRef(false);
  const closed = useRef(false);
  const inFlight = useRef(false);
  const compressionInFlight = useRef(false);
  const mounted = useRef(true);
  const target = record.target;
  const valid = summary.trim().length > 0 && summary.length <= 8000 && !summary.includes("\0");
  const model = record.leaderCostApproval?.model ?? record.costReview?.model;
  const compressionBusy = preparingCompression || compression?.status === "running" || compression?.status === "unknown";
  const selectionChanged = !!selection && !!compression && ["engine", "model", "providerId", "effort"].some(
    key => selection[key as keyof HandoffCompressionSelection] !== compression.selection[key as keyof HandoffCompressionSelection]);
  const acceptCompression = (view: HostHandoffSnapshot) => {
    const identity = compressionIdentity.current;
    if (!mounted.current || closed.current || !identity || identity.handoffId !== view.handoffId || identity.requestId !== view.requestId || identity.revision >= view.revision) return;
    identity.revision = view.revision;
    setCompression(view);
    if (view.status === "completed") {
      if (!view.summary?.trim() || view.summary.length > 8000 || view.summary.includes("\0")) {
        setCompression({ ...view, status: "failed", error: t("crossSession.managedHandoffCompressionInvalid") });
        setError(t("crossSession.managedHandoffCompressionInvalid")); return;
      }
      if (!edited.current) setSummary(view.summary);
    }
  };
  const compress = async (retry = false) => {
    const source = sourceHistory.current;
    if (!source || !selection || !mounted.current || closed.current || inFlight.current || compressionInFlight.current) return;
    compressionInFlight.current = true;
    if (retry) edited.current = false;
    setError(undefined); setPreparingCompression(true);
    try {
      const view = await service.prepare(record, source.text, source.version, source.isCurrent, retry, selection);
      if (!mounted.current || closed.current) return;
      compressionIdentity.current = { handoffId: view.handoffId, requestId: view.requestId, revision: -1 };
      acceptCompression(view);
      const latest = await service.inspect(view.handoffId);
      if (latest) acceptCompression(latest);
    } catch (cause) {
      if (mounted.current && !closed.current) setError(t("crossSession.managedHandoffCompressionFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally { compressionInFlight.current = false; if (mounted.current && !closed.current) setPreparingCompression(false); }
  };

  useEffect(() => {
    let live = true;
    void invoke<boolean>("task_managed_child_handoff_selection_supported").then(
      supported => { if (live) setTargetSupported(supported === true); },
      () => { if (live) setTargetSupported(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const off = service.onEvent(acceptCompression);
    const live = () => !cancelled && !closed.current;
    void service.preferences().then(value => { if (live()) setSelection(value.selection); })
      .catch(cause => { if (live()) setError(String(cause)); });
    const readMeta = () => {
      const state = useChatStore.getState();
      const matches = state.sessions.filter(meta => meta.engine === target.engine && meta.sessionId === target.sessionId);
      if (!target.sessionId || !target.workspacePath || matches.length !== 1 || matches[0].remote ||
        !sameSessionCostWorkspace(matches[0].workspacePath, target.workspacePath) ||
        state.archivedSessionKeys[sessionKey(target.engine, target.sessionId, target.workspacePath)] ||
        state.openTabs.some(tab => tab.engine === target.engine && tab.sessionId === target.sessionId && !sameSessionCostWorkspace(tab.workspacePath, target.workspacePath))) return undefined;
      return matches[0];
    };
    const meta = readMeta();
    if (!meta) setHistory("unavailable");
    else {
      const stamp = JSON.stringify([meta.filePath, meta.fileSize, meta.fileMtimeMs, meta.updatedAt]);
      void (async () => {
        try {
          const page = await ipc.loadSessionPage(target.engine, target.sessionId, 40);
          if (!live()) return;
          const latest = readMeta();
          if (!latest || JSON.stringify([latest.filePath, latest.fileSize, latest.fileMtimeMs, latest.updatedAt]) !== stamp) {
            setHistory("unavailable"); return;
          }
          const text = managedChildHistoryText(page.messages);
          if (!text) { setHistory("unavailable"); return; }
          sourceHistory.current = { text, version: stamp, isCurrent: () => {
            const latest = readMeta();
            return live() && !!latest && JSON.stringify([latest.filePath, latest.fileSize, latest.fileMtimeMs, latest.updatedAt]) === stamp;
          } };
          setHistory("loaded");
        } catch {
          if (live()) setHistory("unavailable");
        }
      })();
    }
    return () => { cancelled = true; mounted.current = false; off(); };
  }, [target.engine, target.sessionId, target.workspacePath, service]);

  const submit = async () => {
    if (!valid || inFlight.current || closed.current || compressionBusy) return;
    inFlight.current = true;
    const submitted = attemptedSummary ?? summary;
    setPending(true); setError(undefined);
    try {
      if (targetSelection && !targetSupported) throw new Error(t("crossSession.managedHandoffTargetUnsupported"));
      const resolved = targetSelection ? await resolveHandoffTargetSelection(targetSelection) : undefined;
      const same = (a: HostTaskSelection, b: HostTaskSelection) => ["engine", "model", "providerId", "effort"].every(key => a[key as keyof HostTaskSelection] === b[key as keyof HostTaskSelection]);
      if (attemptedTarget && (!resolved || !same(attemptedTarget, resolved))) throw new Error(t("crossSession.managedHandoffTargetInvalid"));
      if (!mounted.current || closed.current) return;
      const accepted = await confirmHost(resolved ? managedHandoffConfirmation({ ...record, model }, submitted, resolved) : managedHandoffConfirmation({ ...record, model }, submitted));
      if (!accepted || !mounted.current || closed.current) return;
      if (resolved && targetSelection) {
        const latest = await resolveHandoffTargetSelection(targetSelection);
        if (!same(resolved, latest)) throw new Error(t("crossSession.managedHandoffTargetInvalid"));
        if (!mounted.current || closed.current) return;
      }
      setAttemptedSummary(submitted);
      setAttemptedTarget(resolved);
      if (resolved) await onSubmit(submitted, resolved);
      else await onSubmit(submitted);
    }
    catch (cause) {
      if (mounted.current && !closed.current) setError(t("crossSession.managedHandoffFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      inFlight.current = false;
      if (mounted.current && !closed.current) setPending(false);
    }
  };

  return <section aria-label={t("crossSession.managedHandoffTitle")} aria-busy={pending}
    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-secondary bg-background-primary-default p-3 text-caption-1-regular text-text-secondary">
    <h3 className="font-medium text-text-primary">{t("crossSession.managedHandoffTitle")}</h3>
    <p>{t("crossSession.managedHandoffConsequence")}</p>
    <p className="[overflow-wrap:anywhere]">{t("crossSession.managedHandoffSource", { engine: target.engine, session: target.sessionId, model: model || "—" })}</p>
    <ManagedChildTargetPicker selection={targetSelection} sourceEngine={target.engine} supported={targetSupported}
      disabled={pending || attemptedSummary !== undefined} onChange={setTargetSelection} />
    <p role="status">{t(history === "loading" ? "crossSession.managedHandoffLoading" : history === "loaded" ? "crossSession.managedHandoffFullHistory" : "crossSession.managedHandoffUnavailable")}</p>
    {selection && <HandoffModelPicker workspacePath={target.workspacePath} selection={selection} onSelectionChange={setSelection}
      disabled={compressionBusy || pending || attemptedSummary !== undefined} />}
    {selectionChanged && summary && <p role="status">{t("crossSession.managedHandoffSelectionChanged")}</p>}
    {compression && <div role="status" aria-label={t("crossSession.managedHandoffCompressionStatus")}>
      <p>{t(`crossSession.managedHandoffCompression_${compression.status}`)}</p>
      <p>{t("crossSession.managedHandoffCompressionSelection", { engine: compression.selection.engine, model: compression.selection.model })}</p>
      {compression.error && <p>{compression.error}</p>}
      {["running", "unknown", "discarded"].includes(compression.status) && <p>{t("crossSession.managedHandoffCompressionDiscardHint")}</p>}
    </div>}
    {history === "loaded" && !preparingCompression && !pending && attemptedSummary === undefined && <div className="flex flex-wrap gap-2">
      {compressionBusy && compression ? <>
        <Button size="xs" variant="secondary" onClick={() => void service.inspect(compression!.handoffId).then(view => { if (view) acceptCompression(view); }).catch(cause => setError(String(cause)))}>{t("crossSession.managedHandoffCompressionRefresh")}</Button>
        <Button size="xs" variant="secondary" onClick={() => void service.discard(compression!.handoffId, compression!.requestId).then(view => { if (view) acceptCompression(view); }).catch(cause => setError(String(cause)))}>{t("crossSession.managedHandoffCompressionDiscard")}</Button>
      </> : <Button size="xs" variant="secondary" disabled={!selection} onClick={() => void compress(!!compression)}>{t(compression ? "crossSession.managedHandoffCompressionRetry" : "crossSession.managedHandoffGenerate")}</Button>}
    </div>}
    <p className="font-medium">{t("crossSession.managedHandoffPreparedContents")}</p>
    <label className="flex flex-col gap-1">
      {t("crossSession.managedHandoffSummary")}
      <textarea rows={6} value={summary} disabled={pending || attemptedSummary !== undefined} onChange={event => { edited.current = true; setSummary(event.target.value); }}
        className="w-full min-w-0 rounded-md border border-border-secondary bg-background-primary-default p-2 text-text-primary" />
    </label>
    <p>{t("crossSession.managedHandoffLimit", { count: summary.length })}</p>
    {summary.length > 0 && !valid && <p role="alert">{t("crossSession.managedHandoffInvalid")}</p>}
    <details><summary>{t("crossSession.managedHandoffOriginal")}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{record.message}</pre>
    </details>
    <p>{t("crossSession.managedHandoffImages", { count: record.imageRefs?.length ?? 0 })}</p>
    {error && <p role="alert">{error}</p>}
    {error && attemptedSummary !== undefined && <p>{t("crossSession.managedHandoffRetryHint")}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="xs" variant="primary" disabled={!valid || pending || compressionBusy} onClick={() => void submit()}>{t(pending ? "crossSession.managedHandoffSubmitting" : "crossSession.managedHandoffSubmit")}</Button>
      <Button size="xs" variant="secondary" disabled={pending} onClick={() => { closed.current = true; onCancel(); }}>{t("crossSession.managedHandoffClose")}</Button>
    </div>
  </section>;
}
