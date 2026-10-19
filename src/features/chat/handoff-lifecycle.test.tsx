import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore, sessionKey } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { replaceHandoffDraftSummary, useHandoffStore } from "./session-cleanup";
import { useComposerActions } from "./components/use-composer-actions";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original = useChatStore.getState();
const workspacePath = "/handoff-test";
const key = sessionKey("codex", null, workspacePath);
const state = { ...EMPTY_SESSION, messages: [{ seq: 1, ts: "1", role: "assistant" as const, text: "original conclusion" }] };
const sourceMeta = { engine: "codex", sessionId: "source-session", workspacePath } as Parameters<typeof ipc.archiveSession>[0];
const args = { workspacePath, sourceEngine: "codex", sourceSessionId: "source-session", sourceTitle: "Source", sourceState: state, sourceMeta };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function draft() { return useChatStore.getState().drafts[key]; }

beforeEach(() => {
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState({ ...original, activeEngine: "codex", active: null, openTabs: [], drafts: {}, sessions: [], archivedSessionKeys: {}, streamingByKey: {} });
});
afterEach(() => { vi.restoreAllMocks(); useHandoffStore.setState({ byWorkspace: {} }); useChatStore.setState(original); });

describe("handoff lifecycle ownership", () => {
  it("replaces only the summary and preserves user additions before and after it", () => {
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "local" });
    const edited = draft().replace("\n\n上一会话", "\n用户补充：不要改 API\n\n上一会话").replace("\n\n接下来", "\n用户备注：先检查测试\n\n接下来") + "继续验证";
    const next = replaceHandoffDraftSummary(edited, "compressed")!;
    expect(next).toContain("用户补充：不要改 API");
    expect(next).toContain("用户备注：先检查测试");
    expect(next).toContain("接下来请继续：继续验证");
    expect(next).not.toContain("original conclusion");
  });

  it("does not rebuild a plain draft when history arrives or modes change", async () => {
    const history = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>();
    vi.spyOn(ipc, "loadSessionPage").mockReturnValue(history.promise);
    useHandoffStore.getState().startHandoff({ ...args, sourceState: undefined, initialMode: "local" });
    useChatStore.getState().setDraft(key, "ordinary chat, 用户已替换");
    history.resolve({ messages: state.messages } as Awaited<ReturnType<typeof ipc.loadSessionPage>>);
    await history.promise;
    useHandoffStore.getState().setCompressionMode(workspacePath, "detailed");
    expect(draft()).toBe("ordinary chat, 用户已替换");
  });

  it("preserves manual summary edits when Grok finishes", async () => {
    const summary = deferred<string>();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff(args);
    const edited = draft().replace("original conclusion", "用户手工核实的结论，不可覆盖");
    useChatStore.getState().setDraft(key, edited);
    summary.resolve("background generated summary");
    await summary.promise;
    expect(draft()).toBe(edited);
    expect(useHandoffStore.getState().byWorkspace[workspacePath].grokStatus).toBe("done");
  });

  it("preserves a user-authored summary while source history loads", async () => {
    const history = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>();
    vi.spyOn(ipc, "loadSessionPage").mockReturnValue(history.promise);
    useHandoffStore.getState().startHandoff({ ...args, sourceState: undefined, initialMode: "local" });
    const edited = replaceHandoffDraftSummary(draft(), "用户自行补充的摘要")!;
    useChatStore.getState().setDraft(key, edited);
    history.resolve({ messages: state.messages } as Awaited<ReturnType<typeof ipc.loadSessionPage>>);
    await history.promise;
    expect(draft()).toBe(edited);
  });

  it.each([false, true])("distinguishes history hydration from manual summary edits=%s before Grok completes", async (manualEdit) => {
    const history = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>();
    const summary = deferred<string>();
    vi.spyOn(ipc, "loadSessionPage").mockReturnValue(history.promise);
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff({ ...args, sourceState: undefined });
    history.resolve({ messages: state.messages } as Awaited<ReturnType<typeof ipc.loadSessionPage>>);
    await history.promise;
    expect(draft()).toContain("original conclusion");
    if (manualEdit) useChatStore.getState().setDraft(key, draft().replace("original conclusion", "历史读入后的人工修改"));
    summary.resolve("new Grok summary");
    await summary.promise;
    expect(draft()).toContain(manualEdit ? "历史读入后的人工修改" : "new Grok summary");
    expect(useHandoffStore.getState().byWorkspace[workspacePath].grokStatus).toBe("done");
  });

  it("ignores superseded Grok replies and errors, and keeps the selected local mode", async () => {
    const first = deferred<string>(); const second = deferred<string>();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useHandoffStore.getState().startHandoff(args);
    useHandoffStore.getState().retryGrok(workspacePath);
    second.resolve("latest summary"); await second.promise;
    first.reject(new Error("stale failure")); await first.promise.catch(() => {});
    expect(useHandoffStore.getState().byWorkspace[workspacePath].grokStatus).toBe("done");
    expect(draft()).toContain("latest summary");
    useHandoffStore.getState().setCompressionMode(workspacePath, "local");
    expect(draft()).toContain("original conclusion");
  });

  it("leaves dismissed, submitting, and other-workspace drafts untouched by late completion", async () => {
    const first = deferred<string>(); const second = deferred<string>();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useHandoffStore.getState().startHandoff(args);
    const before = draft();
    useHandoffStore.getState().dismissHandoff(workspacePath);
    first.resolve("dismissed result"); await first.promise;
    expect(draft()).toBe(before);
    useHandoffStore.getState().startHandoff(args);
    const entry = useHandoffStore.getState().byWorkspace[workspacePath];
    useHandoffStore.getState().setSending(workspacePath, entry.id, true);
    useHandoffStore.getState().setCompressionMode(workspacePath, "detailed");
    useHandoffStore.getState().retryGrok(workspacePath);
    expect(useHandoffStore.getState().byWorkspace[workspacePath].mode).toBe("grok");
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(2);
    useChatStore.getState().setDraft(key, before + " during send");
    const otherKey = sessionKey("claude", null, "/other");
    useChatStore.setState({ activeEngine: "claude", active: { engine: "claude", sessionId: null, workspacePath: "/other" }, drafts: { ...useChatStore.getState().drafts, [otherKey]: "other workspace" } });
    second.resolve("submitted result"); await second.promise;
    expect(draft()).toBe(before + " during send");
    expect(useChatStore.getState().drafts[otherKey]).toBe("other workspace");
  });

  it("does not claim an archive or restore succeeded when the store reports failure", async () => {
    const meta = { engine: "codex", sessionId: args.sourceSessionId, workspacePath } as Parameters<typeof ipc.archiveSession>[0];
    vi.spyOn(ipc, "archiveSession").mockRejectedValue(new Error("archive failed"));
    useHandoffStore.getState().startHandoff({ ...args, sourceMeta: meta, initialMode: "local" });
    await useHandoffStore.getState().archiveSourceNow(workspacePath);
    expect(useHandoffStore.getState().byWorkspace[workspacePath].sourceArchived).toBe(false);
    expect(useChatStore.getState().actionError).toContain("archive failed");
    vi.mocked(ipc.archiveSession).mockResolvedValue();
    await useHandoffStore.getState().archiveSourceNow(workspacePath);
    vi.spyOn(ipc, "restoreSession").mockRejectedValue(new Error("restore failed"));
    await useHandoffStore.getState().restoreSourceNow(workspacePath);
    expect(useHandoffStore.getState().byWorkspace[workspacePath].sourceArchived).toBe(true);
    expect(useChatStore.getState().actionError).toContain("restore failed");
  });

  it.each([false, true])("binds completion to the submitted handoff, including a dismissed successor=%s", async (dismissSuccessor) => {
    const archive = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    const sending = deferred<void>();
    let started: (() => void) | undefined;
    const send = vi.fn<typeof original.send>((_text, _images, options) => {
      options?.onCommitted?.();
      started = () => options?.onRunStarted?.({ runId: "run", sessionId: null });
      return sending.promise;
    });
    useChatStore.setState({ send });
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "local", archiveSourceOnSend: true });
    const oldId = useHandoffStore.getState().byWorkspace[workspacePath].id;
    let submit!: (value: string) => void;
    function Harness() {
      const ref = useRef<ComposerInputHandle>(null);
      const actions = useComposerActions({ active: { engine: "codex", sessionId: null, workspacePath }, sessionKey: key, streaming: false, images: [], clearImages: vi.fn(), captureImageSubmission: () => vi.fn(), importImageFiles: vi.fn(), supportsImages: true, composerInputRef: ref });
      submit = actions.submit;
      return null;
    }
    const container = document.createElement("div"); const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => submit(draft()));
    expect(useHandoffStore.getState().byWorkspace[workspacePath].sending).toBe(true);
    expect(archive).not.toHaveBeenCalled();
    await act(async () => useHandoffStore.getState().startHandoff({ ...args, initialMode: "local", archiveSourceOnSend: true }));
    const newId = useHandoffStore.getState().byWorkspace[workspacePath].id;
    expect(newId).not.toBe(oldId);
    const successorDraft = draft();
    if (dismissSuccessor) useHandoffStore.getState().dismissHandoff(workspacePath);
    await act(async () => { started?.(); sending.resolve(); await sending.promise; });
    expect(draft()).toBe(successorDraft);
    if (dismissSuccessor) {
      expect(useHandoffStore.getState().byWorkspace[workspacePath]).toBeUndefined();
      expect(archive).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      return;
    }
    expect(useHandoffStore.getState().byWorkspace[workspacePath].id).toBe(newId);
    expect(archive).not.toHaveBeenCalled();
    // Local commit happens even when the native launch subsequently fails.
    send.mockImplementation(async (_text, _images, options) => { options?.onCommitted?.(); useChatStore.setState({ actionError: "launch failed" }); });
    await act(async () => submit(draft()));
    expect(useHandoffStore.getState().byWorkspace[workspacePath].sending).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(draft()).toContain("original conclusion");
    send.mockImplementation(async (_text, _images, options) => { options?.onCommitted?.(); options?.onRunStarted?.({ runId: "run", sessionId: null }); });
    await act(async () => submit(draft()));
    expect(archive).toHaveBeenCalledExactlyOnceWith(sourceMeta);
    expect(useHandoffStore.getState().byWorkspace[workspacePath]).toBeUndefined();
    await act(async () => root.unmount());
  });

  it.each([false, true])("uses real store.send: native launch success=%s controls completion after local commit", async (success) => {
    const native = deferred<Awaited<ReturnType<typeof ipc.sendMessage>>>();
    const launch = vi.spyOn(ipc, "sendMessage").mockReturnValue(native.promise);
    const archive = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    useChatStore.setState({ refreshSessionUsage: vi.fn().mockResolvedValue(undefined) });
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "local", archiveSourceOnSend: true });
    if (!success) useChatStore.getState().setDraft(key, draft().replace("original conclusion", "用户发送前手写摘要"));
    const submitted = draft();
    const id = useHandoffStore.getState().byWorkspace[workspacePath].id;
    let submit!: (value: string) => void;
    function Harness() {
      const ref = useRef<ComposerInputHandle>(null);
      submit = useComposerActions({ active: { engine: "codex", sessionId: null, workspacePath }, sessionKey: key, streaming: false, images: [], clearImages: vi.fn(), captureImageSubmission: () => vi.fn(), importImageFiles: vi.fn(), supportsImages: true, composerInputRef: ref }).submit;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    try {
      await act(async () => submit(submitted));
      expect(launch).toHaveBeenCalledOnce();
      // This is the actual store's optimistic commit, before IPC acceptance.
      expect(useChatStore.getState().bySession[key].messages.some((message) => message.role === "user" && message.text === submitted)).toBe(true);
      expect(archive).not.toHaveBeenCalled();
      expect(draft()).toBe(submitted);
      expect(useHandoffStore.getState().byWorkspace[workspacePath].id).toBe(id);
      if (success) {
        await act(async () => { native.resolve({ runId: "native-handoff-run", sessionId: null }); await native.promise; });
        expect(archive).toHaveBeenCalledExactlyOnceWith(sourceMeta);
        expect(draft()).toBe("");
        expect(useHandoffStore.getState().byWorkspace[workspacePath]).toBeUndefined();
      } else {
        const editedWhileWaiting = submitted.replace("用户发送前手写摘要", "用户在等待时继续修改摘要") + "\n用户在等待时补充";
        await act(async () => useChatStore.getState().setDraft(key, editedWhileWaiting));
        await act(async () => { native.reject(new Error("native launch failed")); await native.promise.catch(() => {}); });
        expect(archive).not.toHaveBeenCalled();
        expect(draft()).toBe(editedWhileWaiting);
        expect(useHandoffStore.getState().byWorkspace[workspacePath]).toMatchObject({ id, sending: false });
        expect(useChatStore.getState().bySession[key].error).toContain("native launch failed");
      }
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("handles chained handoffs, CRLF blank quote lines, and empty-summary mode toggles without duplicating sections", async () => {
    const summary = deferred<string>();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    const chainedState = {
      ...EMPTY_SESSION,
      messages: [
        {
          seq: 1,
          ts: "1",
          role: "user" as const,
          text: [
            "承接上一会话「🧩 自更新队列」（codex/01a14d49）：",
            "",
            "上一会话交接摘要（Grok 4.7 提炼）：",
            "> - **目标与背景**：核查自更新状态",
            "",
            "接下来请继续：帮我测试handoff的可靠性",
          ].join("\n"),
        },
        {
          seq: 2,
          ts: "2",
          role: "assistant" as const,
          text: "第一段结论\r\n\r\n第二段结论（含承接上一会话「旧会话」字样）",
        },
      ],
    };
    useHandoffStore.getState().startHandoff({
      ...args,
      sourceSessionId: "chained-session-02",
      sourceTitle: "二次交接会话",
      sourceState: chainedState,
      nextTask: "继续检查\n接下来请继续：不要截断用户后续行",
      initialMode: "detailed",
    });
    expect(draft()).toContain("上一会话多轮对话摘录：");

    // Normalize to CRLF with bare `>\r\n` blank quote line and switch modes
    const crlfDraft = draft().replace(/\r?\n/g, "\r\n").replace(/> \r\n/g, ">\r\n");
    useChatStore.getState().setDraft(key, crlfDraft);
    useHandoffStore.getState().setCompressionMode(workspacePath, "local");
    expect(draft()).toContain("上一会话最后结论摘要：");
    expect(draft()).not.toContain("上一会话多轮对话摘录：");
    expect(draft()).toContain("接下来请继续：继续检查\r\n接下来请继续：不要截断用户后续行");

    useHandoffStore.getState().setCompressionMode(workspacePath, "grok");
    summary.resolve("- **目标与背景**：二次交接提炼完成");
    await summary.promise;
    expect(draft()).toContain("上一会话交接摘要（Grok 4.7 提炼）：\n> - **目标与背景**：二次交接提炼完成");
    expect(draft()).not.toContain("上一会话最后结论摘要：");
    expect(replaceHandoffDraftSummary(draft(), "")).not.toContain("\n\n\n接下来请继续：");
  });

  it("updates the actual handoff pending tab when viewing the source session with multiple pending tabs open", async () => {
    const summary = deferred<string>();
    vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    const claudeDraftKey = sessionKey("claude", null, workspacePath);
    useChatStore.setState({
      activeEngine: "codex",
      openTabs: [
        { engine: "claude", sessionId: null, workspacePath },
        { engine: "codex", sessionId: "source-session", workspacePath },
      ],
      active: { engine: "codex", sessionId: "source-session", workspacePath },
      drafts: { [claudeDraftKey]: "unrelated claude draft" },
    });

    useHandoffStore.getState().startHandoff(args);
    // Simulate user clicking "View Source" while Grok distillation is still running
    useChatStore.setState({
      active: { engine: "codex", sessionId: "source-session", workspacePath },
    });

    summary.resolve("Grok summary while viewing source");
    await summary.promise;

    expect(draft()).toContain("Grok summary while viewing source");
    expect(useChatStore.getState().drafts[claudeDraftKey]).toBe("unrelated claude draft");
  });
});
