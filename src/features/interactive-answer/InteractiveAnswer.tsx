import { Component, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createParser, Renderer, type OpenUIError } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Collapsible } from "@/components/application/collapsible/collapsible";
import { answerLibrary } from "./library";
import { ANSWER_LIMITS, checkInteractiveProgram, type AnswerState } from "./protocol";
import { persistentAnswerState } from "./persistent-state";
import { answerOriginMatches, parameterFeedback } from "./feedback";
import { useScopedSessionKey } from "@/features/chat/split/session-scope";
import { insertSideAnswer } from "@/features/sidechat/insert-answer";
import "./interactive-answer.css";

class AnswerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function AnswerRenderer({ source, values, onUpdate }: { source: string; values: AnswerState; onUpdate: (values: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const [initialState] = useState(values);
  const [failed, setFailed] = useState(false);
  const onError = useCallback((errors: OpenUIError[]) => setFailed(errors.length > 0), []);
  return <>
    {failed && <p role="alert" className="text-body-2-regular text-text-error-primary">{t("interactiveAnswer.calculationError")}</p>}
    <Renderer response={source} library={answerLibrary} isStreaming={false} initialState={initialState}
      onStateUpdate={onUpdate} onError={onError} publishObservability={false} toolProvider={null} />
  </>;
}

function AnswerRuntime({ source, defaults, identity }: { source: string; defaults: AnswerState; identity?: string }) {
  const { t } = useTranslation();
  const sessionKey = useScopedSessionKey();
  const state = useMemo(() => persistentAnswerState(identity, source, defaults), [identity, source, defaults]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot);
  const [inserted, setInserted] = useState(false);
  const reloadFeedback = useActionFeedback({ spin: true });
  const feedback = identity && answerOriginMatches(identity, sessionKey)
    ? parameterFeedback(identity, view.sourceHash, view.values, t("interactiveAnswer.parameterContext")) : null;
  const failed = ["loadError", "saveError", "conflict"].includes(view.status);
  return <>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span role={failed ? "alert" : "status"} className="text-caption-1-regular text-text-secondary">{t(`interactiveAnswer.storage.${view.status}`)}</span>
      {failed && !(view.ready && view.status === "loadError") && <Button size="xs" variant="ghost" onClick={state.retry}>{t("interactiveAnswer.retryStorage")}</Button>}
      {(view.status === "conflict" || (view.ready && view.status === "loadError") || reloadFeedback.feedback !== "idle") &&
        <Button size="xs" variant="ghost" disabled={view.status === "loading" || reloadFeedback.feedback === "running"}
          onClick={() => { setInserted(false); void reloadFeedback.start(state.reloadSaved, () => state.getSnapshot().status !== "saved").catch(() => {}); }}>
          <ActionFeedbackIcon icon={RefreshCw} feedback={reloadFeedback.feedback} spin iconClassName="size-3.5" />{t("interactiveAnswer.reloadSaved")}
        </Button>}
      <Button size="xs" variant="ghost" disabled={!view.ready || view.status === "loading"} onClick={() => { state.reset(); setInserted(false); }}><RotateCcw className="size-3.5" aria-hidden />{t("interactiveAnswer.reset")}</Button>
      <Button size="xs" variant="ghost" disabled={!view.ready || !feedback} title={feedback ? undefined : t("interactiveAnswer.feedbackUnavailable")}
        onClick={() => { if (feedback) { insertSideAnswer(sessionKey, feedback); setInserted(true); } }}>{t("interactiveAnswer.continueParameters")}</Button>
      {inserted && <span role="status" className="text-caption-1-regular text-text-secondary">{t("interactiveAnswer.addedToDraft")}</span>}
      {!feedback && view.ready && <span className="text-caption-1-regular text-text-tertiary">{t("interactiveAnswer.feedbackUnavailable")}</span>}
    </div>
    {view.ready && <fieldset disabled={view.status === "loading"} className="min-w-0 border-0 p-0 m-0"><AnswerRenderer key={view.generation} source={source} values={view.values} onUpdate={state.update} /></fieldset>}
  </>;
}

/** Only complete, bounded programs reach the renderer. No model-generated host actions. */
export default function InteractiveAnswer({ source, complete, streaming, identity }: {
  source: string; complete: boolean; streaming: boolean; identity?: string;
}) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const checked = useMemo(() => {
    if (!complete) return null;
    const result = checkInteractiveProgram(source);
    if (!result.ok) return null;
    try {
      const parsed = createParser(answerLibrary.toJSONSchema(), "Stack").parse(result.source);
      return parsed.root && !parsed.meta.incomplete && !parsed.meta.errors.length && !parsed.meta.unresolved.length
        && !parsed.queryStatements.length && !parsed.mutationStatements.length ? result : null;
    } catch { return null; }
  }, [source, complete]);
  const waiting = !complete && streaming;
  const error = <p role="alert" className="text-body-2-regular text-text-secondary">{t("interactiveAnswer.invalid")}</p>;
  return <section className="interactive-answer my-3 min-w-0 overflow-hidden rounded-xl border border-border-component-detail-container bg-background-secondary-default shadow-card" aria-label={t("interactiveAnswer.title")}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-separator-border px-3.5 py-2.5">
      <span className="flex items-center gap-2 text-body-2-semibold text-text-primary"><SlidersHorizontal className="size-4 shrink-0" aria-hidden />{t("interactiveAnswer.title")}</span>
      <div className="flex items-center gap-1">
        <Button size="xs" variant="ghost" aria-expanded={showSource} onClick={() => setShowSource(value => !value)}>{t(showSource ? "interactiveAnswer.hideSource" : "interactiveAnswer.showSource")}</Button>
      </div>
    </div>
    <div className="min-w-0 p-3.5">
      {waiting ? <p role="status" className="text-body-2-regular text-text-tertiary">{t("interactiveAnswer.generating")}</p> : checked ?
        <AnswerBoundary key={JSON.stringify([identity, checked.source])} fallback={error}>
          <AnswerRuntime source={checked.source} defaults={checked.defaults} identity={identity} />
        </AnswerBoundary> : error}
    </div>
    <Collapsible open={showSource} seconds={0.2}>
      <pre className="m-0 max-h-80 overflow-auto whitespace-pre border-t border-separator-border bg-background-primary-default p-3 text-caption-1-regular text-text-secondary"><code>{source.slice(0, ANSWER_LIMITS.bytes)}</code></pre>
    </Collapsible>
  </section>;
}
