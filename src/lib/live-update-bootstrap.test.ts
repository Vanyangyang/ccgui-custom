import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCheckpoint, createRuntimeCheckpointCoordinator } from "./runtime-checkpoint";

type Coordinator = ReturnType<typeof createRuntimeCheckpointCoordinator>;
let coordinator: Coordinator;
let web: boolean;
let order: string[];
let appBlockers: string[];
let chatBlockers: string[];
const native = vi.fn<(command: string, args?: unknown) => Promise<unknown>>();
const remote = vi.fn<(command: string, args?: unknown) => Promise<unknown>>();
const initialize = vi.fn();
const workerInitialize = vi.fn<(cursors?: Record<string, number>) => Promise<void>>();
const replay = vi.fn<() => Promise<void>>();
const chatInit = vi.fn<() => Promise<void>>();
const chatRestore = vi.fn();
const awaitReady = vi.fn<() => Promise<void>>();
const resumeLocal = vi.fn();
const responder = vi.fn<() => Promise<() => void>>();
const disposeResponder = vi.fn();
const pluginIds = vi.fn((): string[] => []);
const prewarm = vi.fn<() => Promise<void>>();

const checkpoint = (): RuntimeCheckpoint => ({
  version: 1,
  participants: {
    chat: { version: 1, marker: "same text and event cut" },
    "app-ui": { version: 1, marker: "same visible UI" },
  },
});
const recovery = () => ({ transactionId: "transaction-preserved", checkpoint: checkpoint(), cursors: { "worker-a": 7 } });
const confirmCalls = () => native.mock.calls.filter(([command]) => command === "live_update_confirm");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("document", { documentElement: { inert: false } });
  web = false; order = []; appBlockers = []; chatBlockers = [];
  // Use the real coordinator, with independent state per renderer/test. Importing
  // this pure module must not import React stores or register participants.
  const actual = await vi.importActual<typeof import("./runtime-checkpoint")>("./runtime-checkpoint");
  coordinator = actual.createRuntimeCheckpointCoordinator();
  initialize.mockReset(); chatRestore.mockReset(); resumeLocal.mockReset(); disposeResponder.mockReset();
  native.mockReset().mockImplementation(async command => { order.push(`native:${command}`); return command === "live_update_bootstrap" ? recovery() : undefined; });
  remote.mockReset().mockImplementation(async command => { order.push(`remote:${command}`); return null; });
  workerInitialize.mockReset().mockImplementation(async () => { order.push("worker:initialize"); });
  replay.mockReset().mockImplementation(async () => { order.push("worker:replay"); });
  chatInit.mockReset().mockImplementation(async () => { order.push("chat:init"); });
  awaitReady.mockReset().mockImplementation(async () => { order.push("checkpoint:ready"); await coordinator.awaitReady(); });
  responder.mockReset().mockImplementation(async () => { order.push("responder:installed"); return disposeResponder; });
  pluginIds.mockReset().mockReturnValue([]);
  prewarm.mockReset().mockResolvedValue(undefined);

  vi.doMock("@tauri-apps/api/core", () => ({ invoke: native }));
  vi.doMock("./transport", () => ({ isWeb: web, invoke: remote, initializeWorkerEvents: workerInitialize, resumeWorkerEvents: replay }));
  vi.doMock("./runtime-checkpoint", () => ({
    runtimeCheckpoint: coordinator,
    cloneCheckpointValue: actual.cloneCheckpointValue,
    initializeRuntimeCheckpoint: (...args: Parameters<Coordinator["initialize"]>) => {
      order.push("checkpoint:initialize"); initialize(...args); coordinator.initialize(...args);
    },
    awaitRuntimeCheckpointReady: awaitReady,
    resumeCommittedRuntimeCheckpoint: () => { order.push("checkpoint:resume"); resumeLocal(); coordinator.resumeCommitted(); },
  }));
  // These factories intentionally perform registration at dynamic-import time,
  // as production store modules do. Importing them before initialize would fail
  // the restore/readiness assertions below instead of hiding the ordering bug.
  vi.doMock("./app-runtime-checkpoint", () => {
    order.push("import:app-ui");
    coordinator.register({ id: "app-ui", capture: () => ({}), restore: () => { order.push("restore:app-ui"); }, captureReadiness: () => appBlockers });
    return {};
  });
  vi.doMock("@/features/chat/store", () => {
    order.push("import:chat");
    coordinator.register({ id: "chat", capture: () => ({}), restore: chatRestore, readiness: () => chatBlockers });
    return { useChatStore: { getState: () => ({ init: chatInit }) } };
  });
  vi.doMock("./runtime-observer", () => ({ installRuntimeObserverResponder: responder }));
  vi.doMock("@/features/plugins/runtime/chat-bridge", () => ({ pendingHostChatPluginIds: pluginIds }));
  vi.doMock("@/features/plugins/runtime/loader", () => ({ prewarmHostChatBridges: prewarm }));
});

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

async function prepareMountedRecovery() {
  const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
  const finish = await prepareLiveUpdateBootstrap();
  // Production bootstrap imports/mounts App between prepare and finish. The chat
  // participant therefore restores before health confirmation is attempted.
  order.push("App:mount");
  await import("@/features/chat/store");
  return finish;
}

describe("live update bootstrap ownership boundaries", () => {
  it("retains a retired Spellcast checkpoint without waiting for or reactivating its plugin", async () => {
    const saved = recovery();
    const retiredId = "host-chat-bridge:spellcast-canvas-bridge";
    const activeId = "host-chat-bridge:still-supported";
    saved.checkpoint.participants[retiredId] = {
      version: 1, pluginId: "spellcast-canvas-bridge", ledger: { entries: [{ prompt: "历史中文🙂", status: "queued" }] },
    };
    saved.checkpoint.participants[activeId] = { version: 1, pluginId: "still-supported" };
    native.mockImplementation(async command => command === "live_update_bootstrap" ? saved : undefined);
    pluginIds.mockReturnValue(["spellcast-canvas-bridge", "still-supported"]);
    prewarm.mockImplementation(async () => {
      coordinator.register({ id: activeId, capture: () => saved.checkpoint.participants[activeId], restore: () => {} });
    });
    const finish = await prepareMountedRecovery();
    await finish();
    expect(prewarm).toHaveBeenCalledExactlyOnceWith(["still-supported"]);
    expect(confirmCalls()).toHaveLength(1);
    expect(coordinator.isPaused()).toBe(false);
    expect(document.documentElement.inert).toBe(false);
    const next = await coordinator.prepare();
    expect(next.participants[retiredId]).toEqual(saved.checkpoint.participants[retiredId]);
  });

  it("continues blocking recovery for an unknown missing plugin owner", async () => {
    const saved = recovery();
    saved.checkpoint.participants["host-chat-bridge:missing-plugin"] = { version: 1, pluginId: "missing-plugin" };
    native.mockImplementation(async command => command === "live_update_bootstrap" ? saved : undefined);
    pluginIds.mockReturnValue(["missing-plugin"]);
    prewarm.mockRejectedValue(new Error("Plugin chat checkpoint is waiting for its owner: missing-plugin"));
    const finish = await prepareMountedRecovery();
    const rejected = expect(finish()).rejects.toThrow(/missing-plugin/);
    await vi.waitFor(() => expect(prewarm).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(confirmCalls()).toHaveLength(0);
    expect(resumeLocal).not.toHaveBeenCalled();
    expect(coordinator.isPaused()).toBe(true);
  });

  it("initializes the checkpoint before participant imports and confirms only after replay and responder readiness", async () => {
    const replayGate = Promise.withResolvers<void>();
    const confirmGate = Promise.withResolvers<void>();
    replay.mockImplementation(async () => { order.push("worker:replay"); await replayGate.promise; order.push("worker:replayed"); });
    native.mockImplementation(async command => {
      order.push(`native:${command}`);
      return command === "live_update_bootstrap" ? recovery() : command === "live_update_confirm" ? confirmGate.promise : undefined;
    });
    const finish = await prepareMountedRecovery();
    expect(order.slice(0, 5)).toEqual(["native:live_update_bootstrap", "checkpoint:initialize", "worker:initialize", "import:app-ui", "restore:app-ui"]);
    expect(order.indexOf("checkpoint:initialize")).toBeLessThan(order.indexOf("App:mount"));
    expect(chatRestore).toHaveBeenCalledWith(checkpoint().participants.chat);
    expect(workerInitialize).toHaveBeenCalledWith({ "worker-a": 7 });
    expect(coordinator.isPaused()).toBe(true); expect(document.documentElement.inert).toBe(true);

    const finishing = finish();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(confirmCalls()).toHaveLength(0); expect(resumeLocal).not.toHaveBeenCalled();
    replayGate.resolve();
    await vi.waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(order.indexOf("worker:replayed")).toBeLessThan(order.indexOf("native:live_update_confirm"));
    expect(order.indexOf("responder:installed")).toBeLessThan(order.indexOf("native:live_update_confirm"));
    expect(coordinator.isPaused()).toBe(true); expect(document.documentElement.inert).toBe(true);

    // Activity can arrive during the commit ACK. Once native ownership commits,
    // that transient activity must not leave the restored UI permanently inert.
    appBlockers = ["file-read-in-progress"];
    expect(coordinator.readiness()).toContainEqual({ participant: "app-ui", reason: "file-read-in-progress" });
    confirmGate.resolve(); await finishing;
    expect(resumeLocal).toHaveBeenCalledTimes(1); expect(coordinator.isPaused()).toBe(false);
    expect(document.documentElement.inert).toBe(false);
    expect(() => coordinator.assertAllowed()).not.toThrow();
  });

  it("retries an uncertain confirmation ACK using the same transaction without replaying or resuming early", async () => {
    let confirmations = 0;
    native.mockImplementation(async command => {
      order.push(`native:${command}`);
      if (command === "live_update_bootstrap") return recovery();
      if (command === "live_update_confirm" && ++confirmations === 1) throw new Error("confirmation ACK lost");
      return undefined;
    });
    const finish = await prepareMountedRecovery();
    const finishing = finish();
    await vi.waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(coordinator.isPaused()).toBe(true); expect(document.documentElement.inert).toBe(true);
    expect(resumeLocal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250); await finishing;
    expect(confirmCalls()).toEqual([
      ["live_update_confirm", { transactionId: "transaction-preserved" }],
      ["live_update_confirm", { transactionId: "transaction-preserved" }],
    ]);
    expect(replay).toHaveBeenCalledTimes(1); expect(responder).toHaveBeenCalledTimes(1);
    expect(resumeLocal).toHaveBeenCalledTimes(1); expect(document.documentElement.inert).toBe(false);
  });

  it("does not release local ownership when native confirmation exhausts its bounded retries", async () => {
    native.mockImplementation(async command => {
      if (command === "live_update_bootstrap") return recovery();
      if (command === "live_update_confirm") throw new Error("native commit unavailable");
      return undefined;
    });
    const finish = await prepareMountedRecovery();
    const rejected = expect(finish()).rejects.toThrow("native commit unavailable");
    await vi.waitFor(() => expect(confirmCalls()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_500); await rejected;
    expect(confirmCalls()).toHaveLength(4);
    expect(resumeLocal).not.toHaveBeenCalled();
    expect(coordinator.isPaused()).toBe(true); expect(document.documentElement.inert).toBe(true);
  });

  it("bounds pre-commit readiness waiting without claiming health or unfreezing", async () => {
    chatBlockers = ["host-chat-ledger-not-restored"];
    const finish = await prepareMountedRecovery();
    const rejected = expect(finish()).rejects.toThrow(/host-chat-ledger-not-restored/);
    await vi.waitFor(() => expect(awaitReady).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(replay).not.toHaveBeenCalled(); expect(confirmCalls()).toHaveLength(0);
    expect(resumeLocal).not.toHaveBeenCalled(); expect(document.documentElement.inert).toBe(true);
  });

  it("confirms recovery despite new dialogs before readiness and during event replay", async () => {
    appBlockers = ["open-dialog"];
    const finish = await prepareMountedRecovery();
    replay.mockImplementation(async () => { appBlockers = ["open-dialog", "file-read-in-progress"]; });
    await finish();
    expect(confirmCalls()).toHaveLength(1);
    expect(resumeLocal).toHaveBeenCalledTimes(1);
    expect(coordinator.isPaused()).toBe(false);
    expect(document.documentElement.inert).toBe(false);
    expect(coordinator.readiness()).toContainEqual({ participant: "app-ui", reason: "open-dialog" });
  });

  it("observes chat after init and replay without inheriting native approval submitting as a handoff freeze", async () => {
    web = true;
    const chatGate = Promise.withResolvers<void>();
    const replayGate = Promise.withResolvers<void>();
    const observedChat = { version: 1, state: { bySession: { session: { messages: [{ planReview: { status: "submitting", revision: 2 } }] } } } };
    remote.mockResolvedValue({ observer: true, checkpoint: { version: 1, participants: { chat: observedChat } }, cursors: { "worker-a": 9 } });
    chatBlockers = ["approval-submitting:session"];
    appBlockers = ["unsaved-editor-drafts"];
    chatInit.mockImplementation(async () => { order.push("chat:init"); await chatGate.promise; });
    replay.mockImplementation(async () => { order.push("worker:replay"); await replayGate.promise; });
    const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
    const finish = await prepareLiveUpdateBootstrap();
    expect(initialize).toHaveBeenCalledWith({ version: 1, participants: { chat: observedChat } }, { requiredParticipants: ["chat"] });
    const finishing = finish();
    await vi.waitFor(() => expect(chatInit).toHaveBeenCalledTimes(1));
    expect(chatRestore).toHaveBeenCalledWith(observedChat);
    expect(replay).not.toHaveBeenCalled(); expect(document.documentElement.inert).toBe(true);
    chatGate.resolve();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(resumeLocal).not.toHaveBeenCalled();
    replayGate.resolve(); await finishing;
    expect(awaitReady).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled(); expect(prewarm).not.toHaveBeenCalled();
    expect(resumeLocal).toHaveBeenCalledTimes(1); expect(coordinator.isPaused()).toBe(false);
    expect(document.documentElement.inert).toBe(false);
    expect(observedChat.state.bySession.session.messages[0].planReview.status).toBe("submitting");
  });

  it("installs the observer responder after chat init and before advertising fresh desktop readiness", async () => {
    const chatGate = Promise.withResolvers<void>();
    const responderGate = Promise.withResolvers<void>();
    native.mockImplementation(async command => { order.push(`native:${command}`); return null; });
    chatInit.mockImplementation(async () => { order.push("chat:init"); await chatGate.promise; });
    responder.mockImplementation(async () => { await responderGate.promise; order.push("responder:installed"); return disposeResponder; });
    const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
    const finish = await prepareLiveUpdateBootstrap();
    const finishing = finish();
    await vi.waitFor(() => expect(chatInit).toHaveBeenCalledTimes(1));
    expect(responder).not.toHaveBeenCalled();
    chatGate.resolve(); await vi.waitFor(() => expect(responder).toHaveBeenCalledTimes(1));
    expect(native.mock.calls.map(([command]) => command)).toEqual(["live_update_bootstrap"]);
    responderGate.resolve(); await finishing;
    expect(order.indexOf("responder:installed")).toBeLessThan(order.indexOf("native:live_update_frontend_ready"));
    expect(confirmCalls()).toHaveLength(0); expect(document.documentElement.inert).toBe(false);
  });

  it("auto-resumes interrupted sessions returned by live_update_frontend_ready with 继续", async () => {
    const selectSession = vi.fn().mockImplementation(async () => { order.push("chat:selectSession"); });
    const send = vi.fn().mockImplementation(async () => { order.push("chat:send"); });
    vi.doMock("@/features/chat/store", () => {
      order.push("import:chat");
      coordinator.register({ id: "chat", capture: () => ({}), restore: chatRestore, readiness: () => chatBlockers });
      return {
        useChatStore: {
          getState: () => ({
            init: chatInit,
            active: { engine: "agy", sessionId: "sess-1", workspacePath: "G:\\Projects\\ccgui-custom" },
            selectSession,
            send,
          }),
        },
      };
    });
    native.mockImplementation(async command => {
      order.push(`native:${command}`);
      if (command === "live_update_bootstrap") return null;
      if (command === "live_update_frontend_ready") {
        return {
          resumeSessions: [
            { engine: "agy", sessionId: "sess-1", workspacePath: "G:\\Projects\\ccgui-custom", prompt: "继续" },
          ],
        };
      }
      return undefined;
    });
    const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
    const finish = await prepareLiveUpdateBootstrap();
    await finish();
    expect(selectSession).toHaveBeenCalledWith("agy", "sess-1", "G:\\Projects\\ccgui-custom", { background: false });
    expect(send).toHaveBeenCalledWith("继续", [], undefined, {
      engine: "agy",
      sessionId: "sess-1",
      workspacePath: "G:\\Projects\\ccgui-custom",
    });
    expect(order.indexOf("native:live_update_frontend_ready")).toBeLessThan(order.indexOf("chat:selectSession"));
    expect(order.indexOf("chat:selectSession")).toBeLessThan(order.indexOf("chat:send"));
  });

  it.each([false, true])("allows only explicit missing-command fallback (web=%s)", async (isWeb: boolean) => {
    web = isWeb;
    const command = web ? "runtime_observer_snapshot" : "live_update_bootstrap";
    (web ? remote : native).mockRejectedValue(new Error(`Command ${command} not found`));
    const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
    const finish = await prepareLiveUpdateBootstrap(); await finish();
    expect(initialize).toHaveBeenCalledWith(undefined, undefined);
    expect(workerInitialize).toHaveBeenCalledWith(undefined);
    expect(chatInit).not.toHaveBeenCalled(); expect(responder).not.toHaveBeenCalled();
    expect(resumeLocal).not.toHaveBeenCalled(); expect(confirmCalls()).toHaveLength(0);
    expect(document.documentElement.inert).toBe(false);
  });

  it.each([false, true])("surfaces general bootstrap errors instead of pretending the host is old (web=%s)", async (isWeb: boolean) => {
    web = isWeb;
    (web ? remote : native).mockRejectedValue(new Error("checkpoint archive file not found"));
    const { prepareLiveUpdateBootstrap } = await import("./live-update-bootstrap");
    await expect(prepareLiveUpdateBootstrap()).rejects.toThrow("checkpoint archive file not found");
    expect(initialize).not.toHaveBeenCalled(); expect(workerInitialize).not.toHaveBeenCalled();
    expect(order).not.toContain("import:app-ui"); expect(chatInit).not.toHaveBeenCalled();
    expect(resumeLocal).not.toHaveBeenCalled(); expect(confirmCalls()).toHaveLength(0);
  });
});
