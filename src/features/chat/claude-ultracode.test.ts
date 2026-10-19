import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type AppSettings, type SessionMeta } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, type EngineEventDeps } from "./store/engine-events";
import { OPEN_TABS_KEY, readPersistedTabs, sessionKey } from "./store/persistence";
import { EMPTY_SESSION, resolveClaudeUltracode, resolveSessionEffort, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({ ipc: {
  sendMessage: vi.fn(async (args: { runId?: string }) => ({ runId: args.runId!, sessionId: null as string | null })),
  rememberClaudeUltracode: vi.fn(async () => {}),
  rememberSessionEffort: vi.fn(async () => {}),
  rememberSessionModel: vi.fn(async () => {}),
  rememberSessionProvider: vi.fn(async () => {}),
  getAppSettings: vi.fn(async () => ({})),
  updateAppSettings: vi.fn(async () => {}),
  listSessions: vi.fn(async () => [] as SessionMeta[]),
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

const WS = "/tmp/ultracode";
const native = { engine: "claude", sessionId: "ultra-session", workspacePath: WS };
const pendingTab = { ...native, sessionId: null };
const KEY = sessionKey("claude", native.sessionId, WS);
const DRAFT = sessionKey("claude", null, WS);
const meta = (enabled: boolean | null): SessionMeta => ({ ...native, filePath: "s.jsonl", fileSize: 1, fileMtimeMs: 1, title: "test", preview: "", createdAt: 1, updatedAt: 2, messageCount: 0, pinned: false, customTitle: null, claudeUltracode: enabled });
const deps = (): EngineEventDeps => ({ set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: () => {} });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("Claude Ultracode session state", () => {
  beforeEach(async () => {
    await flush();
    vi.clearAllMocks();
    localStorage.clear();
    runRouting.clear();
    settledRuns.clear();
    vi.mocked(ipc.rememberClaudeUltracode).mockResolvedValue(undefined);
    vi.mocked(ipc.updateAppSettings).mockResolvedValue(undefined);
    vi.mocked(ipc.getAppSettings).mockResolvedValue({} as AppSettings);
    vi.mocked(ipc.sendMessage).mockImplementation(async (args) => ({ runId: args.runId!, sessionId: null }));
    useChatStore.setState({ active: pendingTab, openTabs: [pendingTab], activeEngine: "claude", sessions: [], archivedSessionKeys: {}, engines: [], models: {}, efforts: {}, providers: {}, defaultClaudeUltracode: false, bySession: {}, streamingByKey: {}, retryingByKey: {}, drafts: {}, unseen: {}, actionError: null });
  });

  it("keeps false explicit and ignores stale native or non-Claude tab choices", () => {
    expect(resolveClaudeUltracode({ ...pendingTab, claudeUltracode: false }, undefined, true)).toBe(false);
    expect(resolveClaudeUltracode({ ...native, claudeUltracode: true }, { claudeUltracode: false }, true)).toBe(false);
    expect(resolveClaudeUltracode(native, undefined, true)).toBe(true);
    expect(resolveClaudeUltracode({ ...pendingTab, engine: "omp", claudeUltracode: true }, undefined, true)).toBe(false);
  });

  it("persists a pending starting pick and default independently of effort", async () => {
    await useChatStore.getState().setClaudeUltracode(true);
    await useChatStore.getState().setEffort("claude", "ultra");
    expect(useChatStore.getState()).toMatchObject({ defaultClaudeUltracode: true, efforts: { claude: "max" } });
    expect(readPersistedTabs()[0]).toMatchObject({ claudeUltracode: true, effort: "max" });
    expect(ipc.updateAppSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultClaudeUltracode: true }));
    await useChatStore.getState().setClaudeUltracode(false);
    expect(useChatStore.getState().efforts.claude).toBe("max");
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY)!)[0].claudeUltracode).toBe(false);
  });

  it("a Claude menu choice from another engine changes only the Claude default", async () => {
    const other = { ...pendingTab, engine: "omp" };
    useChatStore.setState({ active: other, openTabs: [other] });
    await useChatStore.getState().setClaudeUltracode(true);
    expect(useChatStore.getState().defaultClaudeUltracode).toBe(true);
    expect(useChatStore.getState().active?.claudeUltracode).toBeUndefined();
    await useChatStore.getState().send("hi", []);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({ claudeUltracode: expect.anything() }));
  });

  it("preserves both default Ultracode and effort when their saves overlap", async () => {
    let saved = {} as AppSettings;
    vi.mocked(ipc.getAppSettings).mockImplementation(async () => ({ ...saved }));
    vi.mocked(ipc.updateAppSettings).mockImplementation(async (settings) => { saved = settings; });
    await Promise.all([
      useChatStore.getState().setClaudeUltracode(true),
      useChatStore.getState().setEffort("claude", "ultra"),
    ]);
    expect(saved).toMatchObject({ defaultClaudeUltracode: true, defaultEfforts: { claude: "max" } });
  });

  it("changes an existing session without changing the default or a sibling", async () => {
    const sibling = { ...native, sessionId: "sibling" };
    useChatStore.setState({ active: native, openTabs: [native, sibling], defaultClaudeUltracode: true, bySession: { [KEY]: { ...EMPTY_SESSION, claudeUltracode: true }, "claude/sibling": { ...EMPTY_SESSION, claudeUltracode: true } } });
    await useChatStore.getState().setClaudeUltracode(false);
    expect(useChatStore.getState().defaultClaudeUltracode).toBe(true);
    expect(useChatStore.getState().bySession["claude/sibling"].claudeUltracode).toBe(true);
    expect(ipc.rememberClaudeUltracode).toHaveBeenCalledWith(native.sessionId, false);
    expect(ipc.updateAppSettings).not.toHaveBeenCalled();
    await useChatStore.getState().send("hi", [], undefined, native);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ claudeUltracode: false }));
  });

  it("reopens and refreshes a saved false despite a true default and stale tab", async () => {
    useChatStore.setState({ active: null, openTabs: [{ ...native, claudeUltracode: true }], defaultClaudeUltracode: true, sessions: [meta(false)] });
    await useChatStore.getState().selectSession("claude", native.sessionId, WS);
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
    expect(useChatStore.getState().active?.claudeUltracode).toBeUndefined();
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, claudeUltracode: true } } });
    vi.mocked(ipc.listSessions).mockResolvedValueOnce([meta(false)]);
    await useChatStore.getState().refreshSessions();
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
  });

  it.each(["event", "response"])("adopts a late native id via %s without reverting a newer pick", async (route) => {
    let finish!: (result: { runId: string; sessionId: string | null }) => void;
    vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await useChatStore.getState().setClaudeUltracode(true);
    const sending = useChatStore.getState().send("hi", []);
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
    const runId = vi.mocked(ipc.sendMessage).mock.calls[0][0].runId!;
    expect(useChatStore.getState().bySession[DRAFT].liveLaunch?.claudeUltracode).toBe(true);
    await useChatStore.getState().setClaudeUltracode(false);
    if (route === "event") handleEngineEvents([{ runId, sessionId: null, engine: "claude", seq: 1, kind: "session", data: native.sessionId }], deps());
    finish({ runId, sessionId: native.sessionId });
    await sending;
    await flush();
    expect(ipc.rememberClaudeUltracode).toHaveBeenLastCalledWith(native.sessionId, false);
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
    expect(useChatStore.getState().bySession[KEY].liveLaunch?.claudeUltracode).toBe(true);
    expect(useChatStore.getState().active?.claudeUltracode).toBeUndefined();
  });

  it("sends a background session's choice and clears the switch when retargeting a draft", async () => {
    const other = { ...native, sessionId: "foreground" };
    useChatStore.setState({ active: other, openTabs: [native, other], bySession: { [KEY]: { ...EMPTY_SESSION, claudeUltracode: true }, "claude/foreground": { ...EMPTY_SESSION, claudeUltracode: false } } });
    await useChatStore.getState().send("hi", [], undefined, native);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: native.sessionId, claudeUltracode: true }));
    useChatStore.setState({ active: pendingTab, openTabs: [pendingTab] });
    await useChatStore.getState().setClaudeUltracode(true);
    useChatStore.getState().setActiveEngine("omp");
    expect(useChatStore.getState().active?.claudeUltracode).toBeUndefined();
    expect(useChatStore.getState().bySession[sessionKey("omp", null, WS)].claudeUltracode).toBeUndefined();
  });

  it("serializes rapid writes and protects a newer pick from an older refresh/failure", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(ipc.rememberClaudeUltracode).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    useChatStore.setState({ active: native, openTabs: [native] });
    const first = useChatStore.getState().setClaudeUltracode(true);
    await vi.waitFor(() => expect(ipc.rememberClaudeUltracode).toHaveBeenCalledTimes(1));
    const second = useChatStore.getState().setClaudeUltracode(false);
    vi.mocked(ipc.listSessions).mockResolvedValueOnce([meta(true)]);
    await useChatStore.getState().refreshSessions();
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
    reject(new Error("stale failure"));
    await Promise.all([first, second]);
    expect(ipc.rememberClaudeUltracode).toHaveBeenLastCalledWith(native.sessionId, false);
    expect(useChatStore.getState().actionError).toBeNull();
  });

  it.each(["session", "default"])("exposes a %s persistence failure", async (target) => {
    if (target === "session") {
      useChatStore.setState({ active: native, openTabs: [native] });
      vi.mocked(ipc.rememberClaudeUltracode).mockRejectedValueOnce(new Error("save failed"));
    } else vi.mocked(ipc.updateAppSettings).mockRejectedValueOnce(new Error("save failed"));
    await useChatStore.getState().setClaudeUltracode(true);
    expect(useChatStore.getState().actionError).toContain("save failed");
  });

  it("keeps a session write failure visible when an unrelated session writes later", async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(ipc.rememberClaudeUltracode).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    useChatStore.setState({ active: native, openTabs: [native] });
    const first = useChatStore.getState().setClaudeUltracode(true);
    await vi.waitFor(() => expect(ipc.rememberClaudeUltracode).toHaveBeenCalledTimes(1));
    const sibling = { ...native, sessionId: "sibling" };
    useChatStore.setState({ active: sibling, openTabs: [native, sibling] });
    const second = useChatStore.getState().setClaudeUltracode(false);
    reject(new Error("session A save failed"));
    await Promise.all([first, second]);
    expect(useChatStore.getState().actionError).toContain("session A save failed");
    expect(ipc.rememberClaudeUltracode).toHaveBeenLastCalledWith(sibling.sessionId, false);
  });

  it("protects a pick whose write finishes after refresh starts but before its old query returns", async () => {
    let finishWrite!: () => void;
    let finishQuery!: (rows: SessionMeta[]) => void;
    useChatStore.setState({ active: native, openTabs: [native], bySession: { [KEY]: { ...EMPTY_SESSION, claudeUltracode: true } } });
    vi.mocked(ipc.rememberClaudeUltracode).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    const writing = useChatStore.getState().setClaudeUltracode(false);
    await vi.waitFor(() => expect(ipc.rememberClaudeUltracode).toHaveBeenCalledTimes(1));
    vi.mocked(ipc.listSessions).mockImplementationOnce(() => new Promise((resolve) => { finishQuery = resolve; }));
    const refreshing = useChatStore.getState().refreshSessions();
    finishWrite();
    await writing;
    finishQuery([meta(true)]);
    await refreshing;
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
    expect(useChatStore.getState().sessions.find((row) => row.sessionId === native.sessionId)?.claudeUltracode).toBe(false);
    // A stale metadata row must not undo the choice when the closed-tab cache
    // is evicted and a subsequent open restores solely from the session list.
    useChatStore.setState({ active: null, openTabs: [], bySession: {} });
    await useChatStore.getState().selectSession("claude", native.sessionId, WS);
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
  });

  it("ignores a refresh that began before completed toggles even when the final choice equals the initial value", async () => {
    let finish!: (rows: SessionMeta[]) => void;
    useChatStore.setState({ active: native, openTabs: [native], bySession: { [KEY]: { ...EMPTY_SESSION, claudeUltracode: false } } });
    vi.mocked(ipc.listSessions).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refreshing = useChatStore.getState().refreshSessions();
    await useChatStore.getState().setClaudeUltracode(true);
    await useChatStore.getState().setClaudeUltracode(false);
    finish([meta(true)]);
    await refreshing;
    expect(useChatStore.getState().bySession[KEY].claudeUltracode).toBe(false);
  });

  it("normalizes legacy Claude effort while leaving other engines and Ultracode independent", () => {
    expect(resolveSessionEffort({ ...native }, { ...EMPTY_SESSION, activeEffort: "ultra" }, "low")).toBe("max");
    expect(resolveSessionEffort({ ...native, engine: "codex" }, { ...EMPTY_SESSION, activeEffort: "ultra" }, "low")).toBe("ultra");
  });
});
