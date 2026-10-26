import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { useTranslation } from "react-i18next";
import { MessageImages } from "@/features/chat/components/MessageImages";
import { SideMarkdown, SideThinking, SideToolPills } from "@/features/sidechat/side-parts";
import { useCopied } from "@/hooks/use-copied";
import type { ConversationViewAction, ConversationViewProps, HostTaskConversationAction } from "@ccgui/plugin-sdk";
import type { Message } from "@/lib/ipc";
import { ToolPayloadViewer } from "@/features/chat/components/ToolPayloadViewer";

// Ordinary read-only timelines do not initialize native card dependencies.
const QuestionCard = lazy(() => import("@/features/chat/components/QuestionCard").then(m => ({ default: m.QuestionCard })));
const QuestionRecord = lazy(() => import("@/features/chat/components/QuestionCard").then(m => ({ default: m.QuestionRecord })));
const GrantCard = lazy(() => import("@/features/chat/components/GrantCard").then(m => ({ default: m.GrantCard })));
const PlanCardHeader = lazy(() => import("@/features/chat/components/PlanReviewCard").then(m => ({ default: m.PlanCardHeader })));

/** A renderer only. Native messages come from the owner document; this component
 * never starts a chat store, sends a prompt or replies to a permission request. */
export interface ConversationSurfaceProps extends ConversationViewProps {}
type DisplayMessage = Message & { displayText?: string };
type Projection = { workspacePath?: string; messages?: unknown[]; status?: string; error?: string; requestId?: string; revision?: number; readOnly?: boolean };
type Source = { id?: string; label?: string; conversation: Projection };
function boundedSources(sources: Source[], currentSourceId?: string) {
  if (sources.length <= 32) return sources;
  const selected = new Set(sources.slice(-32));
  const current = currentSourceId ? sources.find(source => source.id === currentSourceId) : sources.at(-1);
  if (current && !selected.has(current)) { selected.delete(sources[sources.length - 32]); selected.add(current); }
  return sources.filter(source => selected.has(source));
}
type WithoutOwner<T> = T extends unknown ? Omit<T, "expectedRevision" | "conversationRequestId"> : never;
type SourceAction = (action: WithoutOwner<HostTaskConversationAction>) => void;
const validMessage = (m: unknown): m is DisplayMessage => !!m && typeof m === "object" && "seq" in m && Number.isFinite(m.seq) && "role" in m && typeof m.role === "string" && "text" in m && typeof m.text === "string";
/** Head merge preserves every source's native row order, even for missing or
 * regressing native timestamps. No fabricated timestamps enter the projection. */
export function mergeConversationSources(sources: Source[]) {
  const streams = boundedSources(sources).map(source => ({ source, rows: (Array.isArray(source.conversation.messages) ? source.conversation.messages.filter(validMessage) : []).slice(-1000), at: 0 }));
  const rows: Array<{ source: Source; message: DisplayMessage }> = [];
  while (streams.some(s => s.at < s.rows.length)) {
    let pick = -1;
    for (let i = 0; i < streams.length; i++) {
      if (streams[i].at >= streams[i].rows.length) continue;
      if (pick < 0) { pick = i; continue; }
      const a = streams[i].rows[streams[i].at].ts;
      const b = streams[pick].rows[streams[pick].at].ts;
      const ta = typeof a === "string" ? Date.parse(a) : NaN, tb = typeof b === "string" ? Date.parse(b) : NaN;
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta < tb) pick = i;
    }
    const stream = streams[pick]; rows.push({ source: stream.source, message: stream.rows[stream.at++] });
  }
  return rows.slice(-1000);
}
function sameImages(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}
function CopyReply({ text }: { text: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  return <button type="button" className="mt-1 text-caption-1-regular text-text-tertiary hover:text-text-primary" onClick={() => void copy(text)}>{t(copied ? "common.copied" : "sidechat.copyAnswer")}</button>;
}

function ConversationTool({ message }: { message: DisplayMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasPayload = message.args !== undefined || message.result !== undefined;
  return <div className="min-w-0">
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <div className="min-w-0 max-w-full"><SideToolPills tools={[{ id: String(message.seq), name: message.text, path: message.path, status: message.live ? "running" : "done" }]} /></div>
      {hasPayload && <button
        type="button"
        aria-expanded={open}
        aria-label={`${message.text}: ${t(open ? "crossSession.collapseCard" : "crossSession.expandCard")}`}
        onClick={() => setOpen(value => !value)}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md text-caption-1-medium text-text-tertiary outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <ChevronRight aria-hidden className={`size-3.5 transition-transform duration-150${open ? " rotate-90" : ""}`} />
        <span>{t(open ? "crossSession.collapseCard" : "crossSession.expandCard")}</span>
      </button>}
    </div>
    {hasPayload && open && <ToolPayloadViewer toolName={message.text} path={message.path} args={message.args} result={message.result} />}
  </div>;
}

const ConversationMessage = memo(function ConversationMessage({ message, workspacePath, onOpenFile, onAction, writable }: {
  message: DisplayMessage; workspacePath: string; onOpenFile: (path: string) => void; onAction: SourceAction; writable: boolean;
}) {
  const { t } = useTranslation();
  if (message.question) {
    if (writable && message.question.status === "pending" && !message.question.codexApproval) return <div>
      <fieldset disabled={message.question.submitting === true}>
        <QuestionCard message={message} onAnswer={answers => onAction({ type: "answerQuestion", seq: message.seq, runId: message.question!.runId, requestId: message.question!.requestId, answers })} />
      </fieldset>
      {message.question.error && <p role="alert">{message.question.error}</p>}
    </div>;
    return <div><QuestionRecord message={message} />{writable && message.question.status === "pending" && <button type="button" onClick={() => onAction({ type: "openNative" })}>{t("leader.openChild")}</button>}</div>;
  }
  if (message.grant) return <GrantCard message={message} readOnly={!writable} onAnswer={accept => onAction({ type: "answerGrant", seq: message.seq, accept })} />;
  if (message.planReview) return <div>
    <PlanCardHeader record={message.planReview} />
    <SideMarkdown text={message.planReview.content} workspacePath={workspacePath} streaming={false} onOpenFile={onOpenFile} />
    {writable && ["awaiting_review", "deferred", "submitting"].includes(message.planReview.status) && <button type="button" onClick={() => onAction({ type: "openNative" })}>{t("leader.openChild")}</button>}
  </div>;
  if (message.role === "user") {
    const images = Array.isArray(message.images) ? message.images.filter((img): img is string => typeof img === "string" && img.trim().length > 0) : [];
    return (
      <div className="max-w-[95%] self-end whitespace-pre-wrap break-words rounded-lg bg-background-tertiary-default px-3 py-2 text-body-regular">
        {images.length > 0 && <MessageImages images={images} workspacePath={workspacePath} />}
        {typeof message.displayText === "string" ? message.displayText : message.text}
        {typeof message.displayText === "string" && message.displayText !== message.text && <details className="mt-2 text-caption-1-regular text-text-secondary">
          <summary className="cursor-pointer">{t("interactiveAnswer.showSource")}</summary>
          <div className="mt-1 whitespace-pre-wrap break-words">{message.text}</div>
        </details>}
      </div>
    );
  }
  if (message.role === "thinking") return <SideThinking text={message.text} streaming={message.live === true} />;
  if (message.role === "tool") return <ConversationTool message={message} />;
  if (message.role === "assistant") return <div className="min-w-0"><SideMarkdown text={message.text} workspacePath={workspacePath} streaming={message.live === true} onOpenFile={onOpenFile} />{!message.live && message.text && <CopyReply text={message.text} />}</div>;
  return message.text ? <div className="whitespace-pre-wrap text-body-regular text-text-secondary">{message.text}</div> : null;
}, (before, after) => before.workspacePath === after.workspacePath && before.onOpenFile === after.onOpenFile && before.onAction === after.onAction && before.writable === after.writable &&
  before.message.seq === after.message.seq && before.message.role === after.message.role && before.message.text === after.message.text && before.message.displayText === after.message.displayText &&
  before.message.live === after.message.live && before.message.path === after.message.path && before.message.question === after.message.question && before.message.grant === after.message.grant && before.message.planReview === after.message.planReview && before.message.args === after.message.args && before.message.result === after.message.result && sameImages(before.message.images, after.message.images));

function SourceMessage({ source, message, dispatch, readOnly }: { source: Source; message: DisplayMessage; dispatch: (sourceId: string | undefined, requestId: string | undefined, action: Parameters<SourceAction>[0]) => void; readOnly: boolean }) {
  const send = useCallback<SourceAction>(action => dispatch(source.id, source.conversation.requestId, action), [source.id, source.conversation.requestId, dispatch]);
  const open = useCallback((path: string) => send({ type: "openFile", path }), [send]);
  return <div data-conversation-source={source.id}>
    {source.label && <span className="text-caption-1-regular text-text-tertiary">{source.label}</span>}
    <Suspense fallback={<div>{message.question?.questions[0]?.question ?? message.text}</div>}>
      <ConversationMessage message={message} workspacePath={source.conversation.workspacePath ?? ""} onOpenFile={open} onAction={send}
        writable={!readOnly && !source.conversation.readOnly && typeof source.conversation.requestId === "string"} />
    </Suspense>
  </div>;
}

export const ConversationSurface = memo(function ConversationSurface({ conversation, onAction, readOnly = false }: ConversationSurfaceProps) {
  const { t } = useTranslation();
  const action = useRef(onAction); action.current = onAction;
  const projectionReadOnly = !!conversation && typeof conversation === "object" && "readOnly" in conversation && conversation.readOnly === true;
  const sources = useMemo<Source[]>(() => {
    const value = conversation as { sources?: Source[]; currentSourceId?: string } | null;
    if (Array.isArray(value?.sources)) return boundedSources(value.sources.filter(s => !!s && typeof s.id === "string" && !!s.conversation && typeof s.conversation === "object"), value.currentSourceId);
    return [{ conversation: (conversation && typeof conversation === "object" ? conversation : {}) as Projection }];
  }, [conversation]);
  const currentSources = useRef(sources); currentSources.current = sources;
  const dispatch = useCallback((sourceId: string | undefined, requestId: string | undefined, payload: Parameters<SourceAction>[0]) => {
    const source = currentSources.current.find(s => s.id === sourceId); if (!source || source.conversation.requestId !== requestId) return;
    const coordinator = typeof source.conversation.requestId === "string";
    action.current?.({ ...payload, ...(sourceId !== undefined ? { sourceId } : {}), ...(coordinator ? { conversationRequestId: source.conversation.requestId, expectedRevision: source.conversation.revision } : {}) } as ConversationViewAction);
  }, []);
  const messages = useMemo(() => mergeConversationSources(sources), [sources]);
  const running = sources.some(s => s.conversation.status === "starting" || s.conversation.status === "running");
  return <div className="flex min-w-0 flex-col gap-3" role="log" aria-label={t("sidechat.sidechatTitle")} aria-busy={running}>
    {messages.map(({ source, message }) => <SourceMessage key={`${source.id ?? "single"}:${source.conversation.requestId ?? "discussion"}:${message.seq}`} source={source} message={message} dispatch={dispatch} readOnly={readOnly || projectionReadOnly || !onAction} />)}
    {running && <p role="status" className="text-caption-1-regular text-text-tertiary">{t("sidechat.thinkingLive")}</p>}
    {sources.filter(s => typeof s.conversation.error === "string" && s.conversation.error).map(s => <p key={s.id ?? "single"} role="alert" className="whitespace-pre-wrap text-body-regular text-text-error-primary">{s.label ? `${s.label}: ` : ""}{s.conversation.error}</p>)}
  </div>;
});
