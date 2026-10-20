import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type Workspace } from "@/lib/ipc";
import { getConversationModeState } from "@/features/plugins/conversation/state";
import { useSidechatStore } from "@/features/sidechat/store";
import { useChatStore, sessionKey } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { replaceHandoffDraftSummary, useHandoffStore } from "./session-cleanup";
import { HANDOFF_PREFERENCES_KEY } from "./handoff-preferences";

const original = useChatStore.getState();
const originalSidechat = useSidechatStore.getState();
const source = "/source";
const target = "/target";
const key = (path: string, engine = "codex") => sessionKey(engine, null, path);
const state = { ...EMPTY_SESSION, messages: [{ seq: 1, ts: "1", role: "assistant" as const, text: "original conclusion src/file.ts" }] };
const args = { workspacePath: source, sourceEngine: "codex", sourceSessionId: "source-session", sourceTitle: "Source", sourceState: state, initialMode: "local" as const };
const move = (from = source, to = target) => useHandoffStore.getState().moveHandoffToWorkspace(from, to);
const draft = (path = target) => useChatStore.getState().drafts[key(path)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
  useHandoffStore.setState({ byWorkspace: {} });
  useSidechatStore.setState({ btwBySession: {}, sidechatBySession: {} });
  useChatStore.setState({
    ...original, activeEngine: "codex", active: null, openTabs: [], drafts: {}, bySession: {},
    workspaces: [{ path: target } as Workspace], streamingByKey: {}, retryingByKey: {},
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState(original);
  useSidechatStore.setState(originalSidechat);
});

describe("handoff workspace migration", () => {
  it("moves the tab cwd and settings while keeping source identity and exact manual content on return", () => {
    useHandoffStore.getState().startHandoff({ ...args, archiveSourceOnSend: true });
    const entry = useHandoffStore.getState().byWorkspace[source];
    const edited = "人工前文\n\n" + replaceHandoffDraftSummary(draft(source), "人工摘要 src/file.ts") + "\n人工后文";
    useChatStore.getState().setDraft(key(source), edited);
    const tab = { ...useChatStore.getState().active!, model: "chosen-model", effort: "high" as const };
    useChatStore.setState({ active: tab, openTabs: [tab] });
    expect(move()).toBe(true);
    expect(useHandoffStore.getState().byWorkspace[source]).toBeUndefined();
    expect(useHandoffStore.getState().byWorkspace[target]).toMatchObject({ ...entry, workspacePath: source });
    expect(useChatStore.getState().active).toEqual({ ...tab, workspacePath: target });
    expect(draft()).toContain(`来源绝对目录：${source}`);
    expect(draft()).toContain(`目标工作目录：${target}`);
    expect(draft()).toContain("历史摘要及关联上下文中的相对路径以来源目录为基准");
    expect(draft()).toContain("不得假定目标目录存在同名文件");
    expect(draft()).toContain(edited);
    useHandoffStore.getState().setCompressionMode(target, "detailed");
    expect(draft()).toContain(edited);
    expect(move(target, source)).toBe(true); // Source need not remain registered.
    expect(draft(source)).toBe(edited);
    expect(useHandoffStore.getState().byWorkspace[source].id).toBe(entry.id);
    expect(useChatStore.getState().drafts[key(target)]).toBeUndefined();
  });

  it("reuses an empty target tab and updates a single directory notice on repeated moves", () => {
    useChatStore.getState().startNewChat(target);
    useHandoffStore.getState().startHandoff(args);
    expect(move()).toBe(true);
    expect(useChatStore.getState().openTabs).toHaveLength(1);
    expect(move(target, source)).toBe(true);
    expect(move()).toBe(true);
    expect(draft().split("【交接目录说明】")).toHaveLength(2);
    useHandoffStore.getState().setCompressionMode(target, "detailed");
    expect(draft()).toContain("【交接目录说明】");
  });

  it.each(["draft", "other-engine", "handoff", "messages", "queue", "streaming", "draftLaunching", "plugin", "unknown"] as const)(
    "refuses target conflict %s without changing either store", (conflict) => {
      if (conflict === "handoff") useHandoffStore.getState().startHandoff({ ...args, workspacePath: target });
      useHandoffStore.getState().startHandoff(args);
      if (conflict === "draft" || conflict === "other-engine") {
        useChatStore.getState().setDraft(key(target, conflict === "draft" ? "codex" : "claude"), "keep me");
      }
      if (["messages", "queue", "streaming", "draftLaunching"].includes(conflict)) {
        const patch = conflict === "messages" ? { messages: state.messages }
          : conflict === "queue" ? { queue: [{ id: "queued", text: "keep me", images: [], queuedAt: 1 }] }
          : conflict === "streaming" ? { streaming: true } : { draftLaunching: "launch" };
        useChatStore.setState({ bySession: { [key(target)]: { ...EMPTY_SESSION, ...patch } } });
      }
      if (conflict === "plugin") vi.spyOn(getConversationModeState(), "isTabCloseBlocked").mockImplementation((_key, path) => path === target);
      const beforeChat = useChatStore.getState();
      const beforeHandoff = useHandoffStore.getState();
      expect(move(source, conflict === "unknown" ? "/unknown" : target)).toBe(false);
      expect(useChatStore.getState()).toBe(beforeChat);
      expect(useHandoffStore.getState()).toBe(beforeHandoff);
    },
  );

  it.each(["sending", "streaming", "draftLaunching", "messages", "plugin", "plain"] as const)(
    "refuses non-movable source %s", (conflict) => {
      useHandoffStore.getState().startHandoff(args);
      const entry = useHandoffStore.getState().byWorkspace[source];
      if (conflict === "sending") useHandoffStore.getState().setSending(source, entry.id, true);
      if (conflict === "plain") useChatStore.getState().setDraft(key(source), "replacement");
      if (conflict === "plugin") vi.spyOn(getConversationModeState(), "isTabCloseBlocked").mockReturnValue(true);
      if (["streaming", "draftLaunching", "messages"].includes(conflict)) {
        useChatStore.setState({ bySession: { [key(source)]: {
          ...EMPTY_SESSION, ...(conflict === "messages" ? { messages: state.messages }
            : conflict === "streaming" ? { streaming: true } : { draftLaunching: "launch" }),
        } } });
      }
      const before = useChatStore.getState();
      expect(move()).toBe(false);
      expect(useChatStore.getState()).toBe(before);
      expect(useHandoffStore.getState().byWorkspace[source].id).toBe(entry.id);
    },
  );

  it("routes in-flight compression to the moved handoff without a second request or touching a successor", async () => {
    const summary = deferred<string>();
    const summarize = vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    expect(move()).toBe(true);
    useHandoffStore.getState().startHandoff({ ...args, sourceSessionId: "successor" });
    const successorDraft = draft(source);
    summary.resolve("compressed result");
    await summary.promise;
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(draft()).toContain("compressed result");
    expect(draft()).toContain("【交接目录说明】");
    expect(draft(source)).toBe(successorDraft);
    expect(useHandoffStore.getState().byWorkspace[target].grokStatus).toBe("done");
  });

  it.each([false, true])("routes late source history after migration and preserves manual summary=%s", async (manual) => {
    const history = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>();
    vi.spyOn(ipc, "loadSessionPage").mockReturnValue(history.promise);
    useHandoffStore.getState().startHandoff({ ...args, sourceState: undefined });
    if (manual) useChatStore.getState().setDraft(key(source), replaceHandoffDraftSummary(draft(source), "manual summary")!);
    expect(move()).toBe(true);
    history.resolve({ messages: state.messages } as Awaited<ReturnType<typeof ipc.loadSessionPage>>);
    await history.promise;
    expect(draft()).toContain(manual ? "manual summary" : "original conclusion");
    expect(draft()).toContain("【交接目录说明】");
    expect(useHandoffStore.getState().byWorkspace[target].sourceState?.messages).toEqual(state.messages);
    expect(move(target, source)).toBe(true);
    expect(draft(source)).not.toContain("【交接目录说明】");
  });

  it.each([source, target])("refuses sidechat ownership in %s without abandoning its cwd", (path) => {
    useHandoffStore.getState().startHandoff(args);
    useSidechatStore.getState().toggleSidechat({ sessionKey: key(path), engine: "codex", workspacePath: path, parentSessionId: null });
    const before = useChatStore.getState();
    expect(move()).toBe(false);
    expect(useChatStore.getState()).toBe(before);
    expect(useSidechatStore.getState().sidechatBySession[key(path)].workspacePath).toBe(path);
  });

  it("keeps an idle plugin's target tab instead of replacing its conversation", () => {
    const modes = getConversationModeState();
    const beforeModes = modes.captureCheckpoint();
    try {
      useChatStore.getState().startNewChat(target);
      const identity = modes.identity(key(target), target, true);
      modes.select(identity, "fixture-mode", false, 0);
      useHandoffStore.getState().startHandoff(args);
      const before = useChatStore.getState();
      expect(move()).toBe(false);
      expect(useChatStore.getState()).toBe(before);
      expect(modes.selected(identity)).toBe("fixture-mode");
    } finally {
      modes.restoreCheckpoint(beforeModes);
    }
  });

  it("archives the original source identity after moving", async () => {
    const meta = { engine: "codex", sessionId: args.sourceSessionId, workspacePath: source } as Parameters<typeof ipc.archiveSession>[0];
    const archive = vi.fn<typeof original.archiveSession>().mockResolvedValue();
    useChatStore.setState({ archiveSession: archive, sessions: [{ ...meta, workspacePath: target }, meta] });
    useHandoffStore.getState().startHandoff({ ...args, sourceMeta: meta, archiveSourceOnSend: true });
    const id = useHandoffStore.getState().byWorkspace[source].id;
    expect(move()).toBe(true);
    useHandoffStore.getState().completeHandoffOnSend(target, id);
    expect(archive).toHaveBeenCalledWith(meta);
  });
});
