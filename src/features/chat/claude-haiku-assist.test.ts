import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { useChatStore } from "./store";
import { OPEN_TABS_KEY, readPersistedTabs, sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { liveFollowUpBlocker, resolveLaunchSettings } from "./store/live-follow-up";
import { handleEngineEvents, settledRuns, type EngineEventDeps } from "./store/engine-events";
import { localizeRunError } from "./run-error";

vi.mock("@/lib/ipc", () => ({ ipc: {
  sendMessage: vi.fn(async (args: { runId?: string }) => ({ runId: args.runId!, sessionId: null as string | null })),
  rememberClaudeUltracode: vi.fn(async () => {}),
  rememberSessionEffort: vi.fn(async () => {}),
  rememberSessionModel: vi.fn(async () => {}),
  rememberSessionProvider: vi.fn(async () => {}),
  updateAppSettings: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  listArchivedSessions: vi.fn(async () => []),
  loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
  listPlanReviews: vi.fn(async () => []),
  rescanSessions: vi.fn(async () => {}),
  usageRecord: vi.fn(async () => {}),
} }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "/tmp/haiku-assist";
const a = { engine: "claude", sessionId: "a", workspacePath: WS, model: "opus" };
const b = { ...a, sessionId: "b" };
const draft = { ...a, sessionId: null };
const key = (tab: typeof a | typeof draft) => sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deps = (): EngineEventDeps => ({ set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: () => {} });

describe("optional Claude Haiku assistance", () => {
  beforeEach(async () => {
    await flush();
    vi.clearAllMocks();
    localStorage.clear();
    runRouting.clear();
    settledRuns.clear();
    vi.mocked(ipc.sendMessage).mockImplementation(async (args) => ({ runId: args.runId!, sessionId: null }));
    useChatStore.setState({ active: a, openTabs: [a, b], activeEngine: "claude", workspaces: [], sessions: [], archivedSessionKeys: {}, engines: [], models: { claude: "sonnet" }, efforts: { claude: "high" }, providers: {}, defaultClaudeUltracode: false, permission: "manual", bySession: {}, streamingByKey: {}, retryingByKey: {}, drafts: {}, unseen: {}, actionError: null });
  });

  it.each([undefined, true, false])("sends choice %s without changing the main model, effort, permission or defaults", async (enabled) => {
    if (enabled !== undefined) useChatStore.getState().setClaudeHaikuAssist(enabled);
    await useChatStore.getState().send("fake task", []);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a", claudeHaikuAssist: enabled === true, model: "opus", effort: "high", permission: "manual" }));
    expect(useChatStore.getState()).toMatchObject({ models: { claude: "sonnet" }, efforts: { claude: "high" }, permission: "manual" });
    expect(ipc.updateAppSettings).not.toHaveBeenCalled();
  });

  it("changes only the targeted pane and sends that background conversation's choice", async () => {
    useChatStore.getState().setClaudeHaikuAssist(true, b);
    expect(useChatStore.getState().active).toEqual(a);
    expect(readPersistedTabs()).toEqual([a, { ...b, claudeHaikuAssist: true }]);
    await useChatStore.getState().send("background", [], undefined, b);
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "b", claudeHaikuAssist: true, model: "opus" }));
    await useChatStore.getState().send("foreground", [], undefined, a);
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "a", claudeHaikuAssist: false }));
  });

  it("explicit off restores the choice and closing/reopening a tab resets it", async () => {
    useChatStore.getState().setClaudeHaikuAssist(true);
    useChatStore.getState().setClaudeHaikuAssist(false);
    expect(useChatStore.getState().active?.claudeHaikuAssist).toBe(false);
    useChatStore.getState().setClaudeHaikuAssist(true);
    useChatStore.getState().closeTab("claude", "a", WS);
    await useChatStore.getState().selectSession("claude", "a", WS);
    expect(useChatStore.getState().active?.claudeHaikuAssist).toBeUndefined();
  });

  it("isolates new drafts by workspace and resets the switch when changing engine", () => {
    const siblingDraft = { ...draft, workspacePath: "/tmp/other" };
    useChatStore.setState({ active: draft, openTabs: [draft, siblingDraft] });
    useChatStore.getState().setClaudeHaikuAssist(true);
    expect(readPersistedTabs()[1].claudeHaikuAssist).toBeUndefined();
    useChatStore.getState().setActiveEngine("codex");
    expect(useChatStore.getState().active?.claudeHaikuAssist).toBeUndefined();
    useChatStore.getState().setClaudeHaikuAssist(true);
    expect(useChatStore.getState().active?.claudeHaikuAssist).toBeUndefined();
  });

  it("does not transmit a stale Claude switch to another engine", async () => {
    const tab = { ...a, engine: "codex", claudeHaikuAssist: true };
    useChatStore.setState({ active: tab, openTabs: [tab] });
    await useChatStore.getState().send("fake task", []);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({ claudeHaikuAssist: expect.anything() }));
  });

  it.each(["response", "event"])("preserves a newer toggle when the draft receives its native id via %s", async (route) => {
    useChatStore.setState({ active: draft, openTabs: [draft] });
    useChatStore.getState().setClaudeHaikuAssist(true);
    let finish!: (value: { runId: string; sessionId: string }) => void;
    vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const sending = useChatStore.getState().send("fake task", []);
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
    const runId = vi.mocked(ipc.sendMessage).mock.calls[0][0].runId!;
    useChatStore.getState().setClaudeHaikuAssist(false);
    if (route === "event") handleEngineEvents([{ runId, sessionId: null, engine: "claude", seq: 1, kind: "session", data: "a" }], deps());
    finish({ runId, sessionId: "a" });
    await sending;
    expect(useChatStore.getState().active).toMatchObject({ sessionId: "a", claudeHaikuAssist: false });
    expect(readPersistedTabs()[0]).toMatchObject({ sessionId: "a", claudeHaikuAssist: false });
    expect(useChatStore.getState().bySession[key(a)].liveLaunch?.claudeHaikuAssist).toBe(true);
  });

  it.each([false, true])("queues instead of reusing a live process after changing away from %s", (initial) => {
    const tab = { ...a, claudeHaikuAssist: initial };
    const state = useChatStore.getState();
    const session = { ...EMPTY_SESSION, streaming: true, nativeActivity: "waiting" as const, nativeTaskRunId: "run-a" };
    const running = { ...session, liveLaunch: resolveLaunchSettings(state, tab, session) };
    runRouting.set("run-a", key(a));
    expect(liveFollowUpBlocker(state, tab, running)).toBeNull();
    expect(liveFollowUpBlocker(state, { ...tab, claudeHaikuAssist: !initial }, running)).toBe("settings-changed");
  });

  it("reports capability refusal as an error and leaves the session switch available to turn off", async () => {
    useChatStore.getState().setClaudeHaikuAssist(true);
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("CLAUDE_HAIKU_ASSIST_UNAVAILABLE: missing --agents"));
    await useChatStore.getState().send("fake task", []);
    const failed = useChatStore.getState().bySession[key(a)];
    expect(failed.streaming).toBe(false);
    expect(localizeRunError(failed.error, i18n.t)).toContain(i18n.t("chat.haikuAssistUnavailable"));
    useChatStore.getState().setClaudeHaikuAssist(false);
    await useChatStore.getState().send("fake retry", []);
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ claudeHaikuAssist: false, model: "opus", permission: "manual" }));
  });

  it("validates persisted boolean choices without treating strings as opt-in", () => {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify([{ ...a, claudeHaikuAssist: true }, { ...b, claudeHaikuAssist: "true" }]));
    expect(readPersistedTabs()).toEqual([{ ...a, claudeHaikuAssist: true }]);
  });
});
