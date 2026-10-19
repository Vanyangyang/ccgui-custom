import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { assistantNotices, isWeb, useAssistantNoticeFeed } from "./api";
import type { AssistantNotice, AssistantNoticesStatus } from "./types";
import "./assistant-notices.css";
import { noticeTextStyle } from "./config";

function formatAsideObserver(notice: AssistantNotice, status: AssistantNoticesStatus | null | undefined, t: (key: string) => string): string {
  const observer = notice.observer ?? (status ? { engine: status.observerEngine, model: status.model || status.observerModel, effort: status.effort || status.observerEffort } : null);
  if (!observer) return t("assistantNotices.aside");
  const model = observer.engine === "agy_vertex" || observer.model === "gemini-4-argon"
    ? "Gemini 4 Argon"
    : observer.model || (CLI_DISPLAY_NAMES[observer.engine] ?? observer.engine);
  const parts = [model, observer.effort].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : t("assistantNotices.aside");
}

export function NoticeCard({ notice, status, reload, archived = false, compact = false }: { notice: AssistantNotice; status?: AssistantNoticesStatus | null; reload: () => void; archived?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const acting = useRef(false);
  const interaction = useRef({ hover: false, focus: false, held: false });
  const holdQueue = useRef({ running: false, pending: null as boolean | null });
  const renewal = useRef<ReturnType<typeof setInterval> | null>(null);
  function requestHold(held: boolean) {
    const queue = holdQueue.current;
    queue.pending = held;
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      while (queue.pending !== null) {
        const next = queue.pending;
        queue.pending = null;
        try { await assistantNotices.hold(notice.id, next); } catch { /* Native lease eventually releases a lost webview. */ }
      }
      queue.running = false;
    })();
  }
  function releaseHold() {
    if (renewal.current !== null) clearInterval(renewal.current);
    renewal.current = null;
    const wasHeld = interaction.current.held;
    interaction.current = { hover: false, focus: false, held: false };
    if (wasHeld) requestHold(false);
  }
  function hold(kind: "hover" | "focus", value: boolean) {
    const state = interaction.current;
    state[kind] = value;
    const held = state.hover || state.focus;
    if (state.held === held || notice.kind !== "aside" || archived) return;
    state.held = held;
    if (held) {
      requestHold(true);
      renewal.current = setInterval(() => requestHold(true), 5_000);
    } else {
      if (renewal.current !== null) clearInterval(renewal.current);
      renewal.current = null;
      requestHold(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      releaseHold();
    };
  }, [notice.id, notice.kind, archived]);
  async function act(action: () => Promise<unknown>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError(false);
    try { await action(); reload(); }
    catch { if (alive.current) setError(true); }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  }
  const aside = notice.kind === "aside";
  const engineTitle = CLI_DISPLAY_NAMES[notice.source.engine] ?? notice.source.engine;
  const sessionTitle = notice.source.label.trim() || notice.source.sessionId.slice(0, 8) || engineTitle;
  const badgeText = aside ? formatAsideObserver(notice, status, t) : t("assistantNotices.completed");
  const badgeTitle = aside ? `${t("assistantNotices.aside")} · ${badgeText}` : badgeText;
  return <article className="assistant-notice" aria-busy={busy}
    onMouseEnter={() => hold("hover", true)} onMouseLeave={() => hold("hover", false)}
    onFocusCapture={() => hold("focus", true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold("focus", false); }}>
    <div className="assistant-notice-source">
      <span className="assistant-notice-icon" title={engineTitle}><EngineIcon engine={notice.source.engine} size={15} /></span>
      <span className="assistant-notice-session" title={`${engineTitle} · ${sessionTitle}`}>{sessionTitle}</span>
      <span className="assistant-notice-kind" title={badgeTitle}>{badgeText}</span>
    </div>
    {aside ? <>
      <button type="button" className="assistant-notice-tease" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{notice.tease || t("assistantNotices.expand")}</button>
      {expanded && <p className="assistant-notice-body">{notice.body}</p>}
    </> : !compact && <button type="button" className="assistant-notice-open" disabled={busy} aria-label={t("assistantNotices.open")} onClick={() => { void act(() => assistantNotices.open(notice.id, "open")); }}><p className="assistant-notice-body assistant-notice-clamp">{notice.body || notice.tease}</p></button>}
    <div className="assistant-notice-actions">
      {aside && !archived && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(() => assistantNotices.pin(notice.id, !notice.pinned)); }}>{t(notice.pinned ? "assistantNotices.unpin" : "assistantNotices.pin")}</Button>}
      {!archived && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(async () => { if (await assistantNotices.read(notice.id)) releaseHold(); }); }}>{t("assistantNotices.dismiss")}</Button>}
      {aside && archived && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { void act(() => assistantNotices.open(notice.id, "open")); }}>{t("assistantNotices.open")}</Button>}
      <Button size="xs" variant="secondary" disabled={busy} onClick={() => { void act(() => assistantNotices.open(notice.id, aside ? "draft" : "open")); }}>{t(aside ? "assistantNotices.draft" : "assistantNotices.open")}</Button>
    </div>
    {error && <p role="alert" className="assistant-notice-error">{t("assistantNotices.actionError")}</p>}
  </article>;
}

/** Keep large unread backlogs accessible without mounting hundreds of action rows. */
export function CompletionList({ notices, status, reload }: { notices: AssistantNotice[]; status?: AssistantNoticesStatus | null; reload: () => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(notices.length / 10));
  const currentPage = Math.min(page, pages - 1);
  return <div className="assistant-notices-recent-list">
    {notices.slice(currentPage * 10, currentPage * 10 + 10).map(notice => <NoticeCard key={notice.id} notice={notice} status={status} reload={reload} compact />)}
    {pages > 1 && <nav className="assistant-notices-pagination" aria-label={t("assistantNotices.completions")}>
      <Button size="xs" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("assistantNotices.previous")}</Button>
      <span>{t("assistantNotices.page", { page: currentPage + 1, pages })}</span>
      <Button size="xs" variant="ghost" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>{t("assistantNotices.next")}</Button>
    </nav>}
  </div>;
}

export function NoticeFeedFeedback({ error, retry, errorKey = "assistantNotices.loadError", retryLabelKey = "assistantNotices.retry" }: { error: boolean; retry: () => Promise<void>; errorKey?: string; retryLabelKey?: string }) {
  const { t } = useTranslation();
  const feedback = useActionFeedback({ spin: true });
  if (!error && feedback.feedback === "idle") return null;
  return <div className="assistant-notice-error">
    {error && <p role="alert">{t(errorKey)}</p>}
    <Button size="xs" variant="ghost" disabled={feedback.feedback === "running"} onClick={() => { void feedback.start(retry).catch(() => {}); }}>
      <ActionFeedbackIcon icon={RefreshCw} feedback={feedback.feedback} spin iconClassName="size-3.5" />{t(retryLabelKey)}
    </Button>
  </div>;
}

export function AssistantNoticesOverlay() {
  const { t } = useTranslation();
  const feed = useAssistantNoticeFeed("list");
  const notices = feed.notices.filter(notice => !notice.read);
  const [dragError, setDragError] = useState(false);
  const error = feed.error || dragError;
  const [showCompletions, setShowCompletions] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pointerQueue = useRef({ running: false, pending: null as boolean | null });
  const measureContent = useRef<() => void>(() => {});
  function pointer(interactive: boolean) {
    const queue = pointerQueue.current;
    queue.pending = interactive;
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      while (queue.pending !== null) {
        const next = queue.pending;
        queue.pending = null;
        try { await assistantNotices.pointer(next); } catch { /* Native hit testing remains authoritative. */ }
      }
      queue.running = false;
    })();
  }
  useEffect(() => {
    if (isWeb) return;
    let disposed = false;
    const elements = [document.documentElement, document.body, document.getElementById("root")].filter((element): element is HTMLElement => !!element);
    const originals = elements.map(element => [element, element.style.background, element.style.backgroundColor] as const);
    for (const element of elements) element.style.background = "transparent";
    let lastHeight = -1;
    const measure = () => {
      if (disposed || !root.current) return;
      const stack = root.current.querySelector<HTMLElement>(".assistant-notices-stack");
      const naturalHeight = root.current.getBoundingClientRect().height + (stack ? stack.scrollHeight - stack.clientHeight : 0);
      const height = Math.max(1, Math.min(window.screen.availHeight || 1080, Math.ceil(naturalHeight)));
      if (height !== lastHeight) { lastHeight = height; void assistantNotices.size(height).catch(() => {}); }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const contentObserver = new MutationObserver(measure);
    measureContent.current = measure;
    if (root.current) {
      observer?.observe(root.current);
      contentObserver.observe(root.current, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener("resize", measure);
    measure();
    return () => {
      disposed = true;
      measureContent.current = () => {};
      observer?.disconnect();
      contentObserver.disconnect();
      window.removeEventListener("resize", measure);
      pointer(false);
      for (const [element, background, backgroundColor] of originals) { element.style.background = background; element.style.backgroundColor = backgroundColor; }
    };
  }, []);
  useEffect(() => { measureContent.current(); }, [notices, error, feed.status]);
  useEffect(() => { if (!isWeb && notices.length === 0 && !error) pointer(false); }, [notices.length, error]);
  if (isWeb) return null;
  const completions = notices.filter(notice => notice.kind === "completion").sort((a, b) => b.createdAtMs - a.createdAtMs);
  const asides = notices.filter(notice => notice.kind === "aside").sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 2);
  return <div ref={root} className="assistant-notices-overlay" style={noticeTextStyle(feed.status)}>
    {(notices.length > 0 || error) && <div className="assistant-notices-surface" onMouseEnter={() => pointer(true)} onMouseLeave={() => pointer(false)}>
      <header className="assistant-notices-toolbar"><span>{t("assistantNotices.title")}</span><Button size="xs" variant="ghost" aria-label={t("assistantNotices.drag")} onPointerDown={event => { if (event.button === 0) void assistantNotices.drag().catch(() => setDragError(true)); }}>{t("assistantNotices.drag")}</Button></header>
      <div className="assistant-notices-stack" role="region" aria-label={t("assistantNotices.title")} tabIndex={0}>
        {completions[0] && <NoticeCard key={completions[0].id} notice={completions[0]} status={feed.status} reload={feed.reload} />}
        {completions.length > 1 && <div className="assistant-notices-more">
          <Button size="xs" variant="ghost" aria-expanded={showCompletions} onClick={() => setShowCompletions(value => !value)}>{t("assistantNotices.moreCompletions", { count: completions.length - 1 })}</Button>
          {showCompletions && <CompletionList notices={completions.slice(1)} status={feed.status} reload={feed.reload} />}
        </div>}
        {asides.map(notice => <NoticeCard key={notice.id} notice={notice} status={feed.status} reload={feed.reload} />)}
      </div>
      <NoticeFeedFeedback error={error} retry={async () => { setDragError(false); await feed.retry(); }} />
    </div>}
  </div>;
}
