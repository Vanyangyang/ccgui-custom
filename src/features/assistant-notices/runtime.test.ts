import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ReminderPopover } from "./ReminderPopover";
import { invoke as uiInvoke, listen as uiListen } from "@/lib/transport";
import { assistantNoticeSources, startAssistantNoticesRuntime, type AssistantNoticesRuntimeDependencies, type AssistantNoticeFocusRequest } from "./runtime";
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), listen: vi.fn(), isWeb: false }));
const fixture = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => fixture.state } }));
vi.mock("@/lib/i18n", () => ({ default: { language: "en" } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/chat/center-surfaces", () => ({ dismissCenterSurfaces: vi.fn() }));
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const source = { engine: "codex", sessionId: "abc", workspacePath: "/work" };
const request = (id = "r1"): AssistantNoticeFocusRequest => ({ ...source, id, documentId: "doc", noticeId: "notice-1", action: "open" });
const stops: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); window.location.hash = "#/"; vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(async () => { stops.splice(0).forEach(stop => stop()); await settle(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });
function setup(overrides: Partial<AssistantNoticesRuntimeDependencies> = {}) {
  let handler: ((event: { payload: AssistantNoticeFocusRequest }) => void) | undefined;
  let changed: ((next: typeof state, previous: typeof state) => void) | undefined;
  let presence: (() => void) | undefined;
  let visible = true;
  const state = { active: source, openTabs: [source], sessions: [{ ...source, customTitle: "Custom", title: "Secret prompt" }], selectSession: vi.fn(async () => {}),
    drafts: { "codex/abc": "草稿🙂" } as Record<string, string>, send: vi.fn(), setDraft: vi.fn((key: string, text: string) => { state.drafts[key] = text; }) };
  fixture.state = state;
  const invoke = vi.fn(async (command: string) => command === "assistant_notices_attach" ? "doc" : undefined);
  const unlisten = vi.fn(), unsubscribe = vi.fn(), unpresence = vi.fn();
  const listen = vi.fn(async (_name: string, callback: typeof handler) => { handler = callback; return unlisten; });
  const deps = { web: false, invoke, listen, store: { getState: () => state, subscribe: (fn: typeof changed) => { changed = fn; return unsubscribe; } },
    visible: () => visible, subscribePresence: (fn: () => void) => { presence = fn; return unpresence; }, dismiss: vi.fn(), window, document, windowLabel: () => "main", ...overrides } as unknown as AssistantNoticesRuntimeDependencies;
  const stop = startAssistantNoticesRuntime(deps); stops.push(stop);
  return { state, invoke, listen, stop, deps, unlisten, unsubscribe, unpresence, fire: (r = request()) => handler?.({ payload: r }),
    change: () => changed?.(state, { ...state, active: { ...source, sessionId: "old" } }),
    token: () => changed?.(state, { ...state, sessions: [...state.sessions] }),
    visible: (value: boolean) => { visible = value; presence?.(); } };
}
describe("Assistant notices native lifecycle", () => {
  it.each(["open", "draft"] as const)("confirms %s from the real React Aria reminder popover", async action => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const env = setup(); await settle();
    const completion = { id: "notice-1", kind: action === "draft" ? "aside" : "completion", source: { ...source, label: "Source" }, turnId: "turn", createdAtMs: 1, startedAtMs: 0, tease: "Ready", body: "Done", pinned: false, expiresAtMs: null, read: false };
    const opened = Promise.withResolvers<void>();
    vi.mocked(uiListen).mockResolvedValue(() => {});
    vi.mocked(uiInvoke).mockImplementation((async (command: string) => {
      if (command === "assistant_notices_history") return [completion];
      if (command === "assistant_notices_status") return { enabled: true };
      if (command === "assistant_notices_open") { env.fire({ ...request(), action, text: action === "draft" ? completion.body : undefined }); return opened.promise; }
    }) as typeof uiInvoke);
    env.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
      if (command === "assistant_notices_focus_ack") {
        if ((args[0] as { success: boolean }).success) opened.resolve();
        else opened.reject(new Error("Focus verification failed"));
      }
      return command === "assistant_notices_attach" ? "doc" : undefined;
    });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(ReminderPopover)); });
      await act(async () => { container.querySelector("button")!.click(); });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      // React Aria hides outside content, but this Popover does not emit an
      // aria-modal attribute; it must not be mistaken for the runtime's gate.
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();
      const button = Array.from(document.querySelectorAll("button")).find(node => node.textContent === `assistantNotices.${action}`)!;
      await act(async () => { button.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ success: true }));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(env.state.setDraft).toHaveBeenCalledTimes(action === "draft" ? 1 : 0);
    } finally {
      await act(async () => { root.unmount(); }); container.remove();
    }
  });
  it("does no IPC or subscriptions on web", async () => {
    const env = setup({ web: true }); await settle();
    expect(env.invoke).not.toHaveBeenCalled(); expect(env.listen).not.toHaveBeenCalled();
  });
  it("advertises bounded stable sources with session title and short-id fallbacks", () => {
    const state = { active: source, openTabs: Array.from({ length: 100 }, (_, n) => ({ ...source, sessionId: `s${n}` })), sessions: [{ ...source, customTitle: null, title: "Auto session title" }], selectSession: async () => {} };
    const payload = assistantNoticeSources(state);
    expect(payload.sources).toHaveLength(64);
    expect(payload.active?.label).toBe("Auto session title");
    expect(payload.sources[1]?.label).toBe("s0");
    expect(assistantNoticeSources({ ...state, active: { ...source, sessionId: "../bad" }, openTabs: [] }).sources).toEqual([]);
  });
  it("coalesces and serializes source sync, without per-token sync or heartbeat attention", async () => {
    const gate = Promise.withResolvers<void>(); let syncs = 0;
    const invoke = vi.fn(async (command: string) => { if (command === "assistant_notices_attach") return "doc"; if (command === "assistant_notices_sync" && ++syncs === 1) await gate.promise; });
    const env = setup({ invoke: invoke as AssistantNoticesRuntimeDependencies["invoke"] }); await settle();
    env.change(); env.change(); env.visible(false); await settle();
    expect(syncs).toBe(1);
    gate.resolve(); await settle(); expect(syncs).toBe(2);
    env.token(); env.token(); await settle(); expect(syncs).toBe(2);
    expect(invoke.mock.calls.filter(c => c[0] === "assistant_notices_sync").length).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ attentive: false, active: null, attentionEvent: false }));
  });
  it("acks only exact document, active session, visible focused chat after selection", async () => {
    const env = setup(); await settle();
    env.fire({ ...request(), documentId: "other" }); await settle();
    expect(env.state.selectSession).not.toHaveBeenCalled();
    env.fire(); await settle(); await vi.advanceTimersByTimeAsync(20);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", { documentId: "doc", requestId: "r1", success: true });
    env.fire(); await settle(); expect(env.state.selectSession).toHaveBeenCalledTimes(1);
    env.state.active = { ...source, sessionId: "wrong" };
    env.fire(request("wrong")); await settle(); await vi.advanceTimersByTimeAsync(1020);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ requestId: "wrong", success: false }));
    env.state.active = source; env.visible(false);
    env.fire(request("hidden")); await settle(); await vi.advanceTimersByTimeAsync(1020);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ requestId: "hidden", success: false }));
    env.visible(true); const modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.appendChild(modal);
    env.fire(request("modal")); await settle(); await vi.advanceTimersByTimeAsync(1020);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ requestId: "modal", success: false }));
    modal.remove(); vi.mocked(document.hasFocus).mockReturnValue(false);
    env.fire(request("blurred")); await settle(); await vi.advanceTimersByTimeAsync(1020);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ requestId: "blurred", success: false }));
  });
  it("waits briefly for native focus and React surface visibility before acknowledging", async () => {
    const env = setup(); await settle();
    vi.mocked(document.hasFocus).mockReturnValue(false); env.visible(false);
    env.fire(); await settle(); await vi.advanceTimersByTimeAsync(100);
    expect(env.invoke.mock.calls.some(c => c[0] === "assistant_notices_focus_ack")).toBe(false);
    vi.mocked(document.hasFocus).mockReturnValue(true); env.visible(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ success: true }));
  });
  it("expires focus within seven seconds and ignores late completion", async () => {
    const env = setup(); await settle(); const gate = Promise.withResolvers<void>(); env.state.selectSession.mockReturnValue(gate.promise);
    env.fire(); await settle(); await vi.advanceTimersByTimeAsync(6500);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ success: false }));
    gate.resolve(); await settle(); await vi.advanceTimersByTimeAsync(20);
    expect(env.invoke.mock.calls.filter(c => c[0] === "assistant_notices_focus_ack")).toHaveLength(1);
  });
  it("cleans subscriptions and a late listen on teardown", async () => {
    const late = Promise.withResolvers<() => void>(); const unlisten = vi.fn();
    const env = setup({ listen: vi.fn(() => late.promise) as unknown as AssistantNoticesRuntimeDependencies["listen"] }); await settle();
    env.stop(); late.resolve(unlisten); await settle();
    expect(unlisten).toHaveBeenCalledOnce(); expect(env.unsubscribe).toHaveBeenCalledOnce(); expect(env.unpresence).toHaveBeenCalledOnce();
    expect(env.invoke).toHaveBeenLastCalledWith("assistant_notices_sync", { documentId: "doc", sources: [], active: null, attentive: false, attentionEvent: false, locale: "en" });
    const calls = env.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); window.dispatchEvent(new Event("focus")); await settle();
    expect(env.invoke).toHaveBeenCalledTimes(calls);
  });
  it("serializes final inactive sync after an in-flight sync when the document unloads", async () => {
    const gate = Promise.withResolvers<void>(); let first = true;
    const invoke = vi.fn(async (command: string) => {
      if (command === "assistant_notices_attach") return "doc";
      if (command === "assistant_notices_sync" && first) { first = false; await gate.promise; }
    });
    setup({ invoke: invoke as AssistantNoticesRuntimeDependencies["invoke"] }); await settle();
    window.dispatchEvent(new Event("pagehide")); await settle();
    expect(invoke.mock.calls.filter(c => c[0] === "assistant_notices_sync")).toHaveLength(1);
    gate.resolve(); await settle();
    expect(invoke).toHaveBeenLastCalledWith("assistant_notices_sync", { documentId: "doc", sources: [], active: null, attentive: false, attentionEvent: false, locale: "en" });
  });
  it("deactivates a document attached after disposal without installing listeners", async () => {
    const attached = Promise.withResolvers<string>();
    const invoke = vi.fn((command: string) => command === "assistant_notices_attach" ? attached.promise : Promise.resolve());
    const env = setup({ invoke: invoke as AssistantNoticesRuntimeDependencies["invoke"] }); env.stop();
    attached.resolve("late-doc"); await settle();
    expect(env.listen).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ documentId: "late-doc", attentive: false }));
  });
  it("recovers a failed attach on the heartbeat without manufacturing an attention event", async () => {
    let attempts = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "assistant_notices_attach") {
        if (++attempts === 1) throw new Error("Native startup not ready");
        return "doc";
      }
    });
    const env = setup({ invoke: invoke as AssistantNoticesRuntimeDependencies["invoke"] }); await settle();
    expect(env.listen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9999); expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2); expect(env.listen).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ documentId: "doc", attentive: true, attentionEvent: false }));
    await vi.advanceTimersByTimeAsync(20_000); expect(attempts).toBe(2); expect(env.listen).toHaveBeenCalledOnce();
  });
  it("retries a failed focus listener on the same document lease without syncing prematurely", async () => {
    const unlisten = vi.fn(); const listen = vi.fn().mockRejectedValueOnce(new Error("Listener not ready")).mockResolvedValue(unlisten);
    const env = setup({ listen: listen as AssistantNoticesRuntimeDependencies["listen"] }); await settle();
    env.change(); await settle();
    expect(env.invoke.mock.calls.filter(call => call[0] === "assistant_notices_sync")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.invoke.mock.calls.filter(call => call[0] === "assistant_notices_attach")).toHaveLength(1);
    expect(listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); expect(listen).toHaveBeenCalledTimes(2);
    env.stop(); expect(unlisten).toHaveBeenCalledOnce();
  });
  it("keeps only one reconnect pending and cleans its late listener after disposal", async () => {
    const late = Promise.withResolvers<() => void>(); const unlisten = vi.fn();
    const listen = vi.fn().mockRejectedValueOnce(new Error("Not ready")).mockReturnValue(late.promise);
    const env = setup({ listen: listen as AssistantNoticesRuntimeDependencies["listen"] }); await settle();
    await vi.advanceTimersByTimeAsync(40_000); expect(listen).toHaveBeenCalledTimes(2);
    env.stop(); late.resolve(unlisten); await settle();
    expect(unlisten).toHaveBeenCalledOnce();
    const calls = env.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listen).toHaveBeenCalledTimes(2); expect(env.invoke).toHaveBeenCalledTimes(calls);
  });
  it("appends once to the verified source draft, preserving current content and never sending", async () => {
    const env = setup(); await settle();
    const draft = { ...request(), action: "draft" as const, text: "补充🙂\n\n```ts\n1\n```" };
    env.fire(draft); env.fire(draft); await settle();
    env.state.drafts["codex/abc"] = "最新草稿";
    await vi.advanceTimersByTimeAsync(20);
    expect(env.state.setDraft).toHaveBeenCalledExactlyOnceWith("codex/abc", `最新草稿\n\n${draft.text}`);
    expect(env.state.send).not.toHaveBeenCalled();
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ success: true }));
    env.fire(request("open")); await settle(); await vi.advanceTimersByTimeAsync(20);
    expect(env.state.setDraft).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed actions, text and IDs and ignores a wrong document", async () => {
    const env = setup(); await settle();
    for (const bad of [ { action: "send" }, { action: "draft" }, { action: "draft", text: "  " }, { action: "draft", text: "a".repeat(6001) }, { noticeId: "../bad" }, { documentId: "other" } ]) {
      env.fire({ ...request(), ...bad } as AssistantNoticeFocusRequest);
    }
    await settle(); expect(env.state.selectSession).not.toHaveBeenCalled(); expect(env.state.setDraft).not.toHaveBeenCalled();
  });
  it("does not insert into an identically keyed session in another workspace", async () => {
    const env = setup(); await settle(); env.state.active = { ...source, workspacePath: "/other" };
    env.fire({ ...request(), action: "draft", text: "No" }); await settle(); await vi.advanceTimersByTimeAsync(1020);
    expect(env.state.setDraft).not.toHaveBeenCalled();
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ success: false }));
  });
  it("keeps only one selection pending and never inserts after its deadline", async () => {
    const env = setup(); await settle();
    const selection = Promise.withResolvers<void>(); env.state.selectSession.mockReturnValue(selection.promise);
    env.fire({ ...request(), action: "draft", text: "Expired" });
    env.fire({ ...request("second"), action: "draft", text: "Busy" });
    await settle(); expect(env.state.selectSession).toHaveBeenCalledTimes(1);
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_focus_ack", expect.objectContaining({ requestId: "second", success: false }));
    await vi.advanceTimersByTimeAsync(6500);
    selection.resolve(); await settle(); await vi.advanceTimersByTimeAsync(20);
    expect(env.state.setDraft).not.toHaveBeenCalled();
    expect(env.invoke.mock.calls.filter(call => call[0] === "assistant_notices_focus_ack")).toHaveLength(2);
  });
  it("tracks modal attribute changes without needing a store or heartbeat event", async () => {
    const modal = document.createElement("dialog"); document.body.appendChild(modal);
    const env = setup(); await settle();
    modal.setAttribute("open", ""); await settle();
    expect(env.invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ attentive: false, active: null }));
    modal.removeAttribute("open"); await settle();
    expect(env.invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ attentive: true }));
  });
  it("normalizes locale and cleans language subscriptions", async () => {
    let notify: (() => void) | undefined;
    const language = { language: "zh-Hans", on: vi.fn((_event: string, fn: () => void) => { notify = fn; }), off: vi.fn() };
    const env = setup({ language }); await settle();
    expect(env.invoke).toHaveBeenCalledWith("assistant_notices_sync", expect.objectContaining({ locale: "zh-CN" }));
    language.language = "en-US"; notify?.(); await settle();
    expect(env.invoke).toHaveBeenLastCalledWith("assistant_notices_sync", expect.objectContaining({ locale: "en", attentionEvent: false }));
    env.stop(); expect(language.off).toHaveBeenCalledWith("languageChanged", notify);
  });
  it("attaches only once per document and skips overlay routes and windows", async () => {
    const env = setup(); startAssistantNoticesRuntime(env.deps); await settle();
    expect(env.invoke.mock.calls.filter(call => call[0] === "assistant_notices_attach")).toHaveLength(1);
    env.stop(); await settle();
    window.location.hash = "#/assistant-notices";
    const overlay = setup(); await settle(); expect(overlay.invoke).not.toHaveBeenCalled();
    window.location.hash = "#/";
    const pet = setup({ windowLabel: () => "pet-overlay" }); await settle(); expect(pet.invoke).not.toHaveBeenCalled();
  });
});
