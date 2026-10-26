import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: false, pauseWorkerEvents: vi.fn(), resumeWorkerEvents: vi.fn() }));
vi.mock("@/lib/runtime-checkpoint", () => ({ getRuntimeCheckpointReadiness: vi.fn(), prepareRuntimeCheckpoint: vi.fn(), abortRuntimeCheckpoint: vi.fn() }));
vi.mock("@/version/distribution", () => ({ IS_CUSTOM_DISTRIBUTION: true }));
vi.mock("@/features/plugins/runtime/update-close", () => ({ canClosePluginViewsForUpdate: vi.fn(), preparePluginViewsForUpdate: vi.fn(), resumePluginViewsAfterUpdate: vi.fn() }));

import { createLiveUpdateStore, startLiveUpdateRuntime, type LiveUpdateBlocker, type LiveUpdateDependencies, type LiveUpdateStatus, type LiveUpdateTransaction } from "./live-update";

const transaction: LiveUpdateTransaction = {
  id: "local-transaction", phase: "Preparing", previous: null,
  candidate: { manifestSha256: "a".repeat(64), channel: "protected-custom", releaseId: "local-one", version: "1.1.1+protected.31",
    workerProtocol: 1, checkpointSchema: 1, schemaHash: "b".repeat(64), executable: "ccgui-next.exe" },
};
const status = (candidate: LiveUpdateTransaction | null = transaction, blockers: string[] = []): LiveUpdateStatus => ({
  supported: true, state: { stateVersion: 1, active: null, transaction: candidate }, blockers, pendingHandoff: false,
});
const stores: ReturnType<typeof createLiveUpdateStore>[] = [];
function fixture() {
  const calls: string[] = [];
  let current = status();
  const native = vi.fn(async function (command: string): Promise<unknown> {
    calls.push(command);
    if (command === "live_update_status") return current;
    if (command === "live_update_stage") { current = status(); return transaction; }
    if (command === "live_update_abort") {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments[1] as unknown;
      if (!(args && typeof args === "object" && "defer" in args && (args as { defer?: boolean }).defer)) {
        current = status({ ...transaction, phase: "Failed" });
      }
    }
    return undefined;
  });
  const deps: LiveUpdateDependencies = {
    native: native as LiveUpdateDependencies["native"], custom: true, web: false,
    readiness: vi.fn(() => []),
    pauseEvents: vi.fn(async () => { calls.push("pause"); return { stream: 5 } as Awaited<ReturnType<LiveUpdateDependencies["pauseEvents"]>>; }),
    prepareCheckpoint: vi.fn(async () => { calls.push("checkpoint"); return { version: 1 as const, participants: { chat: "draft" } }; }),
    abortCheckpoint: vi.fn(() => { calls.push("abort-checkpoint"); }),
    resumeEvents: vi.fn(async () => { calls.push("resume"); }),
  };
  const create = () => { const store = createLiveUpdateStore(deps); stores.push(store); return store; };
  return { calls, native, deps, create, setStatus: (value: LiveUpdateStatus) => { current = value; } };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

afterEach(() => { for (const store of stores.splice(0)) store.getState().dispose(); vi.useRealTimers(); });

describe("local live update coordinator", () => {
  function closableFixture() {
    const f = fixture();
    let open = true;
    vi.mocked(f.deps.readiness).mockImplementation(() => open ? [{ participant: "app-ui", reason: "plugin-view-without-checkpoint" }] : []);
    f.deps.canClosePluginViews = vi.fn((blockers: readonly LiveUpdateBlocker[]) => blockers.length > 0 && blockers.every(b => ["plugin-view-without-checkpoint", "plugin-window-without-checkpoint"].includes(b.reason)));
    f.deps.preparePluginViews = vi.fn(async () => { f.calls.push("close-views"); open = false; });
    f.deps.resumePluginViews = vi.fn(() => { f.calls.push("resume-views"); });
    return { ...f, setOpen(value: boolean) { open = value; } };
  }

  it("saves and closes opt-in views before native admission, event pause and checkpoint", async () => {
    const f = closableFixture();
    f.setStatus(status(transaction, ["plugin-window-without-checkpoint"]));
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(f.calls).toEqual(["live_update_status", "close-views", "live_update_begin", "pause", "checkpoint", "live_update_activate"]);
    expect(store.getState().stage).toBe("handoff");
    expect(f.deps.resumePluginViews).not.toHaveBeenCalled();
  });

  it("offers owned service preparation before native admission without bypassing its final blocker check", async () => {
    const f = fixture();
    f.setStatus({ ...status(transaction, ["plugin-processes"]), blockerDetails: [{ reason: "plugin-processes", pluginId: "demo" }] });
    f.deps.canClosePluginViews = vi.fn((blockers: readonly LiveUpdateBlocker[]) => blockers.every(b => b.reason === "plugin-processes" && b.pluginId === "demo"));
    f.deps.preparePluginViews = vi.fn(async () => { f.calls.push("stop-service"); });
    f.deps.resumePluginViews = vi.fn();
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async command => {
      if (command === "live_update_begin") { f.calls.push(command); throw new Error("Update is waiting: plugin-processes"); }
      return original(command);
    });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(f.calls.slice(0, 3)).toEqual(["live_update_status", "stop-service", "live_update_begin"]);
    expect(f.calls).not.toContain("live_update_activate");
    expect(f.deps.resumePluginViews).toHaveBeenCalledOnce();
    expect(store.getState().stage).toBe("waiting");
  });

  it("never hides a generic or malformed process blocker behind a cooperative service", async () => {
    for (const extra of [{ reason: "plugin-processes" }, { reason: "plugin-processes", pluginId: "bad/id" }]) {
      const f = fixture();
      f.setStatus({ ...status(transaction, ["plugin-processes"]), blockerDetails: [
        { reason: "plugin-processes", pluginId: "demo" }, extra,
      ] });
      f.deps.canClosePluginViews = vi.fn((blockers: readonly LiveUpdateBlocker[]) => blockers.every(b => b.pluginId === "demo"));
      f.deps.preparePluginViews = vi.fn(async () => {});
      const store = f.create(); await store.getState().refresh(); await settle();
      expect(f.deps.preparePluginViews).not.toHaveBeenCalled();
      expect(store.getState().blockers).toContainEqual({ reason: "plugin-processes" });
    }
  });

  it("prepares loaded plugin controllers even when their views are already closed", async () => {
    const f = closableFixture(); f.setOpen(false);
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(f.calls).toEqual(["live_update_status", "close-views", "live_update_begin", "pause", "checkpoint", "live_update_activate"]);
    expect(store.getState().stage).toBe("handoff");
  });

  it("does not close views while another blocker exists or when no update is staged", async () => {
    for (const value of [status(transaction, ["terminal-sessions"]), status(null)]) {
      const f = closableFixture(); f.setStatus(value);
      const store = f.create(); await store.getState().refresh(); await settle();
      expect(f.deps.preparePluginViews).not.toHaveBeenCalled();
      expect(f.calls).toEqual(["live_update_status"]);
    }
    const f = closableFixture(); vi.mocked(f.deps.canClosePluginViews!).mockReturnValue(false);
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(f.deps.preparePluginViews).not.toHaveBeenCalled();
  });

  it("keeps the staged candidate on save failure, resumes views and exposes its cause", async () => {
    const f = closableFixture();
    vi.mocked(f.deps.preparePluginViews!).mockRejectedValue(new Error("Draft storage is unavailable"));
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(store.getState()).toMatchObject({ stage: "waiting", canCancel: true, transaction,
      blockers: [{ participant: "plugin-update-close", reason: "plugin-update-close-failed", detail: "Draft storage is unavailable" }] });
    expect(f.native).toHaveBeenCalledWith("live_update_abort", { transactionId: transaction.id, defer: true });
    expect(f.calls).toEqual(["live_update_status", "live_update_abort", "abort-checkpoint", "resume-views", "resume"]);
    vi.mocked(f.deps.preparePluginViews!).mockImplementation(async () => { f.setOpen(false); });
    await store.getState().refresh(); await settle();
    expect(store.getState().stage).toBe("handoff");
  });

  it("cancels a pending save promptly and never activates after its late completion", async () => {
    const f = closableFixture(); const pending = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    vi.mocked(f.deps.preparePluginViews!).mockImplementation(async value => { signal = value; await pending.promise; });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(store.getState().stage).toBe("applying");
    await store.getState().cancel();
    expect(signal?.aborted).toBe(true);
    expect(store.getState()).toMatchObject({ stage: "idle", cancelled: true });
    pending.resolve(); await settle();
    expect(f.calls).not.toContain("live_update_begin");
    expect(f.calls).not.toContain("live_update_activate");
    expect(f.deps.resumePluginViews).toHaveBeenCalledTimes(1);
  });

  it("bounds a non-cooperative preparation and preserves the candidate for retry", async () => {
    vi.useFakeTimers();
    const f = closableFixture(); const pending = Promise.withResolvers<void>();
    vi.mocked(f.deps.preparePluginViews!).mockReturnValue(pending.promise);
    const store = f.create(); await store.getState().refresh(); await settle();
    await vi.advanceTimersByTimeAsync(45_000); await settle();
    expect(store.getState()).toMatchObject({ stage: "waiting", transaction,
      blockers: [{ reason: "plugin-update-close-timeout" }] });
    expect(f.deps.resumePluginViews).toHaveBeenCalledTimes(1);
    pending.resolve(); await settle(); expect(f.calls).not.toContain("live_update_activate");
  });

  it("rechecks readiness after closing views and releases their freeze if a new blocker appears", async () => {
    const f = closableFixture();
    vi.mocked(f.deps.preparePluginViews!).mockImplementation(async () => {
      vi.mocked(f.deps.readiness).mockReturnValue([{ participant: "app-ui", reason: "open-dialog" }]);
    });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(store.getState()).toMatchObject({ stage: "waiting", blockers: [{ participant: "app-ui", reason: "open-dialog" }] });
    expect(f.calls).not.toContain("live_update_begin");
    expect(f.deps.resumePluginViews).toHaveBeenCalledTimes(1);
  });

  it("enriches each native run while retaining unrelated native and frontend blockers", async () => {
    const f = fixture();
    const details = [
      { reason: "legacy-runs", runId: "run-a", engine: "codex", sessionId: "session-a", state: "registered" as const },
      { reason: "legacy-runs", runId: "run-b", state: "reader-finished" as const },
    ];
    f.setStatus({ ...status(transaction, ["legacy-runs", "terminal-sessions"]), blockerDetails: [...details, details[0]] });
    vi.mocked(f.deps.readiness).mockReturnValue([{ participant: "chat", reason: "session-preparing" }]);
    const store = f.create();
    await store.getState().refresh();
    expect(store.getState().blockers).toEqual([...details, { reason: "terminal-sessions" }, { participant: "chat", reason: "session-preparing" }]);
    expect(store.getState().stage).toBe("waiting");
    expect(f.calls).toEqual(["live_update_status"]);
  });

  it.each([undefined, null, {}, [], [null, "bad", { reason: "legacy-runs", runId: 3 },
    { reason: "legacy-runs", state: "alive" }, { reason: "legacy-runs", runId: "bad\nrun" },
    { reason: "not-blocking", runId: "irrelevant" }]])("falls back to reason codes for unusable detail payload %j", async (details) => {
    const f = fixture();
    f.setStatus({ ...status(transaction, ["legacy-runs", "future-reason"]), blockerDetails: details } as LiveUpdateStatus);
    const store = f.create();
    await store.getState().refresh();
    expect(store.getState().blockers).toEqual([{ reason: "legacy-runs" }, { reason: "future-reason" }]);
    expect(store.getState().stage).toBe("waiting");
    expect(f.calls).toEqual(["live_update_status"]);
  });

  it("accepts unknown reason details only for authoritative reasons and drops extra fields", async () => {
    const f = fixture();
    f.setStatus({ ...status(transaction, ["future-reason", "legacy-runs"]), blockerDetails: [
      { reason: "future-reason", runId: "future-run", token: "must-not-propagate", participant: "forged" },
      { reason: "legacy-runs", state: "registry-unavailable" },
      { reason: "worker-unavailable", runId: "not-a-blocker" },
    ] } as LiveUpdateStatus);
    const store = f.create();
    await store.getState().refresh();
    expect(store.getState().blockers).toEqual([
      { reason: "future-reason", runId: "future-run" },
      { reason: "legacy-runs", state: "registry-unavailable" },
    ]);
  });

  it("adopts committed active identity with its transaction and channel, then replaces or clears it on successful reads", async () => {
    const f = fixture();
    const store = f.create();
    expect(store.getState().active).toBeNull();
    const committed: LiveUpdateTransaction = { ...transaction, phase: "Committed" };
    const channel = { version: 1, ready: [] };
    const snapshots: unknown[] = [];
    const stop = store.subscribe(state => {
      if (state.active !== null) snapshots.push({ active: state.active, transaction: state.transaction, channel: state.channel });
    });
    f.setStatus({ ...status(committed), state: { stateVersion: 1, active: committed.candidate, transaction: committed }, channel });
    await store.getState().refresh();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) expect(snapshot).toEqual({ active: committed.candidate, transaction: committed, channel });
    expect(store.getState()).toMatchObject({ active: committed.candidate, transaction: committed, channel, stage: "idle" });
    stop();

    const replacement = { ...committed.candidate, manifestSha256: "c".repeat(64), releaseId: "local-two" };
    f.setStatus({ ...status(null), state: { stateVersion: 1, active: replacement, transaction: null } });
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ active: replacement, transaction: null, channel: null });
    f.setStatus(status(null));
    await store.getState().refresh();
    expect(store.getState().active).toBeNull();
    expect(f.calls).toEqual(["live_update_status", "live_update_status", "live_update_status"]);
  });

  it("keeps web and non-custom clients away from native update commands", async () => {
    for (const mode of ["web", "official"] as const) {
      const f = fixture(); f.deps.web = mode === "web"; f.deps.custom = mode !== "official";
      const store = f.create(); const stop = store.getState().watch();
      await store.getState().refresh(); await store.getState().stagePackage("G:/package", "a".repeat(64)); await store.getState().cancel(); await store.getState().requestUpdate();
      expect(f.native).not.toHaveBeenCalled(); stop();
    }
  });

  it("marks a missing command unsupported without invoking an updater fallback", async () => {
    const f = fixture(); f.native.mockRejectedValue(new Error("Command live_update_status not found"));
    const store = f.create(); await store.getState().refresh();
    expect(store.getState().support).toBe("unsupported");
    expect(f.native.mock.calls.map((call: [string]) => call[0])).toEqual(["live_update_status"]);
  });

  it("requests registered changes once and adopts the native bounded batch", async () => {
    const f = fixture(); f.setStatus(status(null));
    const store = f.create(); await store.getState().refresh();
    const change = { id: "c1", changeId: "fix", summary: "Fix", sourceRoot: "G:/source" };
    store.setState({ channel: { version: 1, ready: [change] } });
    const reply = Promise.withResolvers<unknown>();
    f.native.mockImplementation(async (command) => command === "live_update_request" ? reply.promise : status(null));
    const first = store.getState().requestUpdate();
    await store.getState().requestUpdate();
    expect(store.getState().requesting).toBe(true);
    const calls = f.native.mock.calls.filter(([command]) => command === "live_update_request");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["live_update_request", { requestId: expect.stringMatching(/^ui-/) }]);
    const channel = { version: 1, ready: [], batch: { id: "b1", requestId: "native", sourceRoot: "G:/source", phase: "Building", changes: [change] } };
    reply.resolve({ channel }); await first;
    expect(store.getState()).toMatchObject({ requesting: false, channel, requestError: undefined });
    await store.getState().requestUpdate();
    expect(f.native.mock.calls.filter(([command]) => command === "live_update_request")).toHaveLength(1);
  });

  it("preserves a failed request id for an explicit retry without resubmitting on refresh", async () => {
    const f = fixture();
    const channel = { version: 1, ready: [], working: [{ id: "c1", changeId: "fix", summary: "Fix", sourceRoot: "G:/source" }] };
    f.setStatus({ ...status(null), channel });
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (command) => {
      if (command === "live_update_request") throw new Error("connection lost");
      return original(command);
    });
    const store = f.create(); await store.getState().refresh();
    await store.getState().requestUpdate();
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ requesting: false, requestError: "connection lost" });
    expect(f.native.mock.calls.filter(([command]) => command === "live_update_request")).toHaveLength(1);
    await store.getState().requestUpdate();
    const calls = f.native.mock.calls.filter(([command]) => command === "live_update_request");
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  });

  it("does not request an empty queue or replace a pending request", async () => {
    const f = fixture(); f.setStatus(status(null));
    const store = f.create(); await store.getState().refresh(); await store.getState().requestUpdate();
    store.setState({ channel: { version: 1, ready: [], working: [{ id: "w1", changeId: "fix", summary: "Fix", sourceRoot: "G:/source" }],
      updateRequest: { id: "r1", requestId: "existing", sourceRoot: "G:/source", targetChangeIds: ["fix"], waitingFor: ["fix"] } } });
    await store.getState().requestUpdate();
    expect(f.native.mock.calls.map(([command]) => command)).toEqual(["live_update_status"]);
  });

  it("recognizes an accepted request after a lost reply and uses a new id for later changes", async () => {
    const f = fixture();
    const channel = { version: 1, ready: [{ id: "c1", changeId: "fix", summary: "Fix", sourceRoot: "G:/source" }] };
    f.setStatus({ ...status(null), channel });
    const original = f.native.getMockImplementation()!;
    let acceptedId = "";
    f.native.mockImplementation(async (command, ...args: unknown[]) => {
      if (command === "live_update_request") {
        acceptedId = (args[0] as { requestId: string }).requestId;
        throw new Error("reply lost");
      }
      return original(command);
    });
    const store = f.create(); await store.getState().refresh(); await store.getState().requestUpdate();
    const firstId = acceptedId;
    f.setStatus({ ...status(null), channel: { ...channel, batch: { id: "b1", requestId: firstId, sourceRoot: "G:/source", phase: "Committed", changes: [] } } });
    await store.getState().refresh(); expect(store.getState().requestError).toBeUndefined();
    await store.getState().requestUpdate(); expect(acceptedId).not.toBe(firstId);
  });

  it("ignores late request replies after teardown", async () => {
    const f = fixture(); const store = f.create();
    const channel = { version: 1, ready: [{ id: "c1", changeId: "fix", summary: "Fix", sourceRoot: "G:/source" }] };
    store.setState({ support: "supported", channel });
    const reply = Promise.withResolvers<unknown>(); f.native.mockImplementation(() => reply.promise);
    const request = store.getState().requestUpdate(); store.getState().dispose();
    reply.resolve({ channel: { version: 1, ready: [] } }); await request;
    expect(store.getState().channel).toBe(channel);
  });

  it("waits for native and UI blockers, then freezes, pauses, captures and activates in order", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setStatus(status(transaction, ["terminal-sessions"]));
    vi.mocked(f.deps.readiness).mockReturnValue([{ participant: "app-ui", reason: "unsaved-editor-drafts" }]);
    const store = f.create(); const stopRuntime = startLiveUpdateRuntime(store); const stop = store.getState().watch(); await settle();
    expect(store.getState().stage).toBe("waiting"); expect(store.getState().blockers).toHaveLength(2);
    expect(f.native.mock.calls.map((call: [string]) => call[0])).toEqual(["live_update_status"]);
    stop(); // Pending updates keep checking even after leaving settings.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.native).toHaveBeenCalledTimes(1);
    f.setStatus(status()); vi.mocked(f.deps.readiness).mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(f.calls).toEqual(["live_update_status", "live_update_status", "live_update_begin", "pause", "checkpoint", "live_update_activate"]);
    expect(f.native).toHaveBeenLastCalledWith("live_update_activate", {
      transactionId: transaction.id, checkpoint: { version: 1, participants: { chat: "draft" } }, cursors: { stream: 5 },
    });
    expect(store.getState().stage).toBe("handoff");
    stopRuntime();
  });

  it.each(["live_update_begin", "pause", "checkpoint", "live_update_activate"])("restores the old UI after %s fails and does not retry automatically", async (failing: string) => {
    vi.useFakeTimers();
    const f = fixture();
    if (failing === "pause") vi.mocked(f.deps.pauseEvents).mockImplementation(async () => { f.calls.push("pause"); throw new Error("pause failed"); });
    else if (failing === "checkpoint") vi.mocked(f.deps.prepareCheckpoint).mockImplementation(async () => { f.calls.push("checkpoint"); throw new Error("checkpoint failed"); });
    else {
      const original = f.native.getMockImplementation()!;
      f.native.mockImplementation(async (command: string) => { if (command === failing) { f.calls.push(command); throw new Error(`${command} failed`); } return original(command); });
    }
    const store = f.create(); store.getState().watch(); await settle();
    expect(f.calls.slice(-3)).toEqual(["live_update_abort", "abort-checkpoint", "resume"]);
    expect(store.getState().stage).toBe("error"); expect(store.getState().errorCode).toBe("switchFailed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls.filter(call => call === "live_update_begin")).toHaveLength(1);
  });

  it("defers back to waiting without failing the transaction when a dialog or native blocker appears during switch preparation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let checkpointAttempts = 0;
    vi.mocked(f.deps.prepareCheckpoint).mockImplementation(async () => {
      f.calls.push("checkpoint");
      if (++checkpointAttempts === 1) {
        throw new Error("Runtime checkpoint is blocked: app-ui:open-dialog");
      }
      return { version: 1 as const, participants: { chat: "draft" } };
    });
    const store = f.create(); const stop = startLiveUpdateRuntime(store); await settle();
    expect(f.native).toHaveBeenCalledWith("live_update_abort", { transactionId: transaction.id, defer: true });
    expect(store.getState()).toMatchObject({
      stage: "waiting",
      errorCode: undefined,
      error: undefined,
      canCancel: true,
      blockers: [{ participant: "app-ui", reason: "open-dialog" }],
      transaction: expect.objectContaining({ id: transaction.id, phase: "Preparing" }),
    });
    await vi.advanceTimersByTimeAsync(3_000); await settle();
    expect(store.getState().stage).toBe("handoff");
    expect(f.calls.filter(call => call === "live_update_activate")).toHaveLength(1);
    stop();
  });

  it("tries both local recovery steps even when native abort fails", async () => {
    const f = fixture();
    vi.mocked(f.deps.prepareCheckpoint).mockRejectedValue(new Error("capture failed"));
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (command: string) => { if (command === "live_update_abort") { f.calls.push(command); throw new Error("abort unavailable"); } return original(command); });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(f.calls.slice(-3)).toEqual(["live_update_abort", "abort-checkpoint", "resume"]);
    expect(store.getState()).toMatchObject({ stage: "error", errorCode: "recoveryFailed", canCancel: true, recoveryError: "abort unavailable" });
  });

  it("cancelling during native begin waits for its result and never activates", async () => {
    const f = fixture(); const begun = Promise.withResolvers<void>();
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (command: string) => { if (command === "live_update_begin") { f.calls.push(command); await begun.promise; return undefined; } return original(command); });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(store.getState().stage).toBe("applying");
    const cancelled = store.getState().cancel(); begun.resolve(); await cancelled;
    expect(f.calls).toEqual(["live_update_status", "live_update_begin", "live_update_abort", "abort-checkpoint", "resume"]);
    expect(store.getState()).toMatchObject({ stage: "idle", cancelled: true, transaction: null });
  });

  it("does not cancel after activate was dispatched", async () => {
    const f = fixture(); const activation = Promise.withResolvers<void>();
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (command: string) => { if (command === "live_update_activate") { f.calls.push(command); await activation.promise; return undefined; } return original(command); });
    const store = f.create(); await store.getState().refresh(); await settle();
    expect(store.getState().canCancel).toBe(false);
    await store.getState().cancel(); expect(f.calls).not.toContain("live_update_abort");
    activation.resolve(); await settle(); expect(store.getState().stage).toBe("handoff");
  });

  it("validates the independent hash before staging and stages only once", async () => {
    const f = fixture(); f.setStatus(status(null));
    const store = f.create(); await store.getState().refresh();
    await store.getState().stagePackage("G:/package", "bad");
    expect(f.native).toHaveBeenCalledTimes(1); expect(store.getState().errorCode).toBe("invalidInput");
    const staged = Promise.withResolvers<LiveUpdateTransaction>();
    const original = f.native.getMockImplementation()!;
    f.native.mockImplementation(async (command: string) => command === "live_update_stage" ? staged.promise : original(command));
    const first = store.getState().stagePackage("G:/package", "A".repeat(64));
    await store.getState().stagePackage("G:/package", "a".repeat(64));
    const cancellation = store.getState().cancel(); staged.resolve(transaction); await first; await cancellation;
    expect(f.native.mock.calls.filter((call: [string]) => call[0] === "live_update_stage")).toHaveLength(1);
    expect(f.native).toHaveBeenCalledWith("live_update_stage", { source: "G:/package", manifestSha256: "a".repeat(64) });
    expect(f.calls).not.toContain("live_update_begin");
  });

  it("stops inactive polling on unmount and ignores stale status after cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setStatus(status(null));
    const store = f.create(); const stop = store.getState().watch(); await settle(); stop();
    await vi.advanceTimersByTimeAsync(30_000); expect(f.native).toHaveBeenCalledTimes(1);
    f.setStatus(status(transaction, ["legacy-runs"])); await store.getState().refresh();
    const late = Promise.withResolvers<LiveUpdateStatus>();
    f.native.mockImplementationOnce(async () => late.promise);
    const refresh = store.getState().refresh(); await settle();
    await store.getState().cancel(); late.resolve(status()); await refresh; await settle();
    expect(f.calls).not.toContain("live_update_begin"); expect(store.getState().cancelled).toBe(true);
  });

  it("discovers an externally staged update without mounting settings and waits for a safe window", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setStatus(status(null));
    const store = f.create(); const stop = startLiveUpdateRuntime(store); await settle();
    f.setStatus(status(transaction, ["terminal-sessions"]));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(store.getState().stage).toBe("waiting");
    expect(f.calls).not.toContain("live_update_begin");
    f.setStatus(status());
    await vi.advanceTimersByTimeAsync(3_000); await settle();
    expect(f.calls.slice(-4)).toEqual(["live_update_begin", "pause", "checkpoint", "live_update_activate"]);
    expect(f.calls).not.toContain("live_update_stage");
    expect(store.getState().stage).toBe("handoff");
    stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("makes global runtime startup a no-op for web and ordinary distributions", async () => {
    vi.useFakeTimers();
    for (const mode of ["web", "official"] as const) {
      const f = fixture(); f.deps.web = mode === "web"; f.deps.custom = mode !== "official";
      const stop = startLiveUpdateRuntime(f.create());
      await vi.advanceTimersByTimeAsync(10_000); stop();
      expect(f.native).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one timer across runtime owners and can stop/restart without duplicate activation", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.setStatus(status(transaction, ["legacy-runs"]));
    const store = f.create(); const stopA = startLiveUpdateRuntime(store); const stopB = startLiveUpdateRuntime(store);
    await settle(); expect(vi.getTimerCount()).toBe(1);
    stopA(); stopA(); expect(vi.getTimerCount()).toBe(1);
    stopB(); expect(vi.getTimerCount()).toBe(0);
    const reads = f.native.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000); expect(f.native).toHaveBeenCalledTimes(reads);
    f.setStatus(status());
    const stopC = startLiveUpdateRuntime(store); await settle();
    expect(f.calls.filter(call => call === "live_update_activate")).toHaveLength(1);
    stopC(); const stopD = startLiveUpdateRuntime(store); await settle(); stopD();
    expect(f.calls.filter(call => call === "live_update_activate")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a pending status response after the last global watcher stops", async () => {
    vi.useFakeTimers();
    const f = fixture(); const late = Promise.withResolvers<LiveUpdateStatus>();
    f.native.mockImplementationOnce(async () => late.promise);
    const store = f.create(); const stop = startLiveUpdateRuntime(store);
    stop(); late.resolve(status()); await settle();
    expect(f.calls).not.toContain("live_update_begin");
    expect(vi.getTimerCount()).toBe(0);
    const restarted = startLiveUpdateRuntime(store); await settle();
    expect(f.calls.filter(call => call === "live_update_activate")).toHaveLength(1);
    restarted(); expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes automatic handoff after a transient statusFailed poll recovers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.native.getMockImplementation()!;
    let statusReads = 0;
    f.native.mockImplementation(async (command: string) => {
      if (command === "live_update_status" && ++statusReads === 1) {
        f.calls.push(command);
        throw new Error("transient IPC failure");
      }
      return original(command);
    });
    const store = f.create(); const stop = startLiveUpdateRuntime(store); await settle();
    expect(store.getState()).toMatchObject({ stage: "error", errorCode: "statusFailed" });
    expect(f.calls).toEqual(["live_update_status"]);
    await vi.advanceTimersByTimeAsync(10_000); await settle();
    expect(store.getState().errorCode).toBeUndefined();
    expect(store.getState().stage).toBe("handoff");
    expect(f.calls).toEqual(["live_update_status", "live_update_status", "live_update_begin", "pause", "checkpoint", "live_update_activate"]);
    stop();
  });

  it("automatically applies a new transaction after a previous transaction failed, rolled back, or was cancelled", async () => {
    vi.useFakeTimers();
    const nextTransaction: LiveUpdateTransaction = {
      ...transaction,
      id: "next-transaction",
      candidate: { ...transaction.candidate, manifestSha256: "c".repeat(64), releaseId: "local-two" },
    };
    for (const initialPhase of ["Failed", "RolledBack"] as const) {
      const f = fixture();
      f.setStatus(status({ ...transaction, phase: initialPhase, failureReason: "CandidateHealthTimeout" }));
      const store = f.create(); const stop = startLiveUpdateRuntime(store); await settle();
      expect(store.getState()).toMatchObject({ stage: "error", errorCode: "previousFailed" });
      f.setStatus(status(nextTransaction));
      await vi.advanceTimersByTimeAsync(10_000); await settle();
      expect(store.getState().errorCode).toBeUndefined();
      expect(store.getState().stage).toBe("handoff");
      expect(f.native).toHaveBeenLastCalledWith("live_update_activate", expect.objectContaining({ transactionId: "next-transaction" }));
      stop();
    }

    const f = fixture(); f.setStatus(status(transaction, ["terminal-sessions"]));
    const store = f.create(); const stop = startLiveUpdateRuntime(store); await settle();
    await store.getState().cancel();
    expect(store.getState()).toMatchObject({ stage: "idle", cancelled: true });
    f.setStatus(status(nextTransaction));
    await vi.advanceTimersByTimeAsync(3_000); await settle();
    expect(store.getState()).toMatchObject({ stage: "handoff", cancelled: false });
    expect(f.native).toHaveBeenLastCalledWith("live_update_activate", expect.objectContaining({ transactionId: "next-transaction" }));
    stop();
  });
});
