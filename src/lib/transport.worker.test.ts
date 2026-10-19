import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(frame: string) { this.sent.push(JSON.parse(frame)); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  message(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello() { this.message({ type: "hello", version: "1.2.0" }); }
  close() { this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  reply(frame: Record<string, unknown>, payload: unknown) { this.message({ type: "response", id: frame.id, ok: true, payload }); }
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function web() {
  const location = { protocol: "https:", host: "example.test", pathname: "/", search: "?token=test" };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("location", location);
  vi.stubGlobal("WebSocket", FakeSocket);
  return import("./transport");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeSocket.all = [];
  native.invoke.mockReset();
  native.listen.mockReset();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  native.listen.mockResolvedValue(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("worker transport integration", () => {
  it("resends an identical stable worker start only after the next hello", async () => {
    const transport = await web();
    const request = transport.invoke("send_message", { engine: "claude", prompt: "中文😀", sessionId: null });
    const first = FakeSocket.all[0];
    first.open();
    await flush();
    expect(first.sent).toEqual([]);
    first.hello();
    expect(first.sent[0].cmd).toBe("runtime_worker_sources");
    first.reply(first.sent[0], []);
    await flush();
    expect(first.sent[1].cmd).toBe("runtime_worker_sources");
    first.reply(first.sent[1], []);
    await flush();
    const original = first.sent[2];
    expect(original.cmd).toBe("runtime_worker_start");
    expect(original.args).toMatchObject({ runId: expect.any(String), args: { engine: "claude", prompt: "中文😀", requireHostChat: true, requireLeader: false } });
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1];
    second.open();
    await flush();
    expect(second.sent).toEqual([]);
    second.hello();
    second.hello();
    await flush();
    expect(second.sent.filter(frame => frame.cmd === "runtime_worker_start")).toEqual([original]);
    for (const frame of second.sent.filter(frame => frame.cmd === "runtime_worker_sources")) second.reply(frame, []);
    second.reply(original, { handled: true, value: { runId: "accepted" } });
    await expect(request).resolves.toEqual({ runId: "accepted" });
  });

  it("retains the same control identity, but rejects a disconnected legacy fallback", async () => {
    const transport = await web();
    const request = transport.invoke("send_follow_up", { sessionId: "session-a", prompt: "next", imagePaths: ["image.png"] });
    const first = FakeSocket.all[0];
    first.open(); first.hello();
    first.reply(first.sent[0], []);
    await flush();
    const control = first.sent[1];
    expect(control.args).toMatchObject({ request: { key: "session-a", requestId: expect.any(String), command: { op: "followup", prompt: "next", image_paths: ["image.png"] } } });
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1];
    second.open(); second.hello();
    expect(second.sent[0]).toEqual(control);
    second.reply(control, { handled: false });
    await flush();
    expect(second.sent[1].cmd).toBe("send_follow_up");
    const rejected = expect(request).rejects.toMatchObject({ code: "request-uncertain", command: "send_follow_up" });
    second.close();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    const third = FakeSocket.all[2];
    third.open(); third.hello();
    expect(third.sent).toEqual([]);
  });

  it("reports bounded uncertainty without turning a timed-out mutation into success", async () => {
    const transport = await web();
    const request = transport.invoke("runtime_worker_control", { request: { key: "run-a", requestId: "fixed-id", command: { op: "interrupt" } } });
    const socket = FakeSocket.all[0];
    socket.open(); socket.hello();
    const rejected = expect(request).rejects.toMatchObject({ code: "request-uncertain", requestId: "fixed-id" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await rejected;
  });

  it("restores paused cursors and delivers replay and legacy events once to public listeners", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(async (name: string, cb: (event: { payload: unknown }) => void) => { callbacks.set(name, cb); return () => callbacks.delete(name); });
    native.invoke.mockImplementation(async (cmd: string) => cmd === "runtime_worker_sources" ? [{ streamId: "worker-a", runId: "run-a", head: 2 }] : {
      stream_id: "worker-a", through: 2, events: [{ stream_id: "worker-a", seq: 2, name: "engine://event", payload: "replayed" }],
    });
    const transport = await import("./transport");
    await transport.initializeWorkerEvents({ "worker-a": 1 });
    const delivered = vi.fn();
    const unlisten = await transport.listen("engine://event", delivered);
    await flush();
    expect(native.invoke).not.toHaveBeenCalled();
    await transport.resumeWorkerEvents();
    callbacks.get("runtime://worker-event")!({ payload: { stream_id: "worker-a", seq: 2, name: "engine://event", payload: "replayed" } });
    callbacks.get("engine://event")!({ payload: "legacy" });
    await transport.pauseWorkerEvents();
    expect(delivered.mock.calls).toEqual([[{ payload: "replayed" }], [{ payload: "legacy" }]]);
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 2 });
    unlisten();
    expect(callbacks.has("engine://event")).toBe(false);
  });

  it("delivers value-free Claude quota invalidations from the worker journal, including replay", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(async (name: string, cb: (event: { payload: unknown }) => void) => { callbacks.set(name, cb); return () => callbacks.delete(name); });
    const envelope = { stream_id: "worker-a", seq: 1, name: "claude-quota://changed", payload: null };
    native.invoke.mockImplementation(async (cmd: string) => cmd === "runtime_worker_sources"
      ? [{ streamId: "worker-a", runId: "run-a", head: 1 }]
      : { stream_id: "worker-a", through: 1, events: [envelope] });
    const transport = await import("./transport");
    await transport.initializeWorkerEvents({ "worker-a": 0 });
    const changed = vi.fn();
    const stopQuota = await transport.listen("claude-quota://changed", changed);
    const stopEngine = await transport.listen("engine://event", vi.fn());
    await transport.resumeWorkerEvents();
    callbacks.get("runtime://worker-event")!({ payload: envelope });
    callbacks.get("runtime://worker-event")!({ payload: { ...envelope, seq: 2 } });
    await transport.pauseWorkerEvents();
    expect(changed.mock.calls).toEqual([[{ payload: null }], [{ payload: null }]]);
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 2 });
    stopQuota();
    stopEngine();
  });

  it.each([
    ["interrupt_session", { sessionId: "s" }, { op: "interrupt" }],
    ["interrupt_turn", { sessionId: "s" }, { op: "interrupt_turn" }],
    ["stop_native_task", { runId: "r", taskId: "t" }, { op: "stop_task", task_id: "t" }],
    ["answer_question", { sessionId: "s", requestId: "q", answers: { choice: ["a"] } }, { op: "answer_question", question_id: "q", answers: { choice: ["a"] } }],
  ])("maps %s controls to native snake case fields", async (cmd: string, args: Record<string, unknown>, command: Record<string, unknown>) => {
    native.invoke.mockImplementation(async (name: string) => name === "runtime_worker_sources" ? [] : { handled: true, value: true });
    const transport = await import("./transport");
    await expect(transport.invoke(cmd as string, args as Record<string, unknown>)).resolves.toBe(true);
    expect(native.invoke).toHaveBeenLastCalledWith("runtime_worker_control", { request: { key: "runId" in args ? args.runId : args.sessionId, requestId: expect.any(String), command } });
  });

  it("caches explicit missing-command support and keeps old native events and send working", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(async (name: string, cb: (event: { payload: unknown }) => void) => { callbacks.set(name, cb); return () => callbacks.delete(name); });
    native.invoke.mockImplementation(async (name: string) => {
      if (name.startsWith("runtime_worker_")) throw `Command ${name} not found`;
      return "legacy-result";
    });
    const transport = await import("./transport");
    const delivered = vi.fn();
    await transport.listen("engine://event", delivered);
    await flush();
    callbacks.get("engine://event")!({ payload: "old-native" });
    await expect(transport.invoke("send_message", { engine: "claude", prompt: "hello" })).resolves.toBe("legacy-result");
    await expect(transport.invoke("interrupt_session", { sessionId: "s" })).resolves.toBe("legacy-result");
    expect(native.invoke.mock.calls.filter((call: unknown[]) => String(call[0]).startsWith("runtime_worker_"))).toHaveLength(1);
    expect(delivered).toHaveBeenCalledWith({ payload: "old-native" });
  });

  it("never falls back after an uncertain worker start or a general probe error", async () => {
    const uncertain = { code: "outcomeUnknown", message: "worker disconnected" };
    native.invoke.mockImplementation(async (name: string) => {
      if (name === "runtime_worker_sources") return [];
      throw uncertain;
    });
    const transport = await import("./transport");
    await expect(transport.invoke("send_message", { engine: "claude", prompt: "hello" })).rejects.toEqual(uncertain);
    expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).toEqual(["runtime_worker_sources", "runtime_worker_sources", "runtime_worker_start"]);
    vi.resetModules();
    native.invoke.mockReset().mockRejectedValue(new Error("worker archive file not found"));
    const second = await import("./transport");
    await expect(second.invoke("send_message", {})).rejects.toThrow("worker archive file not found");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("falls back on an explicitly absent wrapper after successful capability discovery", async () => {
    native.invoke.mockImplementation(async (name: string) => {
      if (name === "runtime_worker_sources") return [];
      if (name === "runtime_worker_start") throw new Error("unknown command: runtime_worker_start");
      return "old-engine";
    });
    const transport = await import("./transport");
    await expect(transport.invoke("send_message", { runId: "stable-run" })).resolves.toBe("old-engine");
    await expect(transport.invoke("send_message", { runId: "second-run" })).resolves.toBe("old-engine");
    expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).toEqual(["runtime_worker_sources", "runtime_worker_sources", "runtime_worker_start", "send_message", "send_message"]);
    expect(native.invoke).toHaveBeenLastCalledWith("send_message", { runId: "second-run" });
  });

  it("does not accept malformed worker success as a successful send", async () => {
    native.invoke.mockImplementation(async (name: string) => name === "runtime_worker_sources" ? [] : { handled: true });
    const transport = await import("./transport");
    await expect(transport.invoke("send_message", {})).rejects.toThrow("Invalid worker start response");
    expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).not.toContain("send_message");
  });

  it("retains replay reads with the same arguments across a disconnect", async () => {
    const transport = await web();
    const request = transport.invoke("runtime_worker_events", { streamId: "worker-a", after: 9, limit: 256 });
    const first = FakeSocket.all[0];
    first.open(); first.hello();
    const original = first.sent[0];
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1];
    second.open(); second.hello();
    expect(second.sent).toEqual([original]);
    second.reply(original, { stream_id: "worker-a", through: 9, events: [] });
    await expect(request).resolves.toMatchObject({ through: 9 });
  });

  it("attaches only requested runs while paused and replays them after resume", async () => {
    native.invoke.mockImplementation(async (name: string) => name === "runtime_worker_sources" ? [
      { streamId: "worker-a", runId: "run-a", head: 1 },
      { streamId: "worker-b", runId: "run-b", head: 50 },
    ] : { stream_id: "worker-a", through: 1, events: [{ stream_id: "worker-a", seq: 1, name: "engine://event", payload: "attached" }] });
    const transport = await import("./transport");
    await transport.initializeWorkerEvents();
    await transport.pauseWorkerEvents();
    const delivered = vi.fn();
    await transport.listen("engine://event", delivered);
    await flush();
    await transport.attachRunSources(["run-a"]);
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 0 });
    expect(delivered).not.toHaveBeenCalled();
    await transport.resumeWorkerEvents();
    expect(delivered).toHaveBeenCalledExactlyOnceWith({ payload: "attached" });
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 1 });
  });

  it("retries only unacknowledged listeners after a partial fanout and completes pause safely", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => { callbacks.set(name, callback); return () => {}; });
    const envelope = { stream_id: "worker-a", seq: 1, name: "engine://event", payload: "delta" };
    native.invoke.mockImplementation(async (name: string) => name === "runtime_worker_sources" ? [] : { stream_id: "worker-a", through: 1, events: [envelope] });
    const transport = await import("./transport");
    const received: string[] = [];
    const errors = vi.fn();
    await transport.listen("transport://worker-error", errors);
    await transport.listen<string>("engine://event", event => received.push(event.payload));
    const second = vi.fn().mockImplementationOnce(() => { throw new Error("second consumer failed"); });
    await transport.listen("engine://event", second);
    callbacks.get("runtime://worker-event")!({ payload: envelope });
    await expect(transport.pauseWorkerEvents()).resolves.toEqual({ "worker-a": 1 });
    expect(received).toEqual(["delta"]);
    expect(second).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith({ payload: expect.objectContaining({ code: "emit-failed", streamId: "worker-a" }) });
  });

  it("rejects checkpoint pause while a partial fanout remains uncommitted", async () => {
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    native.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => { callbacks.set(name, callback); return () => {}; });
    const envelope = { stream_id: "worker-a", seq: 1, name: "engine://event", payload: "delta" };
    let started = false;
    native.invoke.mockImplementation(async (name: string) => name === "runtime_worker_sources"
      ? started ? [{ streamId: "worker-a", runId: "run-a", head: 1 }] : []
      : { stream_id: "worker-a", through: 1, events: [envelope] });
    const transport = await import("./transport");
    const first = vi.fn();
    const second = vi.fn<() => void>(() => { throw new Error("consumer still unavailable"); });
    await transport.listen("engine://event", first);
    await transport.listen("engine://event", second);
    started = true;
    callbacks.get("runtime://worker-event")!({ payload: envelope });
    await expect(transport.pauseWorkerEvents()).rejects.toMatchObject({ code: "emit-failed" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 0 });
    const late = vi.fn();
    await transport.listen("engine://event", late);
    second.mockImplementation(() => {});
    await transport.resumeWorkerEvents();
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled(); // Same envelope keeps its original subscriber snapshot.
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-a": 1 });
  });

  it("awaits delayed subscriptions before starting, then attaches the accepted run to recover missing sequence 1", async () => {
    const subscription = Promise.withResolvers<void>();
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const order: string[] = [];
    native.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
      if (name === "runtime://worker-event") await subscription.promise;
      callbacks.set(name, callback); order.push(name); return () => {};
    });
    let accepted = false;
    const frames = [1, 2].map(seq => ({ stream_id: "worker-accepted", seq, name: "engine://event", payload: `delta-${seq}` }));
    native.invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      order.push(name);
      if (name === "runtime_worker_sources") return accepted ? [{ streamId: "worker-accepted", runId: "actual-run", head: 2 }] : [];
      if (name === "runtime_worker_start") {
        accepted = true;
        callbacks.get("runtime://worker-event")!({ payload: frames[1] });
        return { handled: true, value: { runId: "actual-run" } };
      }
      return { stream_id: "worker-accepted", through: 2, events: frames.filter(frame => frame.seq > Number(args?.after ?? 0)) };
    });
    const transport = await import("./transport");
    const delivered = vi.fn();
    let listening = false;
    const ready = transport.listen("engine://event", delivered).then(() => { listening = true; });
    const sent = transport.invoke("send_message", { runId: "requested-run", prompt: "hello" });
    await flush();
    expect(listening).toBe(false);
    expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).not.toContain("runtime_worker_start");
    subscription.resolve();
    await ready;
    await expect(sent).resolves.toEqual({ runId: "actual-run" });
    await flush();
    await transport.pauseWorkerEvents();
    expect(order.indexOf("runtime://worker-event")).toBeLessThan(order.indexOf("runtime_worker_start"));
    expect(delivered.mock.calls).toEqual([[{ payload: "delta-1" }], [{ payload: "delta-2" }]]);
    expect(transport.getWorkerEventCursors()).toEqual({ "worker-accepted": 2 });
    expect(native.invoke.mock.calls.filter((call: unknown[]) => call[0] === "runtime_worker_start")).toHaveLength(1);
  });

  it("preserves an accepted start when view attachment fails and retries attachment without resending", async () => {
    native.listen.mockResolvedValue(() => {});
    let accepted = false;
    let attachAvailable = false;
    native.invoke.mockImplementation(async (name: string) => {
      if (name === "runtime_worker_sources") {
        if (!accepted) return [];
        if (!attachAvailable) throw new Error("archive temporarily unavailable");
        return [{ streamId: "worker-a", runId: "actual-run", head: 1 }];
      }
      if (name === "runtime_worker_start") { accepted = true; return { handled: true, value: { runId: "actual-run" } }; }
      return { stream_id: "worker-a", through: 1, events: [{ stream_id: "worker-a", seq: 1, name: "engine://event", payload: "recovered" }] };
    });
    const transport = await import("./transport");
    const delivered = vi.fn(); const errors = vi.fn();
    await transport.listen("transport://worker-error", errors);
    await transport.listen("engine://event", delivered);
    await expect(transport.invoke("send_message", { runId: "requested-run" })).resolves.toEqual({ runId: "actual-run" });
    await flush();
    expect(errors).toHaveBeenCalledWith({ payload: expect.objectContaining({ code: "accepted-run-attach-failed" }) });
    attachAvailable = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(delivered).toHaveBeenCalledExactlyOnceWith({ payload: "recovered" });
    const commands = native.invoke.mock.calls.map((call: unknown[]) => call[0]);
    expect(commands.filter(command => command === "runtime_worker_start")).toHaveLength(1);
    expect(commands).not.toContain("send_message");
  });

  it("retains a read-only observer snapshot across WebSocket reconnect", async () => {
    const transport = await web();
    const request = transport.invoke("runtime_observer_snapshot", { sessionIds: ["session-a"] });
    const first = FakeSocket.all[0]; first.open(); first.hello();
    const original = first.sent[0]; first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1]; second.open(); second.hello();
    expect(second.sent).toEqual([original]);
    second.reply(original, { sessions: [], cursors: {} });
    await expect(request).resolves.toEqual({ sessions: [], cursors: {} });
  });

  it("replays a supported native plan wrapper with identical identity and decision parameters after a lost response", async () => {
    const transport = await web();
    const args = { planId: "plan-native", expectedRevision: 3, decision: "request_changes", feedback: "保留原工作范围🙂" };
    const request = transport.invoke("respond_plan_review", args);
    const first = FakeSocket.all[0]; first.open(); first.hello();
    first.reply(first.sent[0], []); await flush();
    const original = first.sent[1];
    expect(original.cmd).toBe("runtime_worker_plan_review"); expect(original.args).toEqual(args);
    first.close(); await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1]; second.open(); second.hello(); await flush();
    expect(second.sent).toEqual([original]);
    const outcome = { outcome: "applied", review: { runId: "authoritative-native-run", revision: 3 } };
    second.reply(original, { handled: true, value: outcome });
    await expect(request).resolves.toEqual(outcome);
    expect(FakeSocket.all.flatMap(socket => socket.sent).some(frame => frame.cmd === "respond_plan_review")).toBe(false);
  });

  it("falls back once for a legacy plan and never replays that legacy decision after disconnect", async () => {
    const transport = await web();
    const args = { planId: "next-turn", expectedRevision: 1, decision: "approve", feedback: null };
    const request = transport.invoke("respond_plan_review", args);
    const first = FakeSocket.all[0]; first.open(); first.hello(); first.reply(first.sent[0], []); await flush();
    first.reply(first.sent[1], { handled: false }); await flush();
    expect(first.sent[2]).toMatchObject({ cmd: "respond_plan_review", args });
    const rejected = expect(request).rejects.toMatchObject({ code: "request-uncertain", command: "respond_plan_review" });
    first.close(); await rejected; await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.all[1]; second.open(); second.hello(); await flush();
    expect(second.sent).toEqual([]);
    expect(FakeSocket.all.flatMap(socket => socket.sent).filter(frame => frame.cmd === "respond_plan_review")).toHaveLength(1);
  });

  it("does not fall back on uncertain or general worker plan errors", async () => {
    for (const failure of [{ code: "outcomeUnknown", message: "plan acknowledgement lost" }, new Error("plan lookup failed")]) {
      native.invoke.mockImplementation(async (name: string) => { if (name === "runtime_worker_sources") return []; throw failure; });
      const transport = await import("./transport");
      await expect(transport.invoke("respond_plan_review", { planId: "p", expectedRevision: 2, decision: "defer" })).rejects.toEqual(failure);
      expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).not.toContain("respond_plan_review");
      native.invoke.mockClear();
    }
  });

  it("uses legacy approval once when the safe worker plan wrapper is explicitly unavailable", async () => {
    native.invoke.mockImplementation(async (name: string) => {
      if (name === "runtime_worker_sources") return [];
      if (name === "runtime_worker_plan_review") throw new Error("Command runtime_worker_plan_review not found");
      if (name === "runtime_worker_control") return { handled: true, value: true };
      return { outcome: "applied" };
    });
    const transport = await import("./transport");
    const args = { planId: "p", expectedRevision: 2, decision: "defer", feedback: null };
    await expect(transport.invoke("respond_plan_review", args)).resolves.toEqual({ outcome: "applied" });
    expect(native.invoke.mock.calls.map((call: unknown[]) => call[0])).toEqual(["runtime_worker_sources", "runtime_worker_plan_review", "respond_plan_review"]);
    expect(native.invoke).toHaveBeenLastCalledWith("respond_plan_review", args);
    // An older host may support existing task workers but not this new wrapper.
    // Missing optional plan support must not disable worker control/event routing.
    await expect(transport.invoke("interrupt_session", { runId: "running-worker" })).resolves.toBe(true);
    expect(native.invoke.mock.calls.at(-1)![0]).toBe("runtime_worker_control");
  });
});
