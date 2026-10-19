import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION, drainPending, flushPendingStreams, runRouting, untrackRun, type SessionState } from "./store/stream";
import { dropRunUsage, settledRuns } from "./store/engine-events";
import {
  FOLLOW_UP_GUARD_MS,
  INTERRUPT_DEBOUNCE_MS,
  INTERRUPT_GRACE_MS,
  liveFollowUpBlocker,
} from "./store/live-follow-up";
import { hasAgentBlock } from "./components/agent-block";
import { clearSelectedAgent, selectSelectedAgent } from "@/features/agents/selected-agent";
import { publishCursorCatalog, writeCursorModelParams } from "@/components/application/ai-chat/cursor-models";

/** Pins the interaction rules written in docs/ui-ux-spec.zh-CN.md (「Claude 原生
 *  后台任务」): while a native run idles with background tasks still running, a
 *  typed message goes straight into the live CLI (as the native CLI takes it);
 *  a message typed while a reply generates queues and is released at the idle
 *  boundary; every Claude Stop uses native interrupt without killing the run.
 *  The run's final done/error still drains what
 *  could not go in. */

let deliver: ((events: EngineEventPayload[]) => void) | null = null;

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => []),
    sendMessage: vi.fn(async (args: { runId?: string }) => ({
      runId: args.runId ?? `auto-run-${++runCounter}`,
      sessionId: null,
    })),
    sendFollowUp: vi.fn(async () => true),
    interruptTurn: vi.fn(async () => true),
    interruptSession: vi.fn(async () => true),
    grantRoot: vi.fn(async () => {}),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    rememberClaudeUltracode: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    getCliConfig: vi.fn(async () => ({})),
    usageRecord: vi.fn(async () => {}),
    computerUseSetActive: vi.fn(async () => {}),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({
      id: "built-in-1",
      name: "Reviewer",
      icon: "🧐",
      prompt: "Review carefully.",
      promptHash: "hash",
    })),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async (cb: (events: EngineEventPayload[]) => void) => {
    deliver = cb;
    return () => {};
  }),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const KEY = sessionKey("claude", "s-1", WS);
type Tab = { engine: string; sessionId: string; workspacePath: string; model?: string };
const TAB: Tab = { engine: "claude", sessionId: "s-1", workspacePath: WS };
let runCounter = 0;
let RUN = "";
let seq = 0;

const event = (kind: EngineEventPayload["kind"], data: unknown, runId = RUN): EngineEventPayload => ({
  runId,
  sessionId: "s-1",
  engine: "claude",
  seq: ++seq,
  kind,
  data,
});
const emit = (...events: EngineEventPayload[]) => deliver?.(events);
const task = { id: "bash-1", kind: "local_bash", description: "Build", status: "running" };
const state = () => useChatStore.getState();
const session = (): SessionState => state().bySession[KEY];
const queueTexts = () => session().queue.map((q) => q.text);
const userTexts = () => session().messages.filter((m) => m.role === "user").map((m) => m.text);
const setSession = (patch: Partial<SessionState>) =>
  useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], ...patch } } }));

async function flush() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/** The sidebar meta the session refresh reads the remembered picker spelling from. */
const metaOf = (model: string | null, effort: string | null = null) => ({
  engine: "claude",
  sessionId: "s-1",
  workspacePath: WS,
  filePath: "s.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "t",
  preview: "",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 2,
  pinned: false,
  customTitle: null,
  model,
  effort,
});

/** A pending directory-grant card, as the permission denial leaves it. */
const grantCard = (seq = 90) =>
  ({ seq, role: "grant", text: "Access denied", path: "/data/shared", ts: null, grant: { status: "pending" } }) as never;

/** Launch a real run through the store (so the launch settings are recorded the
 *  way production records them), then forget the launch call itself. */
async function launch(tab: Tab = TAB) {
  useChatStore.setState({ active: tab, openTabs: [tab] });
  await state().send("build", [], undefined, tab);
  RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
  vi.mocked(ipc.sendMessage).mockClear();
}

/** The CLI generates a reply while a background task runs. */
function generating() {
  emit(event("activity", { state: "running" }), event("tasks", { tasks: [task] }), event("delta", "Partial reply"));
}

/** Reply finished, a background task still runs: "waiting for background tasks". */
function enterWaiting() {
  emit(
    event("activity", { state: "running" }),
    event("tasks", { tasks: [task] }),
    event("delta", "Started the build."),
    event("turn_complete", { usage: { input_tokens: 10, output_tokens: 4 } }),
    event("activity", { state: "waiting" }),
  );
}

/** What the CLI does after a delivered message: its own turn, then idle again. */
function cliAnswers(text = "Done.") {
  emit(
    event("activity", { state: "running" }),
    event("delta", text),
    event("turn_complete", { usage: null }),
    event("activity", { state: "waiting" }),
  );
}

describe("native run waiting for background tasks", () => {
  beforeAll(async () => {
    await useChatStore.getState().init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seq = 0;
    runRouting.clear();
    settledRuns.clear();
    for (const id of ["other-run"]) {
      untrackRun(id);
      dropRunUsage(id);
    }
    drainPending(KEY);
    useChatStore.setState({
      active: TAB,
      activeEngine: "claude",
      openTabs: [TAB],
      models: { claude: "claude-sonnet-4" },
      efforts: {},
      defaultClaudeUltracode: false,
      providers: {},
      engines: [
        {
          id: "claude",
          available: true,
          enabled: true,
          supportsImages: true,
          supportsComputerUse: true,
          permissions: ["auto", "manual", "plan", "bypass"],
        } as never,
      ],
      permission: "auto",
      streamingByKey: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "earlier", ts: null }],
        },
      },
    });
  });

  describe("launch record", () => {
    it("remembers what the CLI process was launched with", async () => {
      await launch();
      expect(session().liveLaunch).toEqual({
        model: "claude-sonnet-4",
        effort: null,
        claudeUltracode: false,
        claudeHaikuAssist: false,
        provider: null,
        permission: "auto",
      });
    });

    it("forgets it, and every other per-run live state, for a run this client did not launch", async () => {
      await launch();
      setSession({ followUpAt: Date.now(), queueParked: true, interruptRequestedAt: Date.now() });
      emit(event("delta", "from the phone", "other-run"));
      expect(session().nativeTaskRunId).toBe("other-run");
      expect(session()).toMatchObject({ followUpAt: null, queueParked: false, interruptRequestedAt: null });
      expect(session().liveLaunch).toBeUndefined();
    });
  });

  describe("a message typed while the CLI idles", () => {
    it("queues an Ultracode change until the next launch and uses the latest pick", async () => {
      await state().setClaudeUltracode(true);
      await launch();
      enterWaiting();
      await state().setClaudeUltracode(false);
      expect(liveFollowUpBlocker(state(), TAB, session())).toBe("settings-changed");
      await state().sendWhileBusy("use the new switch", [], undefined, TAB);
      cliAnswers();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["use the new switch"]);
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "use the new switch", claudeUltracode: false }));
      expect(session().liveLaunch?.claudeUltracode).toBe(false);
    });

    it("goes straight into the live CLI instead of queueing", async () => {
      await launch();
      enterWaiting();
      expect(session().nativeActivity).toBe("waiting");
      const rows = session().messages.length;

      await state().sendWhileBusy("then deploy", [], undefined, TAB);

      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith({
        sessionId: RUN,
        engine: "claude",
        workspacePath: WS,
        prompt: "then deploy",
        imagePaths: null,
      });
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual([]);
      expect(session().messages).toHaveLength(rows + 1);
      expect(session().messages.at(-1)).toMatchObject({ role: "user", text: "then deploy" });
      expect(session()).toMatchObject({ streaming: true, nativeActivity: "running", turnUsage: null, error: null });
      expect(session().turnStartedAt).not.toBeNull();
      expect(session().followUpAt).not.toBeNull();
      expect(runRouting.get(RUN)).toBe(KEY);
    });

    it("carries image attachments the way a launch does", async () => {
      await launch();
      enterWaiting();
      await state().sendWhileBusy("look at this", ["/img/a.png"], undefined, TAB);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "look at this", imagePaths: ["/img/a.png"] }));
      expect(session().messages.at(-1)).toMatchObject({ role: "user", images: ["/img/a.png"] });
    });

    it("turns the CLI's own answer into the next reply and idles again", async () => {
      await launch();
      enterWaiting();
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      cliAnswers("Deploying.");
      expect(session()).toMatchObject({ streaming: true, nativeActivity: "waiting", followUpAt: null });
      expect(session().messages.at(-1)).toMatchObject({ role: "assistant", text: "Deploying.", live: false });
    });

    it("is an ordinary send when the turn ended between the composer's look and the call", async () => {
      await launch();
      enterWaiting();
      setSession({ streaming: false });
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual([]);
    });

    it.each<{
      name: string;
      arrange: () => void;
      options?: { computerUse: boolean };
      tab?: Tab;
    }>([
      { name: "the reply is still generating", arrange: () => setSession({ nativeActivity: "running" }) },
      { name: "the CLI waits on the user", arrange: () => setSession({ nativeActivity: "requires_action" }) },
      { name: "Stop killed the run", arrange: () => setSession({ interrupted: true }) },
      { name: "it is a computer-use task", arrange: () => {}, options: { computerUse: true } },
      {
        name: "a question card is pending",
        arrange: () =>
          setSession({
            messages: [...session().messages, { seq: 99, role: "question", text: "", ts: null, question: { status: "pending" } } as never],
          }),
      },
      {
        name: "a directory grant card is pending",
        arrange: () =>
          setSession({
            messages: [...session().messages, { seq: 99, role: "grant", text: "", ts: null, grant: { status: "pending" } } as never],
          }),
      },
      {
        name: "a plan awaits approval",
        arrange: () =>
          setSession({
            messages: [...session().messages, { seq: 99, role: "plan", text: "", ts: null, planReview: { status: "awaiting_review" } } as never],
          }),
      },
      { name: "the permission changed after launch", arrange: () => useChatStore.setState({ permission: "plan" }) },
      { name: "the provider changed after launch", arrange: () => setSession({ activeProvider: "other-channel" }) },
      { name: "the effort changed after launch", arrange: () => setSession({ activeEffort: "high" }) },
      { name: "the model changed after launch", arrange: () => {}, tab: { ...TAB, model: "claude-opus-4" } },
      { name: "the run is no longer routed", arrange: () => runRouting.delete(RUN) },
      { name: "the run was adopted from another client", arrange: () => setSession({ liveLaunch: undefined }) },
    ])("keeps queueing when $name", async ({ arrange, options, tab }) => {
      await launch();
      enterWaiting();
      arrange();

      await state().sendWhileBusy("then deploy", [], options, tab ?? TAB);

      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });

    it("keeps queueing for an engine that has no native background run", async () => {
      const codex: Tab = { engine: "codex", sessionId: "c-1", workspacePath: WS };
      const key = sessionKey("codex", "c-1", WS);
      useChatStore.setState({
        active: codex,
        openTabs: [codex],
        bySession: {
          [key]: {
            ...EMPTY_SESSION,
            streaming: true,
            nativeTaskRunId: "codex-run",
            nativeActivity: "waiting",
            liveLaunch: { model: null, effort: null, provider: null, permission: "auto" },
          },
        },
      });
      runRouting.set("codex-run", key);
      await state().sendWhileBusy("then deploy", [], undefined, codex);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(state().bySession[key].queue.map((q) => q.text)).toEqual(["then deploy"]);
    });

    it("keeps a picked model from blocking: the CLI's own model report is not a pick", async () => {
      const picked: Tab = { ...TAB, model: "sonnet" };
      await launch(picked);
      // The CLI reports the full model id on every assistant message.
      emit(event("model", "claude-sonnet-4-5-20250929"), event("effort", "medium"));
      enterWaiting();
      await state().sendWhileBusy("then deploy", [], undefined, picked);
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
    });

    it("accepts the CLI's report beside the launch spelling, but a pick made after launch still blocks", async () => {
      await launch();
      emit(event("model", "claude-sonnet-4-5-20250929"), event("effort", "medium"));
      // The launch spelling is kept; the report is recorded next to it.
      expect(session().liveLaunch).toMatchObject({
        model: "claude-sonnet-4",
        reportedModel: "claude-sonnet-4-5-20250929",
        effort: null,
        reportedEffort: "medium",
      });
      enterWaiting();
      await state().sendWhileBusy("one", [], undefined, TAB);
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);

      // The user switches the model in the picker: a new process would be needed.
      cliAnswers();
      await state().sendWhileBusy("two", [], undefined, { ...TAB, model: "claude-opus-4" });
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(queueTexts()).toEqual(["two"]);
      // A later report of the old model does not make the pick disappear.
      emit(event("model", "claude-sonnet-4-5-20250929"));
      expect(session().liveLaunch).toMatchObject({ model: "claude-sonnet-4", reportedModel: "claude-sonnet-4-5-20250929" });
      expect(liveFollowUpBlocker(state(), { ...TAB, model: "claude-opus-4" }, session())).toBe("settings-changed");
    });

    it("keeps a picker change made before the CLI's report apart from it", async () => {
      await launch();
      // The user picks an effort after launch ...
      setSession({ activeEffort: "high" });
      // ... then the CLI reports the effort it runs.
      emit(event("effort", "medium"));
      enterWaiting();
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });

    describe("the CLI's full model id and the picker's spelling of it", () => {
      it("stay one setting while the report and the session refresh take turns writing it", async () => {
        useChatStore.setState({ models: { claude: "opus" }, efforts: { claude: "high" } });
        await launch();
        expect(session().liveLaunch).toMatchObject({ model: "opus", effort: "high" });
        // The CLI names the model and level it runs (not the picker's words) ...
        emit(event("model", "claude-opus-5"), event("effort", "think-hard"));
        enterWaiting();
        expect(session()).toMatchObject({ activeModel: "claude-opus-5", activeEffort: "think-hard" });
        expect(liveFollowUpBlocker(state(), TAB, session())).toBeNull();

        // ... then the session refresh writes the remembered picker spelling back.
        vi.mocked(ipc.listSessions).mockResolvedValueOnce([metaOf("opus", "high")] as never);
        await state().refreshSessions();
        expect(session()).toMatchObject({ activeModel: "opus", activeEffort: "high" });
        expect(liveFollowUpBlocker(state(), TAB, session())).toBeNull();

        // The next assistant message reports again; the same two spellings alternate.
        emit(event("model", "claude-opus-5"));
        expect(liveFollowUpBlocker(state(), TAB, session())).toBeNull();
        vi.mocked(ipc.listSessions).mockResolvedValueOnce([metaOf("opus", "high")] as never);
        await state().refreshSessions();

        await state().sendWhileBusy("then deploy", [], undefined, TAB);
        expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
        expect(queueTexts()).toEqual([]);
      });

      it("still queue a message when the user really picks another model or level", async () => {
        useChatStore.setState({ models: { claude: "opus" }, efforts: { claude: "high" } });
        await launch();
        emit(event("model", "claude-opus-5"), event("effort", "think-hard"));
        vi.mocked(ipc.listSessions).mockResolvedValueOnce([metaOf("opus", "high")] as never);
        await state().refreshSessions();
        enterWaiting();

        expect(liveFollowUpBlocker(state(), { ...TAB, model: "sonnet" }, session())).toBe("settings-changed");
        setSession({ activeEffort: "low" });
        expect(liveFollowUpBlocker(state(), TAB, session())).toBe("settings-changed");
        await state().sendWhileBusy("then deploy", [], undefined, TAB);
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();
        expect(queueTexts()).toEqual(["then deploy"]);
      });
    });
  });

  describe("a directory grant approved after launch", () => {
    /** The CLI parked a denial for /data/shared; the card is still pending. */
    async function launchWithPendingGrant() {
      await launch();
      enterWaiting();
      setSession({ messages: [...session().messages, grantCard()] });
    }

    it("keeps follow-ups out of the process that cannot use it: they queue and the next launch carries the grant", async () => {
      await launchWithPendingGrant();
      await state().respondToGrant(KEY, 90, true);
      expect(ipc.grantRoot).toHaveBeenCalledWith("/data/shared");
      expect(session().messages.find((m) => m.seq === 90)?.grant?.status).toBe("granted");
      expect(session().liveLaunch?.grantedSinceLaunch).toBe(true);
      expect(liveFollowUpBlocker(state(), TAB, session())).toBe("grant-after-launch");

      state().queueMessage("queued row", [], undefined, TAB);
      await state().sendWhileBusy("then read it", [], undefined, TAB);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["queued row", "then read it"]);

      // The idle boundary does not release into the old process either.
      cliAnswers();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["queued row", "then read it"]);

      // The final done sends the head as a fresh launch ...
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "queued row" }));
      // ... which carries a clean launch record: live follow-ups work again.
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      expect(session().liveLaunch?.grantedSinceLaunch).toBeUndefined();
      // The fresh process takes the rest of the queue live again at its idle boundary.
      enterWaiting();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then read it" }));
      expect(queueTexts()).toEqual([]);
    });

    it("does not touch a declined grant or one the backend failed to store", async () => {
      await launchWithPendingGrant();
      await state().respondToGrant(KEY, 90, false);
      expect(ipc.grantRoot).not.toHaveBeenCalled();
      expect(liveFollowUpBlocker(state(), TAB, session())).toBeNull();

      setSession({ messages: [...session().messages, grantCard(91)] });
      vi.mocked(ipc.grantRoot).mockRejectedValueOnce(new Error("db locked"));
      await state().respondToGrant(KEY, 91, true);
      expect(session().error).toContain("db locked");
      expect(session().liveLaunch?.grantedSinceLaunch).toBeUndefined();
    });

    it("also covers a live run in another session: the grant is global but only a new launch carries it", async () => {
      await launch();
      enterWaiting();
      const other = sessionKey("claude", "s-2", WS);
      useChatStore.setState((s) => ({
        bySession: { ...s.bySession, [other]: { ...EMPTY_SESSION, messages: [grantCard()] } },
      }));

      await state().respondToGrant(other, 90, true);

      expect(session().liveLaunch?.grantedSinceLaunch).toBe(true);
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });
  });

  describe("with an agent pinned", () => {
    beforeEach(() => clearSelectedAgent(WS, "s-1"));
    // A failing test must not leave its pin behind for the ones after it.
    afterEach(() => clearSelectedAgent(WS, "s-1"));

    it("appends the agent block to the follow-up like a launch does", async () => {
      selectSelectedAgent(WS, "s-1", { id: "a1", name: "Reviewer", icon: "🧐", prompt: "Review carefully.", source: "custom" });
      await launch();
      enterWaiting();
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      const prompt = vi.mocked(ipc.sendFollowUp).mock.calls[0][0].prompt;
      expect(prompt.startsWith("then deploy")).toBe(true);
      expect(hasAgentBlock(prompt)).toBe(true);
      expect(session().messages.at(-1)?.text).toBe(prompt);
      clearSelectedAgent(WS, "s-1");
    });

    it("does not let a parked row overtake an explicit send that is still being prepared", async () => {
      selectSelectedAgent(WS, "s-1", { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
      await launch();
      state().queueMessage("parked row", [], undefined, TAB);
      setSession({ queueParked: true });
      enterWaiting();
      let resolveAgent!: (agent: never) => void;
      vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(
        () => new Promise((resolve) => { resolveAgent = resolve as never; }),
      );

      const explicit = state().sendWhileBusy("explicit", [], undefined, TAB);
      // A computer-use task cannot go live; sending it lifts the park.
      await state().sendWhileBusy("drive it", [], { computerUse: true }, TAB);
      expect(session().queueParked).toBe(false);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();

      resolveAgent({ name: "Reviewer", icon: "🧐", prompt: "Review carefully." } as never);
      await explicit;
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ipc.sendFollowUp).mock.calls[0][0].prompt.startsWith("explicit")).toBe(true);
      expect(queueTexts()).toEqual(["parked row", "drive it"]);
      clearSelectedAgent(WS, "s-1");
    });

    it("queues the typed text when the CLI moved on while a built-in agent was being resolved", async () => {
      selectSelectedAgent(WS, "s-1", { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
      await launch();
      enterWaiting();
      let resolveAgent!: (agent: never) => void;
      vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(
        () => new Promise((resolve) => { resolveAgent = resolve as never; }),
      );

      const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
      // The CLI's own notification turn starts while the catalog prompt loads.
      emit(event("activity", { state: "running" }), event("delta", "Notified."));
      resolveAgent({ name: "Reviewer", icon: "🧐", prompt: "Review carefully." } as never);
      await sent;

      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
      expect(userTexts()).not.toContain("then deploy");
      expect(session().followUpAt).toBeNull();
      clearSelectedAgent(WS, "s-1");
    });

    describe("a queued row released to the live CLI while its built-in agent is being resolved", () => {
      /** The idle boundary takes "queued row" out of the queue; the catalog
       *  prompt is still loading, so the live check is repeated after it. */
      async function releaseWhileResolving() {
        selectSelectedAgent(WS, "s-1", { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
        await launch();
        state().queueMessage("queued row", [], undefined, TAB);
        let resolveAgent!: (agent: never) => void;
        vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(
          () => new Promise((resolve) => { resolveAgent = resolve as never; }),
        );
        enterWaiting();
        expect(queueTexts()).toEqual([]);
        expect(session().followUpAt).not.toBeNull();
        return () => resolveAgent({ name: "Reviewer", icon: "🧐", prompt: "Review carefully." } as never);
      }

      it("is sent the ordinary way when the run ended meanwhile: nothing else would drain an idle session", async () => {
        const resolve = await releaseWhileResolving();
        // The last task completes and the process exits: the final done drains a queue that no longer holds the row.
        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
        await flush();
        expect(session().streaming).toBe(false);
        expect(ipc.sendMessage).not.toHaveBeenCalled();

        resolve();
        await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));

        expect(ipc.sendFollowUp).not.toHaveBeenCalled();
        expect(vi.mocked(ipc.sendMessage).mock.calls[0][0].prompt.startsWith("queued row")).toBe(true);
        expect(queueTexts()).toEqual([]);
        expect(userTexts().filter((text) => text.startsWith("queued row"))).toHaveLength(1);
        expect(session().streaming).toBe(true);
      });

      it("stays at the head of the queue while the run goes on, and is released at the next idle boundary", async () => {
        const resolve = await releaseWhileResolving();
        // The CLI's own notification turn starts while the catalog prompt loads.
        emit(event("activity", { state: "running" }), event("delta", "Notified."));

        resolve();
        await vi.waitFor(() => expect(queueTexts()).toEqual(["queued row"]));
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();
        expect(ipc.sendMessage).not.toHaveBeenCalled();
        expect(userTexts()).not.toContain("queued row");
        expect(session().followUpAt).toBeNull();

        cliAnswers("Build finished.");
        await vi.waitFor(() => expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1));
        expect(vi.mocked(ipc.sendFollowUp).mock.calls[0][0].prompt.startsWith("queued row")).toBe(true);
      });

      it("stays queued behind a Stop that interrupted while the agent was resolving", async () => {
        const resolve = await releaseWhileResolving();
        await state().interrupt(TAB);
        expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
        expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
        expect(ipc.interruptSession).not.toHaveBeenCalled();

        resolve();
        await vi.waitFor(() => expect(queueTexts()).toEqual(["queued row"]));
        await flush();

        expect(ipc.sendMessage).not.toHaveBeenCalled();
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();
        expect(queueTexts()).toEqual(["queued row"]);
      });

      it("accepts a waiting interrupt acknowledgement while live preparation still holds its delivery guard", async () => {
        const resolve = await releaseWhileResolving();
        await state().interrupt(TAB);
        expect(session().interruptRequestedAt).not.toBeNull();
        emit(event("activity", { state: "waiting" }));
        const pendingInterrupt = session().interruptRequestedAt;
        resolve();
        await vi.waitFor(() => expect(queueTexts()).toEqual(["queued row"]));
        expect(pendingInterrupt).toBeNull();
        expect(session()).toMatchObject({ interruptRequestedAt: null, queueParked: true, followUpAt: null });
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();
        expect(ipc.sendMessage).not.toHaveBeenCalled();
      });
    });

    it.each([false, true])("keeps a composer message queued when Stop arrives during agent preparation, done=%s", async (done) => {
      selectSelectedAgent(WS, "s-1", { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
      await launch();
      enterWaiting();
      let resolveAgent!: (agent: never) => void;
      vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(() => new Promise((resolve) => { resolveAgent = resolve as never; }));
      const sending = state().sendWhileBusy("cancelled while preparing", [], undefined, TAB);
      await flush();
      await state().interrupt(TAB);
      if (done) emit(event("done", { usage: null }));
      resolveAgent({ name: "Reviewer", prompt: "Review carefully." } as never);
      await sending;
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["cancelled while preparing"]);
      expect(userTexts().some((text) => text.startsWith("cancelled while preparing"))).toBe(false);
    });

    it("lifts a Stop's park when an explicit send falls back to the queue after its agent block was resolved", async () => {
      selectSelectedAgent(WS, "s-1", { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
      await launch();
      state().queueMessage("parked row", [], undefined, TAB);
      setSession({ queueParked: true });
      enterWaiting();
      let resolveAgent!: (agent: never) => void;
      vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(
        () => new Promise((resolve) => { resolveAgent = resolve as never; }),
      );

      // The CLI idles, so the explicit send takes the direct live path (which does not lift the park).
      const explicit = state().sendWhileBusy("explicit", [], undefined, TAB);
      expect(session().queueParked).toBe(true);
      // The CLI's own notification turn starts while the catalog prompt loads.
      emit(event("activity", { state: "running" }), event("delta", "Notified."));
      resolveAgent({ name: "Reviewer", icon: "🧐", prompt: "Review carefully." } as never);
      await explicit;

      // Left parked, nothing would ever send it: the release refuses and the final done keeps a parked queue.
      expect(session().queueParked).toBe(false);
      expect(queueTexts()).toEqual(["parked row", "explicit"]);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(userTexts()).not.toContain("explicit");

      // The next idle boundary releases the queue, FIFO and one row per boundary.
      cliAnswers("Build finished.");
      await vi.waitFor(() => expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1));
      expect(vi.mocked(ipc.sendFollowUp).mock.calls[0][0].prompt.startsWith("parked row")).toBe(true);
      expect(queueTexts()).toEqual(["explicit"]);
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
      expect(vi.mocked(ipc.sendMessage).mock.calls[0][0].prompt.startsWith("explicit")).toBe(true);
    });
  });

  describe("when the live CLI cannot take the message", () => {
    it.each([false, true])("keeps an accepted follow-up out of retries when its outcome is unknown (done first: %s)", async (doneFirst) => {
      await launch();
      enterWaiting();
      let reject!: (error: unknown) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
      const sending = state().sendWhileBusy("already applied 中文😀", [], undefined, TAB);
      if (!doneFirst) state().queueMessage("later", [], undefined, TAB);
      emit(event("delta", "applied upstream"));
      if (doneFirst) emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      reject(JSON.stringify({ code: "transport_timeout", message: "response unavailable", outcomeUnknown: true }));
      await sending;
      expect(session().error).toContain("response unavailable");
      if (!doneFirst) emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(userTexts().filter((text) => text === "already applied 中文😀")).toHaveLength(1);
      expect(queueTexts()).toEqual(doneFirst ? [] : ["later"]);
      expect(session().streaming).toBe(false);
    });

    it("falls back to one ordinary send, with no duplicate user row, when the run ended meanwhile", async () => {
      await launch();
      enterWaiting();
      vi.mocked(ipc.sendFollowUp).mockResolvedValueOnce(false);

      await state().sendWhileBusy("then deploy", [], undefined, TAB);

      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "then deploy", engine: "claude", sessionId: "s-1" }),
      );
      expect(userTexts().filter((text) => text === "then deploy")).toHaveLength(1);
      expect(queueTexts()).toEqual([]);
      expect(session().followUpAt).toBeNull();
      expect(session().nativeTaskRunId).not.toBe(RUN);
      expect(session().streaming).toBe(true);
    });

    it("shows the error, keeps the text in the queue and does not retry it at every idle boundary", async () => {
      await launch();
      enterWaiting();
      vi.mocked(ipc.sendFollowUp).mockRejectedValueOnce(new Error("pipe closed"));

      await state().sendWhileBusy("then deploy", ["/img/a.png"], undefined, TAB);

      expect(session().error).toContain("pipe closed");
      expect(session().nativeActivity).toBe("waiting");
      expect(session().streaming).toBe(true);
      expect(session().followUpAt).toBeNull();
      expect(userTexts()).not.toContain("then deploy");
      expect(session().queue).toMatchObject([{ text: "then deploy", images: ["/img/a.png"], noLive: true }]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();

      cliAnswers();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);

      // The final done sends it the ordinary way.
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy", imagePaths: ["/img/a.png"] }));
      expect(queueTexts()).toEqual([]);
    });

    it("accepts a message sent as the last task completes: nothing is sent twice", async () => {
      await launch();
      enterWaiting();
      let resolveIpc!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveIpc = resolve; }));

      const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
      // The task completes and the CLI's own notification turn starts before
      // the CLI reads our message.
      emit(
        event("tasks", { tasks: [{ ...task, status: "completed" }] }),
        event("activity", { state: "running" }),
        event("delta", "Build finished."),
        event("turn_complete", { usage: null }),
      );
      resolveIpc(true);
      await sent;
      // Its turn for our message, then the final done.
      emit(event("activity", { state: "running" }), event("delta", "Deploying."), event("turn_complete", { usage: null }), event("done", { usage: null }));
      await flush();

      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(userTexts().filter((text) => text === "then deploy")).toHaveLength(1);
      expect(session().messages.filter((m) => m.role === "assistant").map((m) => m.text)).toEqual(
        expect.arrayContaining(["Build finished.", "Deploying."]),
      );
      expect(session()).toMatchObject({ streaming: false, error: null, followUpAt: null });
    });

    it("does not restart a run the user stopped while the message was on its way", async () => {
      await launch();
      enterWaiting();
      let resolveIpc!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveIpc = resolve; }));
      const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
      // Stop kills the run (the CLI has nothing to interrupt); that closes stdin.
      vi.mocked(ipc.interruptTurn).mockResolvedValueOnce(false);
      await state().interrupt(TAB);
      resolveIpc(false);
      await sent;
      await flush();

      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(session().interrupted).toBe(true);
      expect(userTexts()).not.toContain("then deploy");
      expect(queueTexts()).toEqual(["then deploy"]);
    });

    describe("when the run ended and its queue drain started the next run before the reply came", () => {
      /** The message is on its way; the final done lands first and starts the
       *  next run from a row the live path could not take. Returns the reply gate
       *  and the id of that next run. */
      async function endRunWhileDelivering() {
        await launch();
        enterWaiting();
        state().queueMessage("drive it", [], { computerUse: true }, TAB);
        let settle!: { resolve: (value: boolean) => void; reject: (error: Error) => void };
        vi.mocked(ipc.sendFollowUp).mockImplementationOnce(
          () => new Promise<boolean>((resolve, reject) => { settle = { resolve, reject }; }),
        );
        const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
        await flush();
        // The next run is live: the drained row started it.
        expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
        expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "drive it" }));
        const nextRun = vi.mocked(ipc.sendMessage).mock.calls[0][0].runId!;
        return { sent, settle, nextRun };
      }

      it("queues the undelivered message instead of launching a second concurrent run", async () => {
        const { sent, settle, nextRun } = await endRunWhileDelivering();
        settle.resolve(false);
        await sent;
        await flush();

        // One launch only: a second process on the same session is the bug.
        expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
        expect(queueTexts()).toEqual(["then deploy"]);
        expect(userTexts()).not.toContain("then deploy");
        expect(session()).toMatchObject({ streaming: true, nativeTaskRunId: nextRun });

        // The next run final done sends it.
        emit(event("done", { usage: null }, nextRun));
        await flush();
        expect(ipc.sendMessage).toHaveBeenCalledTimes(2);
        expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "then deploy" }));
        expect(queueTexts()).toEqual([]);
      });

      it("keeps a failed delivery queued for that run instead of stranding it", async () => {
        const { sent, settle, nextRun } = await endRunWhileDelivering();
        settle.reject(new Error("broken pipe"));
        await sent;
        await flush();

        expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
        expect(session().queue).toMatchObject([{ text: "then deploy", noLive: true }]);
        emit(event("done", { usage: null }, nextRun));
        await flush();
        expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "then deploy" }));
        expect(queueTexts()).toEqual([]);
      });
    });

    it("sends a message the ordinary way when its delivery failed because the run had already ended", async () => {
      await launch();
      enterWaiting();
      let reject!: (error: Error) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
      const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
      // The process exited: its final done drained an empty queue, then the broken pipe is reported.
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(session().streaming).toBe(false);
      reject(new Error("broken pipe"));
      await sent;
      await flush();

      // Nothing else will drain it: it is sent now, once.
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual([]);
    });

    it("falls back exactly once when the last task completed and the run ended before the CLI took it", async () => {
      await launch();
      enterWaiting();
      let resolveIpc!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveIpc = resolve; }));

      const sent = state().sendWhileBusy("then deploy", [], undefined, TAB);
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      resolveIpc(false);
      await sent;
      await flush();

      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(userTexts().filter((text) => text === "then deploy")).toHaveLength(1);
    });
  });

  describe("queue", () => {
    it("still queues a message typed while a reply generates", async () => {
      await launch();
      generating();
      await state().sendWhileBusy("then deploy", [], undefined, TAB);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });

    it("releases the head at the idle boundary, one item per boundary", async () => {
      await launch();
      generating();
      state().queueMessage("first", [], undefined, TAB);
      state().queueMessage("second", [], undefined, TAB);

      // The reply ends: the result reports waiting ...
      emit(event("turn_complete", { usage: null }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first" }));
      expect(queueTexts()).toEqual(["second"]);
      // ... and the idle event of the same cycle reports it again.
      emit(event("activity", { state: "waiting" }));
      await flush();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(queueTexts()).toEqual(["second"]);
      expect(session().nativeActivity).toBe("running");
      expect(userTexts().slice(-1)).toEqual(["first"]);

      // The CLI answers "first", idles: the next boundary releases "second".
      cliAnswers("First answer.");
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(2);
      expect(ipc.sendFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "second" }));
      expect(queueTexts()).toEqual([]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it("releases only one item when both waiting events of a cycle arrive in one batch", async () => {
      await launch();
      generating();
      state().queueMessage("first", [], undefined, TAB);
      state().queueMessage("second", [], undefined, TAB);
      emit(
        event("turn_complete", { usage: null }),
        event("activity", { state: "waiting" }),
        event("activity", { state: "waiting" }),
      );
      await flush();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(queueTexts()).toEqual(["second"]);
    });

    it("lets a CLI that never reacts release the next item once the guard expires", async () => {
      await launch();
      generating();
      state().queueMessage("first", [], undefined, TAB);
      state().queueMessage("second", [], undefined, TAB);
      emit(event("turn_complete", { usage: null }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      // The CLI never reports anything: no event can clear the guard.
      setSession({ followUpAt: Date.now() - FOLLOW_UP_GUARD_MS - 1 });
      emit(event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(2);
      expect(ipc.sendFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "second" }));
    });

    it.each([
      ["activity running", () => event("activity", { state: "running" })],
      ["activity requires_action", () => event("activity", { state: "requires_action" })],
      ["turn_complete", () => event("turn_complete", { usage: null })],
      ["done", () => event("done", { usage: null })],
      ["error", () => event("error", "native CLI exited")],
    ])("clears the in-flight guard on %s", async (_name, make) => {
      await launch();
      enterWaiting();
      setSession({ followUpAt: Date.now() });
      emit(make());
      expect(session().followUpAt).toBeNull();
    });

    it("never releases while a Stop parked the queue, and the final done keeps it parked", async () => {
      await launch();
      state().queueMessage("then deploy", [], undefined, TAB);
      setSession({ queueParked: true });
      enterWaiting();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);

      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
      expect(session().queueParked).toBe(false);
    });

    it("lets the next explicit send lift the park and releases the parked row at the next boundary", async () => {
      await launch();
      state().queueMessage("parked row", [], undefined, TAB);
      setSession({ queueParked: true });
      enterWaiting();

      await state().sendWhileBusy("go on", [], undefined, TAB);
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "go on" }));
      expect(session().queueParked).toBe(false);
      expect(queueTexts()).toEqual(["parked row"]);

      cliAnswers();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(2);
      expect(ipc.sendFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "parked row" }));
    });

    it("keeps a head the live path cannot take queued until the final done", async () => {
      await launch();
      generating();
      state().queueMessage("drive it", [], { computerUse: true }, TAB);
      state().queueMessage("after", [], undefined, TAB);
      emit(event("turn_complete", { usage: null }), event("activity", { state: "waiting" }));
      await flush();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["drive it", "after"]);

      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "drive it", computerUse: true }));
      expect(queueTexts()).toEqual(["after"]);
    });

    it("keeps a row whose live delivery already failed queued until the final done", async () => {
      await launch();
      generating();
      state().queueMessage("then deploy", [], undefined, TAB);
      setSession({ queue: session().queue.map((q) => ({ ...q, noLive: true })) });
      emit(event("turn_complete", { usage: null }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });

    it("releases the queue at the final done, one message per settle", async () => {
      await launch();
      state().queueMessage("then deploy", [], { computerUse: true }, TAB);
      state().queueMessage("and tag it", [], undefined, TAB);
      enterWaiting();
      // A second response of the same run (notification follow-up) keeps it parked.
      cliAnswers();
      await flush();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy", "and tag it"]);

      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual(["and tag it"]);
    });

    it("releases the queue at a final error as well", async () => {
      await launch();
      state().queueMessage("then deploy", [], { computerUse: true }, TAB);
      enterWaiting();
      emit(event("error", "native CLI exited"));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual([]);
      expect(session()).toMatchObject({ followUpAt: null, queueParked: false });
    });
  });

  describe("send now", () => {
    it.each([false, true])("restarts a queued Cursor message with a base id and persisted parameters after a CLI label report (streaming=%s)", async (streaming) => {
      const tab = { engine: "cursor", sessionId: "cursor-1", workspacePath: WS };
      const key = sessionKey(tab.engine, tab.sessionId, WS);
      const original = { ...EMPTY_SESSION, streaming, activeModel: "Grok 4.7 256K High Fast" };
      publishCursorCatalog([{ id: "grok-4.7", name: "Grok 4.7", parameters: [
        { id: "context", name: "Context", current: "256k", options: [{ value: "256k", name: "256K" }, { value: "500k", name: "500K" }] },
        { id: "fast", name: "Fast", current: "true", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] },
        { id: "reasoning_effort", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
      ] }]);
      writeCursorModelParams("grok-4.7", { context: "500k", fast: "false", reasoning_effort: "low" });
      useChatStore.setState({ active: tab, openTabs: [tab], models: { cursor: "grok-4.7" }, bySession: { [key]: original }, streamingByKey: streaming ? { [key]: true } : {} });
      state().queueMessage("jump ahead", [], undefined, tab);
      const id = state().bySession[key].queue[0].id;
      try {
        await state().sendQueuedNow(id, key);
        await flush();
        expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ engine: "cursor", prompt: "jump ahead",
          model: 'grok-4.7\u001e{"context":"500k","fast":"false","reasoning_effort":"low"}' }));
        expect(ipc.rememberSessionModel).toHaveBeenCalledWith("cursor", "cursor-1", "grok-4.7");
      } finally { publishCursorCatalog([]); }
    });

    it("takes the row into an idle live CLI without killing the run", async () => {
      await launch();
      state().queueMessage("then deploy", [], undefined, TAB);
      setSession({ queueParked: true });
      enterWaiting();
      const id = session().queue[0].id;

      await state().sendQueuedNow(id);

      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.interruptTurn).not.toHaveBeenCalled();
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual([]);
      expect(session().queueParked).toBe(false);
    });

    it("interrupts only the generating reply and sends the row at the idle boundary that follows", async () => {
      await launch();
      generating();
      state().queueMessage("then deploy", [], undefined, TAB);
      const id = session().queue[0].id;

      await state().sendQueuedNow(id);

      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: false });
      expect(queueTexts()).toEqual(["then deploy"]);

      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
      expect(queueTexts()).toEqual([]);
    });

    it("interrupts without killing when the queued row needs a new launch", async () => {
      await launch();
      state().queueMessage("drive it", [], { computerUse: true }, TAB);
      enterWaiting();
      const id = session().queue[0].id;

      await state().sendQueuedNow(id);

      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["drive it"]);
      emit(event("activity", { state: "waiting" }));
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      emit(event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "drive it" }));
      expect(queueTexts()).toEqual([]);
    });

    it("settles an unavailable run locally and sends the row without a kill", async () => {
      await launch();
      generating();
      state().queueMessage("then deploy", [], undefined, TAB);
      vi.mocked(ipc.interruptTurn).mockResolvedValueOnce(false);

      await state().sendQueuedNow(session().queue[0].id);

      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
    });

    it.each<[string, () => void]>([
      ["launch settings changed", () => useChatStore.setState({ openTabs: [{ ...TAB, model: "haiku" }] })],
      ["launch settings unknown", () => setSession({ liveLaunch: undefined })],
      ["a directory was granted", () => setSession({ liveLaunch: { ...session().liveLaunch!, grantedSinceLaunch: true } })],
      ["a previous live delivery failed", () => setSession({ queue: session().queue.map((item) => ({ ...item, noLive: true })) })],
    ])("can interrupt when %s prevents delivering a follow-up", async (_name, arrange) => {
      await launch();
      generating();
      state().queueMessage("then deploy", [], undefined, TAB);
      arrange();

      await state().sendQueuedNow(session().queue[0].id);

      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
      emit(event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
    });

    it("interrupts startup before any native activity and waits for the final done", async () => {
      await launch();
      expect(session().nativeActivity).toBeNull();
      state().queueMessage("then deploy", [], undefined, TAB);

      await state().sendQueuedNow(session().queue[0].id);

      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      emit(event("activity", { state: "running" }));
      expect(session().interruptRequestedAt).not.toBeNull();
      emit(event("turn_complete", { usage: null, interrupted: true }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "then deploy" }));
    });

    it("keeps the row queued on write failure, then resends only interrupt on a later click", async () => {
      await launch();
      state().queueMessage("then deploy", [], undefined, TAB);
      vi.mocked(ipc.interruptTurn).mockRejectedValueOnce(new Error("stdin timeout"));
      const id = session().queue[0].id;
      await state().sendQueuedNow(id);
      expect(session().error).toContain("stdin timeout");
      expect(session().streaming).toBe(true);
      setSession({ interruptRequestedAt: Date.now() - INTERRUPT_GRACE_MS - 1 });
      await state().sendQueuedNow(id);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["then deploy"]);
    });
  });

  describe("Stop", () => {
    it("interrupts only the reply while background tasks run: the run and the tasks live on", async () => {
      await launch();
      generating();
      state().queueMessage("later", [], undefined, TAB);

      await state().interrupt(TAB);

      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      // Busy, routed and NOT stopped: `interrupted` would drop every later event.
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
      expect(session().interruptRequestedAt).not.toBeNull();
      expect(runRouting.get(RUN)).toBe(KEY);
      // The reply is not sealed at the IPC: the CLI may still flush before it answers.
      expect(session().messages.filter((m) => m.role === "assistant" && m.live === false)).toEqual([]);
      expect(queueTexts()).toEqual(["later"]);

      // The CLI acknowledges: an interrupted response is a response boundary.
      emit(
        event("turn_complete", { usage: { input_tokens: 3, output_tokens: 1 }, interrupted: true }),
        event("activity", { state: "waiting" }),
      );
      expect(session()).toMatchObject({ streaming: true, error: null, nativeActivity: "waiting", interruptRequestedAt: null });
      // The acknowledgement must not forget the click: a second Stop right behind it is an echo.
      expect(session().lastInterruptAt).not.toBeNull();
      expect(session().messages.at(-1)).toMatchObject({ role: "assistant", text: "Partial reply", live: false });
      expect(session().messages.at(-1)?.usage).toMatchObject({ input_tokens: 3 });
      // The Stop parked the queue: nothing is released behind it.
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["later"]);

      // The run still receives events; the final done ends the park.
      emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
      await flush();
      expect(session().nativeTasks?.[0].status).toBe("completed");
      expect(session()).toMatchObject({ streaming: false, queueParked: false });
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["later"]);
    });

    it("uses native interrupt for a Claude computer-use run too", async () => {
      await launch();
      generating();
      setSession({ activeComputerUse: true });
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
    });

    it("also interrupts a reply while a task is paused", async () => {
      await launch();
      emit(event("activity", { state: "running" }), event("tasks", { tasks: [{ ...task, status: "paused" }] }));
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
    });

    it("lets the next explicit send continue the conversation after the interrupt", async () => {
      await launch();
      generating();
      await state().interrupt(TAB);
      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));

      await state().sendWhileBusy("go on", [], undefined, TAB);

      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "go on" }));
      expect(session()).toMatchObject({ queueParked: false, interrupted: false, nativeActivity: "running" });
    });

    it.each<[string, () => void]>([
      ["startup with no native activity", () => {}],
      ["a waiting CLI (idle, tasks running)", () => enterWaiting()],
      ["a reply with no background task", () => emit(event("activity", { state: "running" }), event("delta", "Thinking"))],
      [
        "a reply with only an ambient watcher",
        () => emit(event("activity", { state: "running" }), event("tasks", { tasks: [{ ...task, ambient: true }] })),
      ],
      [
        "a reply whose tasks all finished",
        () => emit(event("activity", { state: "running" }), event("tasks", { tasks: [{ ...task, status: "completed" }] })),
      ],
      [
        "a CLI waiting on the user",
        () => emit(event("tasks", { tasks: [task] }), event("activity", { state: "requires_action" })),
      ],
    ])("uses native interrupt and parks the queue for %s", async (_name, arrange) => {
      await launch();
      arrange();
      state().queueMessage("later", [], undefined, TAB);

      await state().interrupt(TAB);
      await flush();

      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true, followUpAt: null });
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(queueTexts()).toEqual(["later"]);
    });

    it("settles a missing live process without issuing any kill", async () => {
      await launch();
      generating();
      state().queueMessage("later", [], undefined, TAB);
      vi.mocked(ipc.interruptTurn).mockResolvedValueOnce(false);

      await state().interrupt(TAB);

      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: false, interrupted: true, queueParked: false, interruptRequestedAt: null });
      expect(queueTexts()).toEqual(["later"]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(runRouting.has(RUN)).toBe(false);
    });

    it("keeps waiting for confirmation on write failure and allows native retry", async () => {
      await launch();
      generating();
      vi.mocked(ipc.interruptTurn).mockRejectedValueOnce(new Error("no channel"));
      await state().interrupt(TAB);
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
      expect(session().error).toContain("no channel");
      expect(session().interruptRequestedAt).not.toBeNull();
      setSession({ interruptRequestedAt: Date.now() - INTERRUPT_GRACE_MS - 1 });
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
    });

    it("treats a double click as one interrupt, and resends when the CLI ignored it", async () => {
      await launch();
      generating();
      await state().interrupt(TAB);
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session().streaming).toBe(true);

      setSession({ interruptRequestedAt: Date.now() - INTERRUPT_GRACE_MS - 1 });
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: true, interrupted: false });
      expect(session().interruptRequestedAt).not.toBeNull();
    });

    it("starts a fresh interrupt for a later reply once the earlier one was acknowledged", async () => {
      await launch();
      generating();
      await state().interrupt(TAB);
      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
      // A notification turn starts and the user stops that one too.
      emit(event("activity", { state: "running" }), event("delta", "Notified."));
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
    });

    it("forgets an interrupt the CLI never answered with a response once its activity changes", async () => {
      await launch();
      generating();
      await state().interrupt(TAB);
      expect(session().interruptRequestedAt).not.toBeNull();
      // The reply had already ended when the interrupt arrived: only idle follows.
      emit(event("activity", { state: "waiting" }));
      expect(session().interruptRequestedAt).toBeNull();
    });

    it("a final done clears the per-run state so it cannot leak into the next run", async () => {
      await launch();
      enterWaiting();
      setSession({ followUpAt: Date.now(), queueParked: true, interruptRequestedAt: Date.now(), lastInterruptAt: Date.now() - INTERRUPT_DEBOUNCE_MS - 1 });

      emit(event("done", { usage: null }));

      expect(session()).toMatchObject({
        interrupted: false,
        followUpAt: null,
        queueParked: false,
        interruptRequestedAt: null,
        lastInterruptAt: null,
      });
    });

    describe("a second Stop after the CLI already acknowledged the first", () => {
      /** Stop interrupts the reply; the real CLI acknowledges and idles within ~5ms. */
      async function stopAndAcknowledge() {
        await launch();
        generating();
        await state().interrupt(TAB);
        emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
        expect(session()).toMatchObject({ interruptRequestedAt: null, nativeActivity: "waiting", streaming: true });
      }

      it("is a double click and leaves the background tasks the first Stop kept alone", async () => {
        await stopAndAcknowledge();

        await state().interrupt(TAB);
        await flush();

        expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
        expect(ipc.interruptSession).not.toHaveBeenCalled();
        expect(session()).toMatchObject({ streaming: true, interrupted: false });
        expect(runRouting.get(RUN)).toBe(KEY);
        // The run still lives: its tasks report and its final done ends it.
        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }));
        expect(session().nativeTasks?.[0].status).toBe("completed");
      });

      it("sends native interrupt when it is a deliberate Stop after the debounce window", async () => {
        await stopAndAcknowledge();
        setSession({ lastInterruptAt: Date.now() - INTERRUPT_DEBOUNCE_MS - 1 });

        await state().interrupt(TAB);

        expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
        expect(ipc.interruptSession).not.toHaveBeenCalled();
        expect(session()).toMatchObject({ streaming: true, interrupted: false });
        emit(event("activity", { state: "waiting" }));
        expect(session().interruptRequestedAt).toBeNull();
      });

      it("still interrupts a new reply that starts inside the window", async () => {
        await stopAndAcknowledge();
        emit(event("activity", { state: "running" }), event("delta", "Notified."));

        await state().interrupt(TAB);

        expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
        expect(ipc.interruptSession).not.toHaveBeenCalled();
      });

      it("is forgotten with the run: the final done clears the click", async () => {
        await stopAndAcknowledge();
        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
        expect(session().lastInterruptAt).toBeNull();
      });
    });

    describe("a message typed after Stop", () => {
      it("is released at the idle boundary when it arrives while the interrupted reply is still winding down", async () => {
        await launch();
        generating();
        state().queueMessage("earlier row", [], undefined, TAB);
        await state().interrupt(TAB);
        expect(session().queueParked).toBe(true);

        // The CLI has not acknowledged yet: nativeActivity is still "running".
        await state().sendWhileBusy("go on", [], undefined, TAB);

        expect(session().nativeActivity).toBe("running");
        expect(queueTexts()).toEqual(["earlier row", "go on"]);
        // The send lifts the park; the interrupt is still awaiting confirmation.
        expect(session().queueParked).toBe(false);
        expect(session().interruptRequestedAt).not.toBeNull();
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();

        // The acknowledgement and the idle event release the queue: FIFO, one per boundary.
        emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
        expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
        expect(ipc.sendFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "earlier row" }));
        cliAnswers();
        expect(ipc.sendFollowUp).toHaveBeenCalledTimes(2);
        expect(ipc.sendFollowUp).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "go on" }));
        expect(queueTexts()).toEqual([]);
      });

      it.each<[string, () => EngineEventPayload]>([
        ["done", () => event("done", { usage: null })],
        ["error", () => event("error", "native CLI exited")],
      ])("is never stranded when it arrives during a later notification turn: the final %s sends it", async (_name, final) => {
        await launch();
        generating();
        await state().interrupt(TAB);
        emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
        // The CLI own notification turn starts; the user types behind it.
        emit(event("activity", { state: "running" }), event("delta", "Notified."));

        await state().sendWhileBusy("go on", [], undefined, TAB);
        expect(queueTexts()).toEqual(["go on"]);
        expect(session().queueParked).toBe(false);
        expect(ipc.sendFollowUp).not.toHaveBeenCalled();

        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), final());
        await flush();

        expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
        expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "go on" }));
        expect(queueTexts()).toEqual([]);
      });

      it("leaves a queue that nobody wrote to parked at the final done", async () => {
        await launch();
        generating();
        state().queueMessage("earlier row", [], undefined, TAB);
        await state().interrupt(TAB);
        emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));

        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
        await flush();

        expect(ipc.sendMessage).not.toHaveBeenCalled();
        expect(queueTexts()).toEqual(["earlier row"]);
      });
    });

    describe("the partial reply of an interrupted turn", () => {
      const assistantRows = () => session().messages.filter((m) => m.role === "assistant");

      it("is sealed by the acknowledgement, so deltas that land after the interrupt stay in one bubble", async () => {
        await launch();
        generating();
        // The animation frame lands the first chunk as a live row.
        flushPendingStreams(useChatStore.setState);
        expect(assistantRows()).toMatchObject([{ text: "Partial reply", live: true }]);

        await state().interrupt(TAB);
        // The IPC answered, the CLI has not: nothing is sealed yet.
        expect(assistantRows()).toMatchObject([{ live: true }]);

        // The CLI still flushes before it acknowledges.
        emit(event("delta", " and a last sentence."));
        emit(
          event("turn_complete", { usage: { input_tokens: 3, output_tokens: 1 }, interrupted: true }),
          event("activity", { state: "waiting" }),
        );

        expect(assistantRows()).toHaveLength(1);
        expect(assistantRows()[0]).toMatchObject({ text: "Partial reply and a last sentence.", live: false });
        expect(assistantRows()[0].usage).toMatchObject({ input_tokens: 3 });

        // Sealed once: the run final done adds nothing.
        emit(event("tasks", { tasks: [{ ...task, status: "completed" }] }), event("done", { usage: null }));
        await flush();
        expect(assistantRows()).toHaveLength(1);
        expect(assistantRows()[0]).toMatchObject({ text: "Partial reply and a last sentence.", live: false });
      });

      it("keeps late text in the same reply while an ignored interrupt is retried", async () => {
        await launch();
        generating();
        flushPendingStreams(useChatStore.setState);
        await state().interrupt(TAB);
        emit(event("delta", " and more"));
        setSession({ interruptRequestedAt: Date.now() - INTERRUPT_GRACE_MS - 1 });

        await state().interrupt(TAB);

        expect(ipc.interruptSession).not.toHaveBeenCalled();
        expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
        expect(session()).toMatchObject({ streaming: true, interrupted: false });
        emit(event("turn_complete", { usage: null, interrupted: true }));
        expect(assistantRows()).toHaveLength(1);
        expect(assistantRows()[0]).toMatchObject({ text: "Partial reply and more", live: false });
      });
    });
  });

  describe("interrupt while send_message is registering the child", () => {
    it("preserves the original run and Stop route after an uncertain launch response", async () => {
      let reject!: (error: unknown) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
      const sending = state().send("accepted start", [], undefined, TAB);
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      state().queueMessage("later", [], undefined, TAB);
      reject(Object.assign(new Error("response unavailable"), { code: "request-uncertain" }));
      await sending;
      expect(runRouting.get(RUN)).toBe(KEY);
      expect(session().nativeTaskRunId).toBe(RUN);
      expect(session().streaming).toBe(true);
      expect(session().queueParked).toBe(true);
      expect(userTexts().filter((text) => text === "accepted start")).toHaveLength(1);
      expect(queueTexts()).toEqual(["later"]);
      await state().interrupt(TAB);
      expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
      expect(runRouting.get(RUN)).toBe(KEY);
      emit(event("done", { usage: null }));
      await flush();
      expect(session().streaming).toBe(false);
      expect(runRouting.has(RUN)).toBe(false);
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(queueTexts()).toEqual(["later"]);
    });

    it("does not let an idle Stop settle a new run started in the same tick", async () => {
      await launch();
      emit(event("done", { usage: null }));
      const stopping = state().interrupt(TAB);
      const sending = state().send("new reply", [], undefined, TAB);
      await Promise.all([stopping, sending]);
      expect(session()).toMatchObject({ streaming: true, interrupted: false, error: null });
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.interruptTurn).not.toHaveBeenCalled();
    });

    it("does not let an old send_message failure settle a replacement run", async () => {
      let fail!: (error: Error) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
      const sending = state().send("old reply", [], undefined, TAB);
      await flush();
      emit(event("activity", { state: "running" }, "replacement-run"));
      state().queueMessage("third reply", [], undefined, TAB);
      fail(new Error("old launch failed"));
      await sending;
      expect(session()).toMatchObject({ nativeTaskRunId: "replacement-run", streaming: true, interrupted: false, error: null });
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(queueTexts()).toEqual(["third reply"]);
      expect(runRouting.get("replacement-run")).toBe(KEY);
    });

    it.each([true, false])("can stop the next reply before the previous interrupt IPC returns %s", async (oldResult) => {
      await launch();
      generating();
      let completeFirst!: (accepted: boolean) => void;
      vi.mocked(ipc.interruptTurn).mockImplementationOnce(() => new Promise((resolve) => { completeFirst = resolve; }));
      const firstStop = state().interrupt(TAB);
      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
      await state().sendWhileBusy("next reply", [], undefined, TAB);
      const nextStop = state().interrupt(TAB);
      await nextStop;
      completeFirst(oldResult);
      await firstStop;
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
      expect(session().interruptRequestedAt).not.toBeNull();
      expect(ipc.interruptSession).not.toHaveBeenCalled();
    });

    it.each(["Stop", "Send Now"] as const)("retries %s after a pre-spawn false reply without killing", async (action) => {
      let registered!: (result: { runId: string; sessionId: null }) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
      const sending = state().send("build", [], undefined, TAB);
      await flush();
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      state().queueMessage("later", [], undefined, TAB);
      vi.mocked(ipc.interruptTurn).mockResolvedValueOnce(false);

      if (action === "Stop") await state().interrupt(TAB);
      else await state().sendQueuedNow(session().queue[0].id);

      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: action === "Stop" });
      expect(session().interruptRequestedAt).not.toBeNull();
      registered({ runId: RUN, sessionId: null });
      await sending;
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptTurn).toHaveBeenLastCalledWith(RUN);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      emit(event("activity", { state: "running" }));
      expect(session().interruptRequestedAt).not.toBeNull();
      emit(event("turn_complete", { usage: null, interrupted: true }), event("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(action === "Stop" ? 1 : 2);
      expect(queueTexts()).toEqual(action === "Stop" ? ["later"] : []);
    });

    it("retries a false interrupt reply that arrives after registration", async () => {
      let registered!: (result: { runId: string; sessionId: null }) => void;
      let unavailable!: (accepted: boolean) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
      const sending = state().send("build", [], undefined, TAB);
      await flush();
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      vi.mocked(ipc.interruptTurn).mockImplementationOnce(() => new Promise((resolve) => { unavailable = resolve; }));
      const stopping = state().interrupt(TAB);
      registered({ runId: RUN, sessionId: null });
      await sending;
      unavailable(false);
      await stopping;
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ streaming: true, interrupted: false, queueParked: true });
    });

    it.each([false, true])("follows session adoption when registration chooses a different run id: %s", async (announceFirst) => {
      const pendingTab = { ...TAB, sessionId: null };
      const pendingKey = sessionKey("claude", null, WS);
      useChatStore.setState({ active: pendingTab, openTabs: [pendingTab], bySession: {} });
      let registered!: (result: { runId: string; sessionId: string }) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
      const sending = state().send("build", [], undefined, pendingTab);
      await flush();
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      vi.mocked(ipc.interruptTurn).mockResolvedValueOnce(false);
      await state().interrupt(pendingTab);
      if (announceFirst) emit(event("session", "s-1"));
      const actualRun = announceFirst ? RUN : "backend-chosen-run";
      registered({ runId: actualRun, sessionId: "s-1" });
      await sending;
      expect(state().bySession[pendingKey]).toBeUndefined();
      expect(runRouting.get(actualRun)).toBe(KEY);
      expect(ipc.interruptTurn).toHaveBeenLastCalledWith(actualRun);
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(2);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(session()).toMatchObject({ nativeTaskRunId: actualRun, streaming: true, interrupted: false, queueParked: true });
    });

    it.each(["false", "error"] as const)("ignores a late %s interrupt result once a newer run owns the session", async (reply) => {
      await launch();
      let finish!: () => void;
      vi.mocked(ipc.interruptTurn).mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => reply === "false" ? resolve(false) : reject(new Error("old write failed"));
      }));
      const stopping = state().interrupt(TAB);
      state().queueMessage("next", [], undefined, TAB);
      await state().sendQueuedNow(session().queue[0].id);
      emit(event("done", { usage: null }));
      await flush();
      const nextRun = session().nativeTaskRunId;
      expect(nextRun).not.toBe(RUN);
      finish();
      await stopping;
      expect(session()).toMatchObject({ nativeTaskRunId: nextRun, streaming: true, interrupted: false, error: null });
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(runRouting.get(nextRun!)).toBe(KEY);
    });

    it("does not repeat an accepted interrupt just because registration was still pending", async () => {
      let registered!: (result: { runId: string; sessionId: null }) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
      const sending = state().send("build", [], undefined, TAB);
      await flush();
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      await state().interrupt(TAB);
      registered({ runId: RUN, sessionId: null });
      await sending;
      expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
    });
  });

  describe("Codex native steering", () => {
    const tab = { engine: "codex", sessionId: "codex-s1", workspacePath: WS };
    const key = sessionKey(tab.engine, tab.sessionId, WS);
    const current = () => state().bySession[key];
    const texts = () => current().queue.map((q) => q.text);
    const native = (kind: EngineEventPayload["kind"], data: unknown) =>
      ({ ...event(kind, data), engine: "codex", sessionId: tab.sessionId });
    const patch = (value: Partial<SessionState>) => useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [key]: { ...s.bySession[key], ...value } },
    }));
    beforeEach(async () => {
      drainPending(key);
      useChatStore.setState({
        models: { codex: "gpt-6.1" },
        engines: [{ id: "codex", enabled: true, available: true, supportsImages: true,
          supportsComputerUse: true, permissions: ["auto", "plan", "bypass"] } as never],
        bySession: { [key]: { ...EMPTY_SESSION, messages: [] } },
      });
      await launch(tab);
    });

    it("steers the existing turn and preserves pending Chinese/emoji output, timer and usage", async () => {
      emit(native("delta", "先检查🙂"));
      patch({ turnUsage: { output_tokens: 8 } });
      const before = current();
      await state().sendWhileBusy("优先修复测试🚀", ["/img/a.png"], undefined, tab);
      emit(native("delta", "然后修复。"));
      flushPendingStreams(useChatStore.setState);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith({ sessionId: RUN, engine: "codex", workspacePath: WS,
        prompt: "优先修复测试🚀", imagePaths: ["/img/a.png"] });
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.interruptTurn).not.toHaveBeenCalled();
      expect(current().turnStartedAt).toBe(before.turnStartedAt);
      expect(current().turnUsage).toBe(before.turnUsage);
      expect(current().throughput).toBe(before.throughput);
      expect(current().messages.filter((m) => ["assistant", "user"].includes(m.role)).map((m) => m.text))
        .toEqual(["build", "先检查🙂然后修复。", "优先修复测试🚀"]);
      expect(current().streaming).toBe(true);
      expect(runRouting.get(RUN)).toBe(key);
    });

    it("keeps explicit queue input FIFO for subsequent turns", async () => {
      state().queueMessage("first", [], undefined, tab);
      state().queueMessage("second", [], undefined, tab);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      emit(native("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first", engine: "codex" }));
      expect(texts()).toEqual(["second"]);
    });

    it.each([
      ["```ts\nconst x = ", "1;\n```"],
      ["| 名称 | 值 |\n| --- | --- |\n| 🙂 | ", "完整 |\n"],
    ])("preserves a native Markdown document across steering: %s", async (prefix, suffix) => {
      emit(native("delta", prefix));
      await state().sendWhileBusy("keep the document intact", [], undefined, tab);
      emit(native("delta", suffix), native("done", { usage: { input_tokens: 10, output_tokens: 4 } }));
      const assistant = current().messages.filter((m) => m.role === "assistant");
      expect(assistant).toHaveLength(1);
      expect(assistant[0].text).toBe(prefix + suffix);
      expect(assistant[0].live).toBe(false);
      expect(assistant[0].usage).toMatchObject({ output_tokens: 4 });
    });

    it("uses a queued row to steer without interrupting or consuming the other rows", async () => {
      state().queueMessage("later", [], undefined, tab);
      state().queueMessage("focus now", [], undefined, tab);
      await state().sendQueuedNow(current().queue[1].id, key);
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "focus now" }));
      expect(texts()).toEqual(["later"]);
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.interruptTurn).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it("queues unavailable native input until the original run settles", async () => {
      vi.mocked(ipc.sendFollowUp).mockResolvedValueOnce(false);
      await state().sendWhileBusy("next", [], undefined, tab);
      expect(texts()).toEqual(["next"]);
      expect(current().messages.map((m) => m.text)).toEqual(["build"]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      emit(native("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "next" }));
    });

    it.each([true, false])("defers a new turn until a late steer ACK (%s) is accounted for", async (accepted) => {
      let reply!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
      const sending = state().sendWhileBusy("steering", [], undefined, tab);
      state().queueMessage("queued", [], undefined, tab);
      emit(native("done", { usage: null }));
      await flush();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      // A new composer send also waits for the unresolved native input.
      await state().send("after", [], undefined, tab);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      reply(accepted);
      await sending;
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: accepted ? "queued" : "steering" }));
      expect(current().messages.filter((m) => m.role === "user" && m.text === "steering")).toHaveLength(1);
      expect(texts()).toEqual(accepted ? ["after"] : ["queued", "after"]);
    });

    it.each([false, true])("does not queue an explicitly uncertain steer for duplicate submission (done first: %s)", async (doneFirst) => {
      let reject!: (error: unknown) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
      const sending = state().sendWhileBusy("accepted steer", [], undefined, tab);
      state().queueMessage("later", [], undefined, tab);
      emit(native("delta", "upstream applied steer"));
      if (doneFirst) emit(native("done", { usage: null }));
      reject({ code: "transport_timeout", message: "response unavailable", outcomeUnknown: true });
      await sending;
      expect(current().error).toContain("response unavailable");
      if (!doneFirst) emit(native("done", { usage: null }));
      await flush();
      expect(current().messages.filter((message) => message.role === "user" && message.text === "accepted steer")).toHaveLength(1);
      expect(texts()).toEqual(["later"]);
      expect(current().streaming).toBe(false);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(ipc.sendFollowUp).toHaveBeenCalledTimes(1);
    });

    it("holds rejected input for manual retry even after completion", async () => {
      let reject!: (reason: Error) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
      const sending = state().sendWhileBusy("retry me", [], undefined, tab);
      state().queueMessage("later", [], undefined, tab);
      emit(native("done", { usage: null }));
      reject(new Error("Codex steer result unconfirmed"));
      await sending;
      expect(current().error).toContain("unconfirmed");
      expect(texts()).toEqual(["retry me", "later"]);
      expect(current().queue[0].manualOnly).toBe(true);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      await state().sendQueuedNow(current().queue[0].id, key);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "retry me" }));
      expect(texts()).toEqual(["later"]);
    });

    it("reports exact host sends as busy while a steering ACK is pending, without local queue pollution", async () => {
      let reply!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
      const sending = state().sendWhileBusy("steering", [], undefined, tab);
      emit(native("done", { usage: null }));
      await expect(state().send("host request", [], { requestedRunId: "host-exact-run" }, tab)).rejects.toThrow("Host chat target is busy");
      expect(texts()).toEqual([]);
      reply(true);
      await sending;
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it("does not steer a stale transport when another observed run takes over the same session", async () => {
      emit({ ...native("delta", "observed new run"), runId: "observed-codex-run" });
      expect(runRouting.get(RUN)).toBe(key);
      await state().sendWhileBusy("next", [], undefined, tab);
      expect(current().codexRunId).toBeUndefined();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(texts()).toEqual(["next"]);
    });

    it("does not let an old launch rejection stop a newer Codex turn", async () => {
      emit(native("done", { usage: null }));
      let reject!: (error: Error) => void;
      vi.mocked(ipc.sendMessage).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
      const launching = state().send("original", [], undefined, tab);
      RUN = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
      state().queueMessage("replacement", [], undefined, tab);
      state().queueMessage("third", [], undefined, tab);
      emit(native("done", { usage: null }));
      await flush();
      const replacement = current().codexRunId;
      expect(replacement).not.toBe(RUN);
      reject(new Error("old launch failed"));
      await launching;
      expect(current().streaming).toBe(true);
      expect(current().codexRunId).toBe(replacement);
      expect(texts()).toEqual(["third"]);
      expect(ipc.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("allows a rejected row to be removed and then releases the next queued message", async () => {
      vi.mocked(ipc.sendFollowUp).mockRejectedValueOnce(new Error("rejected"));
      await state().sendWhileBusy("bad", [], undefined, tab);
      state().queueMessage("next", [], undefined, tab);
      emit(native("done", { usage: null }));
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      state().removeQueued(current().queue[0].id, key);
      await flush();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "next" }));
    });

    it("does not restart a task stopped while its steer was in flight", async () => {
      let reply!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
      const sending = state().sendWhileBusy("keep", [], undefined, tab);
      await state().interrupt(tab);
      reply(false);
      await sending;
      expect(texts()).toEqual(["keep"]);
      expect(current().interrupted).toBe(true);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps Stop parked when Done precedes the stop IPC and a late unavailable steer", async () => {
      let reply!: (value: boolean) => void;
      let stopped!: (value: boolean) => void;
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
      vi.mocked(ipc.interruptSession).mockImplementationOnce(() => new Promise((resolve) => { stopped = resolve; }));
      const sending = state().sendWhileBusy("keep parked", [], undefined, tab);
      const stopping = state().interrupt(tab);
      emit(native("done", { usage: null }));
      reply(false);
      await sending;
      expect(texts()).toEqual(["keep parked"]);
      expect(current().interrupted).toBe(true);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      stopped(true);
      await stopping;
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it.each([false, true])("preserves submission order when concurrent native inputs return (reverse ACKs: %s)", async (reverse) => {
      const replies: ((value: boolean) => void)[] = [];
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((resolve) => { replies.push(resolve); }))
        .mockImplementationOnce(() => new Promise((resolve) => { replies.push(resolve); }));
      const a = state().sendWhileBusy("first steer", [], undefined, tab);
      const b = state().sendWhileBusy("second steer", [], undefined, tab);
      state().queueMessage("queued later", [], undefined, tab);
      emit(native("done", { usage: null }));
      replies[reverse ? 1 : 0](false);
      await flush();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      replies[reverse ? 0 : 1](false);
      await Promise.all([a, b]);
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first steer" }));
      expect(texts()).toEqual(["second steer", "queued later"]);
    });

    it("preserves submission order for concurrent rejected inputs and leaves both for manual retry", async () => {
      const failures: ((error: Error) => void)[] = [];
      vi.mocked(ipc.sendFollowUp).mockImplementationOnce(() => new Promise((_resolve, reject) => { failures.push(reject); }))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { failures.push(reject); }));
      const a = state().sendWhileBusy("first rejected", [], undefined, tab);
      const b = state().sendWhileBusy("second rejected", [], undefined, tab);
      failures[0](new Error("first rejected"));
      await a;
      failures[1](new Error("second rejected"));
      await b;
      emit(native("done", { usage: null }));
      expect(texts()).toEqual(["first rejected", "second rejected"]);
      expect(current().queue.every((q) => q.manualOnly)).toBe(true);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      ["desktop handoff", { handoff: { stage: "running", model: null, effort: null } }],
      ["compaction", { compaction: { automatic: true, startedAt: 1 } }],
      ["computer use", { activeComputerUse: true }],
      ["unknown launch", { liveLaunch: undefined }],
      ["stale run", { codexRunId: "old-run" }],
      ["pending question", { messages: [{ seq: 1, role: "question", text: "choose", ts: null, question: { status: "pending" } }] }],
    ])("keeps %s input queued and never stops the current task", async (_name, value) => {
      patch(value as Partial<SessionState>);
      await state().sendWhileBusy("next", [], undefined, tab);
      await state().sendQueuedNow(current().queue[0].id, key);
      expect(texts()).toEqual(["next"]);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(ipc.interruptTurn).not.toHaveBeenCalled();
      expect(ipc.interruptSession).not.toHaveBeenCalled();
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(current().error).toBeTruthy();
    });

    it("queues settings changes and computer-use sends instead of silently ignoring them", async () => {
      await state().sendWhileBusy("use machine", [], { computerUse: true }, tab);
      await state().sendWhileBusy("new model", [], undefined, { ...tab, model: "other" });
      expect(texts()).toEqual(["use machine", "new model"]);
      expect(current().queue[0].computerUse).toBe(true);
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    });

    it("cancels steering if Stop arrives during selected-agent preparation", async () => {
      selectSelectedAgent(WS, tab.sessionId, { id: "built-in-1", name: "Reviewer", icon: "🧐", source: "builtIn" });
      let resolve!: (value: never) => void;
      vi.mocked(ipc.resolveEnabledBuiltInAgent).mockImplementationOnce(() => new Promise((done) => { resolve = done as never; }));
      const sending = state().sendWhileBusy("prepared", [], undefined, tab);
      await state().interrupt(tab);
      resolve({ id: "built-in-1", name: "Reviewer", prompt: "Review.", promptHash: "h" } as never);
      await sending;
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(texts()).toEqual(["prepared"]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      clearSelectedAgent(WS, tab.sessionId);
    });
  });

  describe("an interrupted response", () => {
    it("is sealed like any response: no error banner, no drain, and the run goes on", async () => {
      await launch();
      generating();
      state().queueMessage("later", [], undefined, TAB);
      setSession({ queueParked: true });

      emit(event("turn_complete", { usage: { input_tokens: 5, output_tokens: 2 }, interrupted: true }));

      expect(session().error).toBeNull();
      expect(session()).toMatchObject({ streaming: true, interrupted: false });
      expect(session().messages.at(-1)).toMatchObject({ role: "assistant", text: "Partial reply", live: false });
      expect(session().messages.at(-1)?.usage).toMatchObject({ input_tokens: 5 });
      expect(queueTexts()).toEqual(["later"]);
      expect(ipc.sendMessage).not.toHaveBeenCalled();
      expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(runRouting.get(RUN)).toBe(KEY);
    });

    it("releases an unparked row at the idle boundary that follows", async () => {
      await launch();
      generating();
      state().queueMessage("later", [], undefined, TAB);
      emit(event("turn_complete", { usage: null, interrupted: true }), event("activity", { state: "waiting" }));
      expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ prompt: "later" }));
    });
  });
});
