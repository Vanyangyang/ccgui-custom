import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore, sessionKey } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { replaceHandoffDraftSummary, useHandoffStore } from "./session-cleanup";
import {
  DEFAULT_HANDOFF_COMPRESSION_MODEL,
  HANDOFF_PREFERENCES_KEY,
  LEGACY_HANDOFF_PREFERENCES_KEY,
  readHandoffCompressionPreferences,
} from "./handoff-preferences";

const original = useChatStore.getState();
const workspacePath = "/handoff-compression";
const key = sessionKey("codex", null, workspacePath);
const args = {
  workspacePath, sourceEngine: "codex", sourceSessionId: "source", sourceTitle: "Source",
  sourceState: { ...EMPTY_SESSION, messages: [{ seq: 1, ts: "1", role: "assistant" as const, text: "Local conclusion 中文 😀" }] },
};
const entry = () => useHandoffStore.getState().byWorkspace[workspacePath];
const draft = () => useChatStore.getState().drafts[key];
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(ipc, "taskSnapshot").mockResolvedValue({ leaders: [], branches: [] });
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
  localStorage.removeItem(LEGACY_HANDOFF_PREFERENCES_KEY);
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState({ ...original, activeEngine: "codex", active: null, openTabs: [], drafts: {}, sessions: [], archivedSessionKeys: {}, streamingByKey: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
  localStorage.removeItem(LEGACY_HANDOFF_PREFERENCES_KEY);
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState(original);
});

describe("optional handoff model compression", () => {
  it("defaults to a local summary and issues no model request, including retry while off", async () => {
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff");
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().retryGrok(workspacePath);
    expect(entry()).toMatchObject({ mode: "local", compressionModel: DEFAULT_HANDOFF_COMPRESSION_MODEL, grokStatus: "idle" });
    expect(draft()).toContain("Local conclusion 中文 😀");
    expect(summarize).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(entry().childrenStatus).toBe("ready");
    expect(ipc.taskSnapshot).toHaveBeenCalledTimes(1);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("lets a model be selected before enabling without changing the destination chat", async () => {
    const summary = deferred();
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff(args);
    const active = useChatStore.getState().active;
    useHandoffStore.getState().setCompressionModel(workspacePath, "gemini-3.1-pro");
    expect(summarize).not.toHaveBeenCalled();
    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    expect(summarize).not.toHaveBeenCalled();
    await Promise.resolve(); // Complete the child snapshot before model inference.
    expect(summarize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ compressionModel: "gemini-3.1-pro", engine: "codex", sessionId: "source" }));
    summary.resolve("Selected model summary"); await summary.promise;
    expect(draft()).toContain("上一会话交接摘要（模型提炼）：");
    expect(draft()).not.toContain("Grok 4.7");
    expect(useChatStore.getState().active).toEqual(active);
    expect(useChatStore.getState().activeEngine).toBe("codex");
  });

  it("remembers the explicit model and enabled choice for subsequent handoffs", async () => {
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockResolvedValue("Persisted selected model summary");
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().setCompressionModel(workspacePath, "opus-4.6");
    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    await Promise.resolve();
    useHandoffStore.getState().startHandoff({ ...args, sourceSessionId: "second" });
    await Promise.resolve();
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({ compressionModel: "opus-4.6" }));
    useHandoffStore.getState().setCompressionMode(workspacePath, "local");
    useHandoffStore.getState().startHandoff({ ...args, sourceSessionId: "third" });
    await Promise.resolve();
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(entry()).toMatchObject({ mode: "local", compressionModel: "opus-4.6" });
  });

  it("ignores a completion after compression is disabled", async () => {
    const summary = deferred();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await Promise.resolve();
    useHandoffStore.getState().setCompressionMode(workspacePath, "local");
    const local = draft();
    summary.resolve("Old request must not appear"); await summary.promise;
    expect(draft()).toBe(local);
    expect(entry()).toMatchObject({ mode: "local", grokStatus: "idle", grokSummary: null });
  });

  it("keeps native failure diagnostics and the editable local draft until an explicit retry succeeds", async () => {
    const first = deferred(); const retry = deferred();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await Promise.resolve();
    useChatStore.getState().setDraft(key, draft() + "保留下一步任务 😀");
    const local = draft();
    const diagnostic = "codex returned invalid summary [stage=final_json; http_status=200; diagnostic_id=fixture-call]";
    first.reject(new Error(diagnostic)); await first.promise.catch(() => {});
    expect(entry()).toMatchObject({ grokStatus: "error", grokError: diagnostic, grokSummary: null });
    expect(draft()).toBe(local);
    useHandoffStore.getState().retryGrok(workspacePath);
    retry.resolve("有效的模型提炼摘要，保留所有待办。"); await retry.promise;
    expect(entry()).toMatchObject({ grokStatus: "done", grokError: null });
    expect(draft()).toContain("有效的模型提炼摘要，保留所有待办。");
    expect(draft()).toContain("保留下一步任务 😀");
  });

  it("binds each completion to its selected model and preserves text after the summary", async () => {
    const first = deferred(); const second = deferred();
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await Promise.resolve();
    useChatStore.getState().setDraft(key, draft() + "保留后续任务 😀");
    useHandoffStore.getState().setCompressionModel(workspacePath, "gemini-3.1-pro");
    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({ compressionModel: "gemini-3.1-pro" }));
    second.resolve("New selected-model summary"); await second.promise;
    first.resolve("Old model summary"); await first.promise;
    expect(draft()).toContain("New selected-model summary");
    expect(draft()).not.toContain("Old model summary");
    expect(draft()).toContain("接下来请继续：保留后续任务 😀");
  });

  it.each(["toggle", "model"] as const)("preserves manual summary edits across a %s change and its late result", async (change) => {
    const first = deferred(); const second = deferred();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await Promise.resolve();
    const edited = draft().replace("Local conclusion 中文 😀", "人工核实：保留这个结论 😀");
    useChatStore.getState().setDraft(key, edited);
    if (change === "toggle") {
      useHandoffStore.getState().setCompressionMode(workspacePath, "local");
      expect(draft()).toBe(edited);
      useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    } else {
      useHandoffStore.getState().setCompressionModel(workspacePath, "opus-4.6");
    }
    second.resolve("New background summary"); await second.promise;
    first.reject(new Error("old error")); await first.promise.catch(() => {});
    expect(entry().grokStatus).toBe("done");
    expect(draft()).toBe(edited);
  });

  it("keeps model selection and enable state locked during submission", () => {
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff");
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().setSending(workspacePath, entry().id, true);
    useHandoffStore.getState().setCompressionModel(workspacePath, "opus-4.6");
    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    expect(entry()).toMatchObject({ mode: "local", compressionModel: DEFAULT_HANDOFF_COMPRESSION_MODEL });
    expect(summarize).not.toHaveBeenCalled();
  });

  it.each(["broken json", '{"enabled":true}', '{"enabled":true,"model":"--flag"}', '{"enabled":true,"model":"model\\n"}'])("does not enable compression from corrupt saved preferences: %s", (stored) => {
    localStorage.setItem(HANDOFF_PREFERENCES_KEY, stored);
    expect(readHandoffCompressionPreferences()).toEqual({ enabled: false, model: DEFAULT_HANDOFF_COMPRESSION_MODEL,
      selection: { engine: "cursor", model: DEFAULT_HANDOFF_COMPRESSION_MODEL } });
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff");
    useHandoffStore.getState().startHandoff(args);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("reports failed preference persistence while retaining this handoff's explicit selection", () => {
    useHandoffStore.getState().startHandoff(args);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    useHandoffStore.getState().setCompressionModel(workspacePath, "opus-4.6");
    expect(entry()).toMatchObject({ compressionModel: "opus-4.6", compressionPreferenceError: true, mode: "local" });
  });

  it("can still replace a legacy Grok heading without duplicating the old summary", () => {
    const old = "承接上一会话「Source」（codex/source）：\n\n上一会话交接摘要（Grok 4.7 提炼）：\n> old\n\n接下来请继续：keep";
    const updated = replaceHandoffDraftSummary(old, "new");
    expect(updated).toContain("上一会话交接摘要（模型提炼）：\n> new");
    expect(updated).not.toContain("> old");
    expect(updated).toContain("接下来请继续：keep");
  });

  it("migrates old Cursor preferences without changing their model or enabling extra requests", () => {
    localStorage.setItem(LEGACY_HANDOFF_PREFERENCES_KEY, JSON.stringify({ enabled: false, model: "grok-4.7-low-fast" }));
    expect(readHandoffCompressionPreferences().selection).toEqual({ engine: "cursor", model: "grok-4.7-low-fast" });
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().setCompressionSelection(workspacePath, { engine: "claude", model: "opus", providerId: "relay" });
    expect(JSON.parse(localStorage.getItem(LEGACY_HANDOFF_PREFERENCES_KEY)!)).toEqual({ enabled: false, model: "grok-4.7-low-fast" });
    expect(JSON.parse(localStorage.getItem(HANDOFF_PREFERENCES_KEY)!).selection.engine).toBe("claude");
  });

  it("persists full routing, uses it for new handoffs, and never changes the destination settings", async () => {
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockResolvedValue("Selected provider summary");
    useHandoffStore.getState().startHandoff(args);
    const chat = useChatStore.getState();
    const selection = { engine: "claude" as const, model: "relay/opus[1m]", providerId: "custom-relay", effort: "high" };
    useHandoffStore.getState().setCompressionSelection(workspacePath, selection);
    expect(summarize).not.toHaveBeenCalled();
    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    expect(summarize).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(summarize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ compressionSelection: selection, engine: "codex" }));
    await Promise.resolve();
    useHandoffStore.getState().startHandoff({ ...args, sourceSessionId: "second" });
    await Promise.resolve();
    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({ compressionSelection: selection }));
    expect(entry().compressionSelection).toEqual(selection);
    expect(useChatStore.getState().models).toBe(chat.models);
    expect(useChatStore.getState().providers).toBe(chat.providers);
    expect(useChatStore.getState().efforts).toBe(chat.efforts);
    expect(useChatStore.getState().activeEngine).toBe(chat.activeEngine);
  });

  it.each(["providerId", "engine", "effort"] as const)("invalidates old results when only %s changes", async (field) => {
    const first = deferred(); const second = deferred();
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const selection = { engine: "claude" as const, model: "same-model", providerId: "one", effort: "medium" };
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().setCompressionSelection(workspacePath, selection);
    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    await Promise.resolve();
    const next = { ...selection, [field]: field === "engine" ? "codex" : field === "providerId" ? "two" : "high" };
    useHandoffStore.getState().setCompressionSelection(workspacePath, next);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({ compressionSelection: next }));
    second.resolve("New route summary"); await second.promise;
    first.resolve("Old route summary"); await first.promise;
    expect(draft()).toContain("New route summary");
    expect(draft()).not.toContain("Old route summary");
    useHandoffStore.getState().setSending(workspacePath, entry().id, true);
    useHandoffStore.getState().setCompressionSelection(workspacePath, selection);
    expect(entry().compressionSelection).toEqual(next);
  });

  it("rejects corrupt structured preferences instead of enabling an unintended route", () => {
    localStorage.setItem(HANDOFF_PREFERENCES_KEY, JSON.stringify({ enabled: true, model: "old-cursor", selection: { engine: "unknown", model: "valid" } }));
    expect(readHandoffCompressionPreferences().enabled).toBe(false);
  });
});
