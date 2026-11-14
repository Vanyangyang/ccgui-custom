import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import { useTranslation } from "react-i18next";
import { MessageImages } from "@/features/chat/components/MessageImages";
import { SideMarkdown, SideThinking, SideToolPills } from "@/features/sidechat/side-parts";
import { useCopied } from "@/hooks/use-copied";
import type { ConversationViewAction, ConversationViewProps, HostTaskConversationAction } from "@ccgui/plugin-sdk";
import type { Message } from "@/lib/ipc";
import { ToolPayloadViewer } from "@/features/chat/components/ToolPayloadViewer";
import { ConversationRows, type ConversationRowLayout } from "./ConversationRows";

// Ordinary read-only timelines do not initialize native card dependencies.
const QuestionCard = lazy(() => import("@/features/chat/components/QuestionCard").then(m => ({ default: m.QuestionCard })));
const QuestionRecord = lazy(() => import("@/features/chat/components/QuestionCard").then(m => ({ default: m.QuestionRecord })));
const GrantCard = lazy(() => import("@/features/chat/components/GrantCard").then(m => ({ default: m.GrantCard })));
const PlanCardHeader = lazy(() => import("@/features/chat/components/PlanReviewCard").then(m => ({ default: m.PlanCardHeader })));

/** A renderer only. Native messages come from the owner document; this component
 * never starts a chat store, sends a prompt or replies to a permission request. */
export interface ConversationSurfaceProps extends ConversationViewProps {}
type DisplayMessage = Message & { displayText?: string };
type Projection = { threadId?: string; workspacePath?: string; messages?: unknown[]; status?: string; nativeStatus?: string; error?: string; requestId?: string; sessionRef?: unknown; revision?: number; readOnly?: boolean };
type Source = { id?: string; label?: string; conversation: Projection };
function sourceIdentity({ id, conversation }: Source) {
  const session = conversation.sessionRef && typeof conversation.sessionRef === "object"
    ? conversation.sessionRef as Record<string, unknown> : {};
  const identity = (value: unknown) => typeof value === "string" ? value : null;
  // Scalar physical identity only: new projection objects/revisions during a
  // stream must not reset forms, disclosures, focus or measured row heights.
  return JSON.stringify([identity(id), identity(conversation.requestId), identity(conversation.threadId),
    identity(session.engine), identity(session.sessionId), identity(session.workspacePath)]);
}
type WithoutOwner<T> = T extends unknown ? Omit<T, "expectedRevision" | "conversationRequestId"> : never;
type SourceAction = (action: WithoutOwner<HostTaskConversationAction>) => void;
const validMessage = (m: unknown): m is DisplayMessage => !!m && typeof m === "object" && "seq" in m && Number.isFinite(m.seq) && "role" in m && typeof m.role === "string" && "text" in m && typeof m.text === "string";
/** Head merge preserves every source's native row order, even for missing or
 * regressing native timestamps. No fabricated timestamps enter the projection. */
export function mergeConversationSources(sources: Source[]) {
  const streams = sources.map(source => ({ source, rows: Array.isArray(source.conversation.messages) ? source.conversation.messages.filter(validMessage) : [], at: 0 }));
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
  return rows;
}
function sameImages(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}
/** Short label for a valid native timestamp; missing or invalid values stay absent. */
function replyTime(ts: unknown, locale?: string) {
  if (typeof ts !== "string") return null;
  const at = new Date(ts);
  if (!Number.isFinite(at.getTime())) return null;
  const today = at.toDateString() === new Date().toDateString();
  return { iso: ts, full: at.toLocaleString(locale), short: at.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) };
}
/** Reply metadata row, reserved while streaming so completion adds no layout
 * jump. The icon copies the raw `message.text`; it appears on hover or
 * keyboard focus, and always on touch screens (no hover). */
function ReplyMeta({ text, ts, done }: { text: string; ts: unknown; done: boolean }) {
  const { t, i18n } = useTranslation();
  const { copied, copy } = useCopied();
  // App language, not the OS locale, so a Chinese UI never shows "AM/PM".
  const time = replyTime(ts, i18n?.language);
  const label = t(copied ? "common.copied" : "sidechat.copyAnswer");
  return <div data-conversation-reply-meta="" className="mt-1 flex h-6 min-w-0 items-center gap-1.5 text-caption-1-regular text-text-tertiary">
    {time && <time dateTime={time.iso} title={time.full} aria-label={time.full} className="tabular-nums">{time.short}</time>}
    {done && <>
      <button type="button" aria-label={label} title={label} onClick={() => copy(text)}
        className={`inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-opacity duration-150 hover:bg-background-secondary-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-border-focus-ring group-hover/reply:opacity-100 [@media(hover:none)]:opacity-100 ${copied ? "opacity-100" : "opacity-0"}`}>
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
      <span role="status" className="sr-only">{copied ? t("common.copied") : ""}</span>
    </>}
  </div>;
}

function ConversationTool({ message, open, toggle }: { message: DisplayMessage; open: boolean; toggle: () => void }) {
  const { t } = useTranslation();
  const hasPayload = message.args !== undefined || message.result !== undefined;
  return <div className="min-w-0">
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <div className="min-w-0 max-w-full"><SideToolPills tools={[{ id: String(message.seq), name: message.text, path: message.path, status: message.live ? "running" : "done" }]} /></div>
      {hasPayload && <button
        type="button"
        aria-expanded={open}
        aria-label={`${message.text}: ${t(open ? "crossSession.collapseCard" : "crossSession.expandCard")}`}
        onClick={toggle}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md text-caption-1-medium text-text-tertiary outline-none transition-colors duration-150 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <ChevronRight aria-hidden className={`size-3.5 transition-transform duration-150${open ? " rotate-90" : ""}`} />
        <span>{t(open ? "crossSession.collapseCard" : "crossSession.expandCard")}</span>
      </button>}
    </div>
    {hasPayload && open && <ToolPayloadViewer toolName={message.text} path={message.path} args={message.args} result={message.result} />}
  </div>;
}

const ConversationMessage = memo(function ConversationMessage({ message, workspacePath, onOpenFile, onAction, writable, toolOpen, toggleTool }: {
  message: DisplayMessage; workspacePath: string; onOpenFile: (path: string) => void; onAction: SourceAction; writable: boolean;
  toolOpen: boolean; toggleTool: () => void;
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
      // A dedicated bubble variable lets embedders tint only this bubble; the
      // shared tertiary token (tool pills, code) stays untouched.
      <div data-conversation-bubble="user" className="w-fit min-w-0 max-w-[min(92%,max(80%,30rem))] self-end whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg [background-color:var(--conversation-user-bubble-bg,var(--color-background-tertiary-default))] px-3 py-2 text-body-regular">
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
  if (message.role === "tool") return <ConversationTool message={message} open={toolOpen} toggle={toggleTool} />;
  if (message.role === "assistant") return <div className="group/reply min-w-0"><SideMarkdown text={message.text} workspacePath={workspacePath} streaming={message.live === true} onOpenFile={onOpenFile} />{message.text && <ReplyMeta text={message.text} ts={message.ts} done={!message.live} />}</div>;
  return message.text ? <div className="whitespace-pre-wrap text-body-regular text-text-secondary">{message.text}</div> : null;
}, (before, after) => before.workspacePath === after.workspacePath && before.onOpenFile === after.onOpenFile && before.onAction === after.onAction && before.writable === after.writable && before.toolOpen === after.toolOpen && before.toggleTool === after.toggleTool &&
  before.message.seq === after.message.seq && before.message.role === after.message.role && before.message.text === after.message.text && before.message.displayText === after.message.displayText &&
  before.message.live === after.message.live && before.message.ts === after.message.ts && before.message.path === after.message.path && before.message.question === after.message.question && before.message.grant === after.message.grant && before.message.planReview === after.message.planReview && before.message.args === after.message.args && before.message.result === after.message.result && sameImages(before.message.images, after.message.images));

function SourceMessage({ source, message, segmentStart, dispatch, readOnly, rowKey, toolOpen, toggleTool, layout }: { source: Source; message: DisplayMessage; segmentStart: boolean; dispatch: (sourceId: string | undefined, requestId: string | undefined, action: Parameters<SourceAction>[0]) => void; readOnly: boolean; rowKey: string; toolOpen: boolean; toggleTool: (key: string) => void; layout?: ConversationRowLayout }) {
  const send = useCallback<SourceAction>(action => dispatch(source.id, source.conversation.requestId, action), [source.id, source.conversation.requestId, dispatch]);
  const open = useCallback((path: string) => send({ type: "openFile", path }), [send]);
  const toggle = useCallback(() => toggleTool(rowKey), [toggleTool, rowKey]);
  // A flex column lets the user bubble align right while other rows stretch.
  // `data-conversation-segment` marks source transitions for embedder styling.
  return <div {...layout} data-conversation-source={source.id} data-conversation-segment={segmentStart ? "start" : "continue"} className="flex min-w-0 flex-col">
    {segmentStart && source.label && <span data-conversation-source-label="" className="self-start text-caption-1-regular text-text-tertiary">{source.label}</span>}
    <Suspense fallback={<div>{message.question?.questions[0]?.question ?? message.text}</div>}>
      <ConversationMessage message={message} workspacePath={source.conversation.workspacePath ?? ""} onOpenFile={open} onAction={send}
        writable={!readOnly && !source.conversation.readOnly && typeof source.conversation.requestId === "string"} toolOpen={toolOpen} toggleTool={toggle} />
    </Suspense>
  </div>;
}

export const ConversationSurface = memo(function ConversationSurface({ conversation, onAction, readOnly = false }: ConversationSurfaceProps) {
  const { t } = useTranslation();
  const action = useRef(onAction); action.current = onAction;
  const projectionReadOnly = !!conversation && typeof conversation === "object" && "readOnly" in conversation && conversation.readOnly === true;
  const sources = useMemo<Source[]>(() => {
    const value = conversation as { sources?: Source[]; currentSourceId?: string } | null;
    if (Array.isArray(value?.sources)) return value.sources.filter(s => !!s && typeof s.id === "string" && !!s.conversation && typeof s.conversation === "object");
    return [{ conversation: (conversation && typeof conversation === "object" ? conversation : {}) as Projection }];
  }, [conversation]);
  const currentSources = useRef(sources); currentSources.current = sources;
  const dispatch = useCallback((sourceId: string | undefined, requestId: string | undefined, payload: Parameters<SourceAction>[0]) => {
    const source = currentSources.current.find(s => s.id === sourceId); if (!source || source.conversation.requestId !== requestId) return;
    const coordinator = typeof source.conversation.requestId === "string";
    action.current?.({ ...payload, ...(sourceId !== undefined ? { sourceId } : {}), ...(coordinator ? { conversationRequestId: source.conversation.requestId, expectedRevision: source.conversation.revision } : {}) } as ConversationViewAction);
  }, []);
  const messages = useMemo(() => mergeConversationSources(sources), [sources]);
  const identities = useMemo(() => new Map(sources.map(source => [source, sourceIdentity(source)])), [sources]);
  const keys = useMemo(() => messages.map(({ source, message }) => `${identities.get(source)}:${message.seq}`), [identities, messages]);
  const [openTools, setOpenTools] = useState<Set<string>>(() => new Set());
  const toggleTool = useCallback((key: string) => setOpenTools(previous => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
  }), []);
  useEffect(() => {
    const present = new Set(keys);
    setOpenTools(previous => [...previous].every(key => present.has(key)) ? previous : new Set([...previous].filter(key => present.has(key))));
  }, [keys]);
  // Keep pending form state alive when scrolling away. These rows retain their
  // original absolute position; they are not duplicate controls or a new dock.
  const pinned = useMemo(() => messages.flatMap(({ message }, index) =>
    message.question?.status === "pending" || message.grant?.status === "pending" ||
    (message.planReview && ["awaiting_review", "deferred", "submitting"].includes(message.planReview.status)) ? [index] : []), [messages]);
  const projection = conversation as { sources?: Source[]; currentSourceId?: string } | null;
  const activitySources = Array.isArray(projection?.sources) && typeof projection.currentSourceId === "string"
    ? sources.filter(source => source.id === projection.currentSourceId)
    : sources;
  // A coordinator's aggregate status also covers queued inputs and children.
  // Explicit current identity never falls back to history, and explicit native
  // activity is authoritative even when unknown. Legacy Chat has no nativeStatus.
  const running = activitySources.some(({ conversation: source }) => {
    if ("nativeStatus" in source) return source.nativeStatus === "busy";
    // A queued initial coordinator has no native state yet. Its aggregate
    // "starting" is not the legacy Chat generation state.
    if (typeof source.requestId === "string" && source.sessionRef === null) return false;
    return source.status === "starting" || source.status === "running";
  });
  return <ConversationRows keys={keys} pinned={pinned} label={t("sidechat.sidechatTitle")} busy={running} renderRow={(index, layout) => {
    const { source, message } = messages[index];
    return <SourceMessage key={keys[index]} rowKey={keys[index]} source={source} message={message} layout={layout} toolOpen={openTools.has(keys[index])} toggleTool={toggleTool}
      segmentStart={index === 0 || messages[index - 1].source !== source} dispatch={dispatch} readOnly={readOnly || projectionReadOnly || !onAction} />;
  }} footer={<>
    {running && <p role="status" className="text-caption-1-regular text-text-tertiary">{t("sidechat.thinkingLive")}</p>}
    {sources.filter(s => typeof s.conversation.error === "string" && s.conversation.error).map(s => <p key={s.id ?? "single"} role="alert" className="whitespace-pre-wrap text-body-regular text-text-error-primary">{s.label ? `${s.label}: ` : ""}{s.conversation.error}</p>)}
  </>} />;
});
