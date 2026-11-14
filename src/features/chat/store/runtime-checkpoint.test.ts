import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import type { EngineEventPayload } from "@/lib/events";
import type { SessionPage } from "@/lib/ipc";

const fake = vi.hoisted(() => ({
  deliver: undefined as ((events: EngineEventPayload[]) => void) | undefined,
  listenerReady: undefined as Promise<void> | undefined,
  send: vi.fn(async (args: { runId: string; sessionId?: string }) => ({ runId: args.runId, sessionId: args.sessionId ?? null })),
  answer: vi.fn(async () => {}),
  importImages: vi.fn(async (paths: string[]) => paths),
  loadPage: vi.fn(async (): Promise<SessionPage> => ({ messages: [], subagentHistory: [], nextBefore: null })),
}));
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(async () => false), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async (cb: (events: EngineEventPayload[]) => void) => { await fake.listenerReady; fake.deliver = cb; return () => {}; }),
  listenSessionsChanged: vi.fn(async () => () => {}), listenComputerUseEscape: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/ipc", () => ({ ipc: {
  listWorkspaces: vi.fn(async () => []), listSessions: vi.fn(async () => []), listArchivedSessions: vi.fn(async () => []), listEngines: vi.fn(async () => []),
  sendMessage: fake.send, answerQuestion: fake.answer, getAppSettings: vi.fn(async () => ({})), getCliConfig: vi.fn(async () => ({})),
  loadSessionPage: fake.loadPage, listPlanReviews: vi.fn(async () => []),
  activeRunIds: vi.fn(async () => []), rememberSessionModel: vi.fn(async () => {}), rememberSessionEffort: vi.fn(async () => {}),
  rescanSessions: vi.fn(async () => {}),
  importAttachments: fake.importImages, readFile: vi.fn(async () => ({ kind: "other" })),
  rememberSessionProvider: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}), computerUseSetActive: vi.fn(async () => {}),
} }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: () => null, migrateSelectedAgent: () => {} }));

const tab = { engine: "grok", sessionId: "session-1", workspacePath: "G:/fixture" };
const key = "grok/session-1";
const runId = "original-run";
async function boot(checkpoint?: RuntimeCheckpoint) {
  vi.resetModules();
  const coordinator = await import("@/lib/runtime-checkpoint");
  coordinator.initializeRuntimeCheckpoint(checkpoint, { requiredParticipants: ["chat"] });
  const { useChatStore: store } = await import("../store");
  const stream = await import("./stream");
  return { coordinator, store, stream };
}
function event(kind: EngineEventPayload["kind"], data: unknown, seq = 1): EngineEventPayload {
  return { engine: tab.engine, sessionId: tab.sessionId, runId, seq, kind, data };
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); fake.listenerReady = undefined; fake.deliver = undefined; fake.send.mockClear(); fake.answer.mockClear(); fake.importImages.mockClear(); fake.loadPage.mockReset(); fake.loadPage.mockResolvedValue({ messages: [], subagentHistory: [], nextBefore: null }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("chat runtime checkpoint with the real store", () => {
  it.each([false, true])("restores an acknowledged private start without replay and binds late identity (done=%s)", async done => {
    const first = await boot(); await first.store.getState().init();
    const { hostPendingKey } = await import("./host-pending-chat");
    const { settledRuns, settledRunOutcomes } = await import("./engine-events");
    const own = { engine: "agy", sessionId: null, workspacePath: "G:/fixture" }, ownKey = "new:agy:G:/fixture";
    const privateKey = hostPendingKey("agy", runId), nativeKey = "agy/native-restored";
    const messages = [{ seq: 1, role: "user", text: "host first", ts: null }, { seq: 2, role: "assistant", text: "保留正文🙂", ts: null }];
    first.store.setState({ active: own, openTabs: [own], drafts: { [ownKey]: "用户旧稿" }, bySession: {
      [ownKey]: { ...first.stream.EMPTY_SESSION },
      [privateKey]: { ...first.stream.EMPTY_SESSION, messages, streaming: !done,
        hostTaskOrigin: { engine: "agy", runId, workspacePath: own.workspacePath }, ...(done ? { settledRunIds: [runId] } : {}) },
    } });
    if (done) { settledRuns.set(runId, "done"); settledRunOutcomes.set(runId, { key: privateKey, status: "completed" }); }
    else first.stream.routeRun(runId, privateKey);
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    const next = await boot(checkpoint); await next.coordinator.resumeRuntimeCheckpoint();
    fake.deliver?.([{ engine: "agy", runId, sessionId: "native-restored", kind: "session", seq: 10, data: "native-restored" }]);
    expect(next.store.getState().bySession[privateKey]).toBeUndefined();
    expect(next.store.getState().bySession[nativeKey].messages).toEqual(messages);
    expect(next.store.getState().active).toEqual(own); expect(next.store.getState().drafts[ownKey]).toBe("用户旧稿");
    expect(next.store.getState().openTabs.filter(t => t.sessionId === "native-restored")).toHaveLength(1);
    expect(fake.send).not.toHaveBeenCalled();
    if (done) {
      expect(next.stream.runRouting.has(runId)).toBe(false);
      const events = await import("./engine-events"); expect(events.settledRunOutcomes.get(runId)).toEqual({ key: nativeKey, status: "completed" });
    }
  });
  it("rejects a restored private identity attached to another key", async () => {
    const first = await boot(); await first.store.getState().init();
    first.store.setState({ bySession: { [key]: { ...first.stream.EMPTY_SESSION,
      hostTaskOrigin: { engine: "agy", runId, workspacePath: tab.workspacePath } } } });
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    await expect(boot(checkpoint)).rejects.toThrow("Invalid host task checkpoint identity");
  });
  it.each(["legacy", "current"])("repairs legacy AGY history only after resume, preserving %s checkpoint data", async (format) => {
    const agyTab = { ...tab, engine: "agy" }, agyKey = "agy/session-1";
    const first = await boot(); await first.store.getState().init();
    const messages = [
      { seq: 23, role: "assistant", text: "native final", ts: "2026-10-30T09:44:01Z" },
      { seq: 24, role: "tool", text: "read_file", ts: "2026-10-30T10:18:00Z" },
    ];
    first.store.setState({ active: tab, openTabs: [tab, agyTab], drafts: { [agyKey]: "unsent draft" },
      bySession: { [agyKey]: { ...first.stream.EMPTY_SESSION, messages, usage: { input_tokens: 100, output_tokens: 20 } } } });
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    if (format === "legacy") delete (checkpoint.participants.chat as { archiveSourcesVersion?: number }).archiveSourcesVersion;
    const next = await boot(checkpoint);
    expect(next.store.getState().bySession[agyKey].messages).toEqual(messages);
    expect(fake.loadPage).not.toHaveBeenCalled();
    fake.loadPage.mockResolvedValueOnce({ messages: [messages[0]], subagentHistory: [], nextBefore: null });
    await next.coordinator.resumeRuntimeCheckpoint();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    if (format === "legacy") {
      expect(fake.loadPage).toHaveBeenCalledTimes(1);
      expect(next.store.getState().bySession[agyKey].messages).toEqual([messages[0]]);
    } else {
      expect(fake.loadPage).not.toHaveBeenCalled();
      expect(next.store.getState().bySession[agyKey].messages).toEqual(messages);
    }
    expect(next.store.getState().active).toEqual(tab);
    expect(next.store.getState().drafts[agyKey]).toBe("unsent draft");
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("retries a failed legacy history repair after another checkpoint instead of treating its error as a failed send", async () => {
    const agyTab = { ...tab, engine: "agy" }, agyKey = "agy/session-1";
    const first = await boot(); await first.store.getState().init();
    const messages = [{ role: "assistant", text: "native final", seq: 1, ts: null }, { role: "tool", text: "old replay", seq: 2, ts: null }];
    first.store.setState({ active: agyTab, openTabs: [agyTab], bySession: { [agyKey]: {
      ...first.stream.EMPTY_SESSION, messages, usage: { input_tokens: 100, output_tokens: 20 },
    } } });
    const oldCheckpoint = await first.coordinator.prepareRuntimeCheckpoint();
    delete (oldCheckpoint.participants.chat as { archiveSourcesVersion?: number }).archiveSourcesVersion;
    const next = await boot(oldCheckpoint);
    fake.loadPage.mockRejectedValueOnce(new Error("native SQLite read failed"));
    await next.coordinator.resumeRuntimeCheckpoint();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(next.store.getState().bySession[agyKey]).toMatchObject({ messages, historyReloadRequired: true,
      error: "Error: native SQLite read failed", historyReloadError: "Error: native SQLite read failed" });
    const retryCheckpoint = await next.coordinator.prepareRuntimeCheckpoint();
    const third = await boot(retryCheckpoint);
    fake.loadPage.mockResolvedValueOnce({ messages: [messages[0]], subagentHistory: [], nextBefore: null });
    await third.coordinator.resumeRuntimeCheckpoint();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(fake.loadPage).toHaveBeenCalledTimes(2);
    expect(third.store.getState().bySession[agyKey].messages).toEqual([messages[0]]);
    expect(third.store.getState().bySession[agyKey].historyReloadRequired).toBeUndefined();
    expect(third.store.getState().bySession[agyKey].historyReloadError).toBeUndefined();
    expect(third.store.getState().bySession[agyKey].error).toBeNull();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("accepts older checkpoints without placeholder origins while retaining run ownership", async () => {
    const first = await boot(); await first.store.getState().init();
    first.store.setState({ active: tab, openTabs: [tab], drafts: { [key]: "older draft" },
      bySession: { [key]: { ...first.stream.EMPTY_SESSION, streaming: true } }, streamingByKey: { [key]: true } });
    first.stream.routeRun(runId, key);
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    delete (checkpoint.participants.chat as { events: Record<string, unknown> }).events.pendingSessionOrigins;
    const next = await boot(checkpoint);
    expect(next.stream.runRouting.get(runId)).toBe(key);
    expect(next.store.getState().drafts[key]).toBe("older draft");
    expect(next.store.getState().bySession[key].streaming).toBe(true);
    const { captureEngineEventRuntime } = await import("./engine-events");
    expect(captureEngineEventRuntime().pendingSessionOrigins).toEqual([]);
  });

  it.each(["missing-settled-runs", "malformed-origins", "malformed-outcomes"])("keeps checkpoint event validation strict for %s", async (invalid) => {
    const first = await boot(); await first.store.getState().init();
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    const events = (checkpoint.participants.chat as { events: Record<string, unknown> }).events;
    if (invalid === "missing-settled-runs") delete events.settledRuns;
    else if (invalid === "malformed-origins") events.pendingSessionOrigins = null;
    else events.settledRunOutcomes = null;
    await expect(boot(checkpoint)).rejects.toThrow("Incomplete checkpoint event bookkeeping");
  });

  it("bounds restored placeholder provenance", async () => {
    await boot();
    const { captureEngineEventRuntime, restoreEngineEventRuntime } = await import("./engine-events");
    restoreEngineEventRuntime({ ...captureEngineEventRuntime(), pendingSessionOrigins: Array.from({ length: 300 }, (_, i) =>
      [`observed-${i}`, { nativeKey: `codex/native-${i}`, pendingKey: "new:codex:fixture", localRunId: `local-${i}` }]) });
    const origins = captureEngineEventRuntime().pendingSessionOrigins;
    expect(origins).toHaveLength(256);
    expect(origins[0][0]).toBe("observed-44");
    expect(origins.at(-1)?.[0]).toBe("observed-299");
  });

  it.each(["current", "before-settled-outcomes"])("restores drafts, pending approval, original run identity and unflushed Unicode from %s checkpoints", async (format) => {
    const first = await boot();
    await first.store.getState().init();
    first.store.setState({ active: tab, openTabs: [tab], drafts: { [key]: "草稿🙂" }, streamingByKey: { [key]: true },
      bySession: { [key]: { ...first.stream.EMPTY_SESSION, streaming: true, nativeTaskRunId: runId,
        managedAssignmentRuns: [runId], managedInputStart: { runId, firstSeq: 1 },
        messages: [
          { seq: 1, role: "question", text: "Continue?", ts: null, question: { runId, requestId: "approval-1", status: "pending", questions: [] } },
          { seq: 2, role: "assistant", text: "前文", ts: null, live: true },
        ] as never,
        queue: [{ id: "queue-1", text: "下一条", images: ["G:/fixture/image.png"], queuedAt: 1 }],
      } } });
    first.stream.routeRun(runId, key);
    first.stream.bufferStreamPart(key, "delta", "🙂\n```ts\nconst a = 1;", "model", "high");
    const previousEvents = await import("./engine-events");
    previousEvents.settledRuns.set("previous-run", "done");
    previousEvents.settledRunOutcomes.set("previous-run", { key, status: "cancelled" });
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    if (format === "before-settled-outcomes") {
      delete (checkpoint.participants.chat as { events: Record<string, unknown> }).events.settledRunOutcomes;
    }
    expect(fake.send).not.toHaveBeenCalled();
    const next = await boot(JSON.parse(JSON.stringify(checkpoint)));
    const nextEvents = await import("./engine-events");
    expect(nextEvents.settledRuns.get("previous-run")).toBe("done");
    expect([...nextEvents.settledRunOutcomes]).toEqual(format === "current"
      ? [["previous-run", { key, status: "cancelled" }]] : []);
    expect(next.store.getState().drafts[key]).toBe("草稿🙂");
    expect(next.store.getState().bySession[key].queue[0].images).toEqual(["G:/fixture/image.png"]);
    expect(next.stream.runRouting.get(runId)).toBe(key);
    expect(next.store.getState().bySession[key].managedAssignmentRuns).toEqual([runId]);
    expect(next.store.getState().bySession[key].managedInputStart).toEqual({ runId, firstSeq: 1 });
    expect(next.store.getState().bySession[key].messages[0].question?.requestId).toBe("approval-1");
    await next.store.getState().init(); // Empty native catalog must not erase the checkpoint tab/run.
    expect(next.store.getState().openTabs).toEqual([tab]);
    expect(next.store.getState().bySession[key].streaming).toBe(true);
    await next.coordinator.resumeRuntimeCheckpoint();
    fake.deliver?.([event("delta", "\n```后文", 2)]);
    next.stream.flushPendingStreams(next.store.setState);
    expect(next.store.getState().bySession[key].messages.at(-1)?.text).toBe("前文🙂\n```ts\nconst a = 1;\n```后文");
    expect(fake.send).not.toHaveBeenCalled();
    await next.store.getState().respondToQuestion(key, 1, { Continue: "yes" });
    expect(fake.answer).toHaveBeenCalledWith(runId, "approval-1", { Continue: "yes" });
  });

  it("freezes before dequeue and only the resumed renderer drains the queue once", async () => {
    const first = await boot(); await first.store.getState().init();
    first.store.setState({ active: tab, openTabs: [tab], streamingByKey: { [key]: true }, bySession: { [key]: {
      ...first.stream.EMPTY_SESSION, streaming: true, messages: [], queue: [{ id: "queue-1", text: "one delivery", images: [], queuedAt: 1 }],
    } } });
    first.stream.routeRun(runId, key);
    const preparing = first.coordinator.prepareRuntimeCheckpoint();
    fake.deliver?.([event("done", { usage: null })]);
    const checkpoint = await preparing;
    expect(first.store.getState().bySession[key].queue).toHaveLength(1);
    expect(fake.send).not.toHaveBeenCalled();
    const next = await boot(checkpoint);
    await next.coordinator.resumeRuntimeCheckpoint();
    await Promise.resolve(); await Promise.resolve();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send.mock.calls[0][0]).toMatchObject({ sessionId: tab.sessionId, prompt: "one delivery" });
    fake.deliver?.([event("done", { usage: null })]); // Late original terminal must not release another item.
    await Promise.resolve();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(next.store.getState().bySession[key].queue).toHaveLength(0);
  });

  it("waits for listener registration before unfreezing a restored store", async () => {
    const first = await boot(); await first.store.getState().init();
    const checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    const next = await boot(checkpoint);
    let ready!: () => void;
    fake.listenerReady = new Promise<void>((resolve) => { ready = resolve; });
    const resuming = next.coordinator.resumeRuntimeCheckpoint();
    await Promise.resolve();
    expect(next.coordinator.isRuntimeSubmissionPaused()).toBe(true);
    await expect(next.store.getState().send("no", [])).rejects.toThrow(/paused/);
    ready(); await resuming;
    expect(next.coordinator.isRuntimeSubmissionPaused()).toBe(false);
  });

  it("abort resumes a frozen queue once and repeated abort does not release a second item", async () => {
    const app = await boot(); await app.store.getState().init();
    app.store.setState({ active: tab, openTabs: [tab], bySession: { [key]: { ...app.stream.EMPTY_SESSION,
      queue: [1, 2].map((n) => ({ id: `queue-${n}`, text: `message ${n}`, images: [], queuedAt: n })),
    } } });
    await app.coordinator.prepareRuntimeCheckpoint();
    app.coordinator.abortRuntimeCheckpoint();
    app.coordinator.abortRuntimeCheckpoint();
    await Promise.resolve(); await Promise.resolve();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(app.store.getState().bySession[key].queue.map((item) => item.id)).toEqual(["queue-2"]);
  });

  it("refuses to snapshot a send whose native acceptance is still unknown", async () => {
    const app = await boot(); await app.store.getState().init();
    app.store.setState({ active: tab, openTabs: [tab], bySession: { [key]: { ...app.stream.EMPTY_SESSION } } });
    let acknowledge!: (result: { runId: string; sessionId: string }) => void;
    fake.send.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const send = app.store.getState().send("first", []);
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/chat:send/);
    await expect(app.store.getState().send("second", [])).rejects.toThrow(/paused/);
    expect(fake.send).toHaveBeenCalledTimes(1);
    acknowledge({ runId: fake.send.mock.calls[0][0].runId, sessionId: tab.sessionId });
    await send;
    app.coordinator.abortRuntimeCheckpoint();
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it("blocks while a multi-select editor answer is still awaiting native acknowledgement", async () => {
    const app = await boot(); await app.store.getState().init();
    app.store.setState({ active: tab, openTabs: [tab], bySession: { [key]: { ...app.stream.EMPTY_SESSION, streaming: true } } });
    app.stream.routeRun(runId, key);
    const { askLoops } = await import("./ask-loop");
    askLoops.set(key, { base: "Choices", seq: 1, requestId: "select", runId, text: "picked", phase: "sent" });
    let acknowledged!: () => void;
    fake.answer.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledged = resolve; }));
    fake.deliver?.([event("question", { requestId: "editor", input: { extui: { method: "editor" }, questions: [{ question: "Choices", options: [] }] } })]);
    expect(askLoops.has(key)).toBe(false);
    await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/question-control-write-pending/);
    acknowledged(); await Promise.resolve(); await Promise.resolve();
    app.coordinator.abortRuntimeCheckpoint();
    expect(fake.answer).toHaveBeenCalledTimes(1);
    expect(fake.answer).toHaveBeenCalledWith(runId, "editor", { Choices: "picked" });
  });

  it("blocks on image imports and attachments until the actual hook is empty", async () => {
    const app = await boot(); await app.store.getState().init();
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useComposerImages } = await import("../components/use-composer-images");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let hook!: ReturnType<typeof useComposerImages>;
    function Images() { hook = useComposerImages(); return null; }
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    let complete!: (paths: string[]) => void;
    fake.importImages.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    try {
      await act(async () => root.render(createElement(Images)));
      await act(async () => hook.importImageFiles(["G:/fixture/pasted.png"], true));
      await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/image-import-pending/);
      app.coordinator.abortRuntimeCheckpoint();
      await act(async () => { complete(["G:/fixture/pasted.png"]); });
      expect(hook.images).toEqual(["G:/fixture/pasted.png"]);
      await expect(app.coordinator.prepareRuntimeCheckpoint()).rejects.toThrow(/unmigrated-image-attachments/);
      app.coordinator.abortRuntimeCheckpoint();
      await act(async () => hook.removeImage("G:/fixture/pasted.png"));
      await expect(app.coordinator.prepareRuntimeCheckpoint()).resolves.toMatchObject({ version: 1 });
    } finally { await act(async () => root.unmount()); node.remove(); }
  });

  it("restores image paths into the matching split composer, never another session", async () => {
    async function mount(keys: string[]) {
      const { act, createElement, Fragment } = await import("react");
      const { createRoot } = await import("react-dom/client");
      const { useComposerImages } = await import("../components/use-composer-images");
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      const hooks = new Map<string, ReturnType<typeof useComposerImages>>();
      function Images({ identity }: { identity: string }) { hooks.set(identity, useComposerImages(identity)); return null; }
      const node = document.createElement("div"); document.body.append(node);
      const root = createRoot(node);
      await act(async () => root.render(createElement(Fragment, null, ...keys.map((identity) => createElement(Images, { key: identity, identity })))));
      return { hooks, act, close: async () => { await act(async () => root.unmount()); node.remove(); } };
    }
    const first = await boot(); await first.store.getState().init();
    const original = await mount([key, "new:claude:G:/second"]);
    let checkpoint: RuntimeCheckpoint;
    try {
      await original.act(async () => {
        original.hooks.get(key)!.importImageFiles(["G:/fixture/a.png"], true);
        original.hooks.get("new:claude:G:/second")!.importImageFiles(["G:/fixture/b.png"], true);
      });
      checkpoint = await first.coordinator.prepareRuntimeCheckpoint();
    } finally { await original.close(); }
    const next = await boot(checkpoint);
    const replacement = await mount(["new:claude:G:/second", key]); // Reversed mount order proves identity routing.
    try {
      await next.coordinator.resumeRuntimeCheckpoint();
      expect(replacement.hooks.get(key)!.images).toEqual(["G:/fixture/a.png"]);
      expect(replacement.hooks.get("new:claude:G:/second")!.images).toEqual(["G:/fixture/b.png"]);
      expect(fake.send).not.toHaveBeenCalled();
    } finally { await replacement.close(); }
  });
});
