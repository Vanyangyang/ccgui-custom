import { invoke, listen, isWeb } from "@/lib/transport";
import { useChatStore } from "@/features/chat/store";
import type { ActiveSession } from "@/features/chat/store/persistence";
import type { SessionMeta } from "@/lib/ipc";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { chatHostVisible, subscribeChatHostPresence } from "./host-presence";
import { insertSideAnswer } from "@/features/sidechat/insert-answer";
import { sessionKey } from "@/features/chat/store/persistence";
import i18n from "@/lib/i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AssistantNoticeSource } from "./types";

export interface AssistantNoticeFocusRequest { id: string; documentId: string; noticeId: string; engine: string; sessionId: string; workspacePath: string; action: "open" | "draft"; text?: string }
interface HostChatState { openTabs: ActiveSession[]; active: ActiveSession | null; sessions: Pick<SessionMeta, "engine" | "sessionId" | "workspacePath" | "customTitle" | "title">[]; selectSession(engine: string, id: string, workspace: string): Promise<void> }
export interface AssistantNoticesRuntimeDependencies {
  web: boolean; invoke: typeof invoke; listen: typeof listen;
  store: { getState(): HostChatState; subscribe(fn: (state: HostChatState, previous: HostChatState) => void): () => void };
  visible(): boolean; subscribePresence(fn: () => void): () => void;
  dismiss(): void; window: Window; document: Document;
  insertDraft(sessionKey: string, text: string): void;
  language: { language?: string; on?(event: "languageChanged", callback: () => void): unknown; off?(event: "languageChanged", callback: () => void): unknown };
  windowLabel?(): string | undefined;
}
const runtimes = new WeakMap<Document, () => void>();
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id);
const engines = new Set(["claude", "codex", "agy", "cursor", "pi", "omp", "kimi", "grok", "opencode"]);
function validSource(source: { engine: string; sessionId: string | null; workspacePath: string }): boolean {
  return engines.has(source.engine) && typeof source.sessionId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(source.sessionId)
    && typeof source.workspacePath === "string" && source.workspacePath.length > 0 && new TextEncoder().encode(source.workspacePath).length <= 4096
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(source.workspacePath);
}
const sourceKey = (s: { engine: string; sessionId: string | null; workspacePath: string }) => JSON.stringify([s.engine, s.sessionId, s.workspacePath]);
function cleanLabel(raw: string): string {
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()).slice(0, 200).join("");
}
export function assistantNoticeSources(state: HostChatState): { sources: AssistantNoticeSource[]; active: AssistantNoticeSource | null } {
  const seen = new Set<string>();
  const sources: AssistantNoticeSource[] = [];
  for (const tab of [state.active, ...state.openTabs]) {
    if (!tab || !validSource(tab) || seen.has(sourceKey(tab)) || sources.length >= 64) continue;
    seen.add(sourceKey(tab));
    const meta = state.sessions.find(s => sourceKey(s) === sourceKey(tab));
    const label = cleanLabel(meta?.customTitle || meta?.title || "") || tab.sessionId!.slice(0, 8);
    sources.push({ engine: tab.engine, sessionId: tab.sessionId!, workspacePath: tab.workspacePath, label });
  }
  return { sources, active: state.active ? sources.find(s => sourceKey(s) === sourceKey(state.active!)) ?? null : null };
}

/** Attach once per document; only bounded source metadata crosses this boundary. */
export function startAssistantNoticesRuntime(overrides: Partial<AssistantNoticesRuntimeDependencies> = {}): () => void {
  const deps: AssistantNoticesRuntimeDependencies = { web: isWeb, invoke, listen, store: useChatStore,
    visible: chatHostVisible, subscribePresence: subscribeChatHostPresence, dismiss: dismissCenterSurfaces, window, document,
    insertDraft: insertSideAnswer, language: i18n, windowLabel: () => { try { return getCurrentWindow().label; } catch { return undefined; } }, ...overrides };
  if (deps.web) return () => {};
  if (/^#\/(assistant-notices|pet-overlay)(?:[/?]|$)/.test(deps.window.location.hash)
    || ["assistant-notices", "pet-overlay"].includes(deps.windowLabel?.() ?? "")) return () => {};
  const existing = runtimes.get(deps.document);
  if (existing) return existing;
  let disposed = false, documentId = "", syncing = false, scheduled = false, pendingAttention = false, dirty = false;
  let stopFocus: (() => void) | undefined;
  let connecting = false;
  let lastSync: Promise<unknown> = Promise.resolve();
  let activeFocus: string | null = null;
  const recent = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const frames = new Map<number, () => void>();
  const locale = () => /^zh(?:-|$)/i.test(deps.language.language ?? "") ? "zh-CN" : "en";
  const attentive = () => deps.visible() && ["", "#", "#/"].includes(deps.window.location.hash)
    && deps.document.visibilityState === "visible" && deps.document.hasFocus()
    && !Array.from(deps.document.querySelectorAll('[aria-modal="true"],dialog[open]')).some(el => !el.closest('[hidden],[aria-hidden="true"]'));
  const payload = (attentionEvent: boolean) => {
    const current = assistantNoticeSources(deps.store.getState());
    const focused = attentive();
    return { documentId, sources: current.sources, active: focused ? current.active : null, attentive: focused && !!current.active, attentionEvent, locale: locale() };
  };
  async function flush() {
    scheduled = false;
    if (disposed || !documentId || !stopFocus || syncing || !dirty) return;
    syncing = true; dirty = false;
    const data = payload(pendingAttention); pendingAttention = false;
    try { lastSync = deps.invoke("assistant_notices_sync", data); await lastSync; } catch { /* Native status owns connection errors; retry on next event/heartbeat. */ }
    finally { syncing = false; if (!disposed && dirty) schedule(false); }
  }
  function schedule(attentionEvent: boolean) {
    if (disposed) return;
    dirty = true; pendingAttention ||= attentionEvent;
    if (!scheduled) { scheduled = true; queueMicrotask(() => { void flush(); }); }
  }
  const changed = () => schedule(true);
  const languageChanged = () => schedule(false);
  deps.language.on?.("languageChanged", languageChanged);
  const stopStore = deps.store.subscribe((state, previous) => {
    if (state.openTabs !== previous.openTabs || state.active !== previous.active) schedule(true);
    else if (state.sessions !== previous.sessions) {
      // Session summaries can update per token; compare only advertised metadata.
      if (JSON.stringify(assistantNoticeSources(state)) !== JSON.stringify(assistantNoticeSources(previous))) schedule(false);
    }
  });
  const stopPresence = deps.subscribePresence(changed);
  for (const event of ["focus", "blur", "hashchange"]) deps.window.addEventListener(event, changed);
  for (const event of ["visibilitychange", "focusin", "focusout"]) deps.document.addEventListener(event, changed);
  let lastAttentive = attentive();
  const observer = new MutationObserver(() => { const next = attentive(); if (next !== lastAttentive) { lastAttentive = next; changed(); } });
  observer.observe(deps.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "open", "hidden", "aria-hidden"] });
  const heartbeat = setInterval(() => { void connect(); schedule(false); }, 10_000);
  function ack(requestId: string, success: boolean) {
    if (!disposed) void deps.invoke("assistant_notices_focus_ack", { documentId, requestId, success }).catch(() => {});
  }
  async function focus(request: AssistantNoticeFocusRequest) {
    if (disposed || !documentId || !request || request.documentId !== documentId || !validId(request.id)) return;
    if (!validId(request.noticeId) || !validSource(request) || !["open", "draft"].includes(request.action)
      || (request.action === "draft" && (typeof request.text !== "string" || !request.text.trim() || Array.from(request.text).length > 6000))) { ack(request.id, false); return; }
    const now = Date.now();
    for (const [id, expiry] of recent) if (expiry <= now) recent.delete(id);
    if (recent.has(request.id)) return;
    if (recent.size >= 64) { ack(request.id, false); return; }
    recent.set(request.id, now + 7000);
    if (activeFocus) { ack(request.id, false); return; }
    activeFocus = request.id;
    let expired = false;
    const expiry = setTimeout(() => { timers.delete(expiry); expired = true; ack(request.id, false); }, 6500);
    timers.add(expiry);
    try {
      deps.dismiss();
      deps.window.location.hash = "#/";
      await deps.store.getState().selectSession(request.engine, request.sessionId, request.workspacePath);
      if (disposed || expired) return;
      // The native show/focus call and React's visible surface commit can trail
      // the event. Wait briefly for observable focus, never infer success from selection.
      const focusDeadline = Math.min(now + 6500, Date.now() + 1000);
      let success = false;
      do {
        await new Promise<void>(resolve => {
          const frame = deps.window.requestAnimationFrame(() => { frames.delete(frame); resolve(); });
          frames.set(frame, resolve);
        });
        if (disposed || expired) return;
        const active = deps.store.getState().active;
        success = Date.now() < focusDeadline && !!active && sourceKey(active) === sourceKey(request) && attentive();
      } while (!success && Date.now() < focusDeadline);
      if (disposed || expired) return;
      success &&= Date.now() - now < 6500;
      if (success && request.action === "draft") deps.insertDraft(sessionKey(request.engine, request.sessionId, request.workspacePath), request.text!);
      ack(request.id, success && Date.now() - now < 6500);
      schedule(true);
    } catch { if (!expired) ack(request.id, false); }
    finally { clearTimeout(expiry); timers.delete(expiry); if (activeFocus === request.id) activeFocus = null; }
  }
  async function connect(initialAttention = false) {
    if (disposed || connecting || stopFocus) return;
    connecting = true;
    try {
      // Retry only the missing stage: a failed listener must not mint another
      // native document lease. The heartbeat bounds retries to once per 10s.
      if (!documentId) documentId = await deps.invoke<string>("assistant_notices_attach");
      if (disposed) { await deps.invoke("assistant_notices_sync", { documentId, sources: [], active: null, attentive: false, attentionEvent: false, locale: locale() }); return; }
      const stop = await deps.listen<AssistantNoticeFocusRequest>("assistant-notices://focus-request", event => { void focus(event.payload); });
      if (disposed) stop(); else { stopFocus = stop; schedule(initialAttention); }
    } catch { /* Retry this missing stage on the next heartbeat; startup remains usable. */ }
    finally { connecting = false; }
  }
  void connect(true);
  function stopRuntime() {
    if (disposed) return;
    disposed = true; dirty = false;
    if (runtimes.get(deps.document) === stopRuntime) runtimes.delete(deps.document);
    clearInterval(heartbeat); timers.forEach(clearTimeout); timers.clear();
    frames.forEach((resolve, frame) => { deps.window.cancelAnimationFrame(frame); resolve(); }); frames.clear();
    stopStore(); stopPresence(); stopFocus?.(); observer.disconnect();
    deps.language.off?.("languageChanged", languageChanged);
    for (const event of ["focus", "blur", "hashchange"]) deps.window.removeEventListener(event, changed);
    for (const event of ["visibilitychange", "focusin", "focusout"]) deps.document.removeEventListener(event, changed);
    deps.window.removeEventListener("pagehide", stopRuntime);
    // Native document guard prevents an old document from clearing a newer lease.
    if (documentId) void lastSync.catch(() => {}).then(() => deps.invoke("assistant_notices_sync", { documentId, sources: [], active: null, attentive: false, attentionEvent: false, locale: locale() })).catch(() => {});
  }
  deps.window.addEventListener("pagehide", stopRuntime);
  runtimes.set(deps.document, stopRuntime);
  return stopRuntime;
}
