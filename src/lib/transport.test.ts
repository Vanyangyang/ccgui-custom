import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  binaryType = "";
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  send = vi.fn();
  constructor(_url: string) { Socket.instances.push(this); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(async () => {
  const transport = await import("./transport");
  transport.disposeWebBridge();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("notifies snapshot consumers on initial and reconnected handshakes and removes listeners", async () => {
  const { listen, invoke } = await import("./transport");
  const connected = vi.fn();
  const changed = vi.fn();
  const off = await listen("transport://connected", connected);
  const offChanged = await listen("task://changed", changed);
  const first = Socket.instances[0];
  first.open();
  expect(connected).not.toHaveBeenCalled();
  first.message({ type: "hello", version: "1" });
  expect(connected).toHaveBeenCalledTimes(1);
  first.message({ type: "event", name: "task://changed", payload: null });
  expect(changed).toHaveBeenCalledWith({ payload: null });

  const pending = invoke("task_snapshot");
  const rejected = expect(pending).rejects.toMatchObject({ code: "request-uncertain", command: "task_snapshot" });
  await Promise.resolve();
  first.close();
  await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  const second = Socket.instances[1];
  second.open();
  second.message({ type: "hello", version: "1" });
  expect(connected).toHaveBeenCalledTimes(2);
  off(); offChanged();
  second.message({ type: "hello", version: "1" });
  second.message({ type: "event", name: "task://changed", payload: null });
  expect(connected).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("preserves typed tool errors without changing ordinary command failures", async () => {
  const { invoke } = await import("./transport");
  const error = { code: "conflict", message: "configuration changed" };
  const first = invoke("mcp_set_enabled", {});
  const rejected = expect(first).rejects.toEqual(error);
  const socket = Socket.instances[0];
  socket.open();
  expect(socket.send).not.toHaveBeenCalled();
  socket.message({ type: "hello", version: "1" });
  await Promise.resolve();
  const request = JSON.parse(socket.send.mock.calls[0][0]);
  socket.message({ type: "response", id: request.id, ok: false, error: JSON.stringify(error) });
  await rejected;

  const second = invoke("skills_hub_mutate", {});
  const disconnected = expect(second).rejects.toMatchObject({ code: "request-uncertain", command: "skills_hub_mutate" });
  await Promise.resolve();
  socket.close();
  await disconnected;
});

it("cancels a real reconnect timer when the last subscription unmounts", async () => {
  vi.useRealTimers();
  const { listen } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  const socket = Socket.instances[0];
  socket.close();
  off();
  // Keep the environment alive past the real retry deadline, as a larger
  // Vitest run does after this component's test environment is torn down.
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(Socket.instances).toHaveLength(1);
});

it("does not reconnect after an unsubscribed connection closes late", async () => {
  const { listen } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  const socket = Socket.instances[0];
  const lateClose = socket.onclose;
  off();
  lateClose?.();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(1);
});

it("retains retries for another listener and clears them after the last listener leaves", async () => {
  const { listen } = await import("./transport");
  const firstOff = await listen("task://changed", vi.fn());
  const lastOff = await listen("transport://connected", vi.fn());
  Socket.instances[0].close();
  firstOff();
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.instances).toHaveLength(2);
  Socket.instances[1].close();
  lastOff();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(2);
});

it("reconnects an outstanding safe request after unlisten, then stops after completion", async () => {
  const { listen, invoke } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  const request = invoke("runtime_observer_snapshot");
  const first = Socket.instances[0];
  first.open(); first.message({ type: "hello" });
  const frame = JSON.parse(first.send.mock.calls[0][0]);
  first.close(); off();
  await vi.advanceTimersByTimeAsync(1000);
  const second = Socket.instances[1];
  second.open(); second.message({ type: "hello" });
  expect(second.send).toHaveBeenCalledWith(JSON.stringify(frame));
  second.message({ type: "response", id: frame.id, ok: true, payload: [] });
  await expect(request).resolves.toEqual([]);
  second.close();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(2);
});

it("clears retries when the last replayable request times out", async () => {
  const { invoke } = await import("./transport");
  const request = invoke("runtime_observer_snapshot");
  const rejected = expect(request).rejects.toMatchObject({ code: "transport-disconnected" });
  Socket.instances[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(298_500);
  Socket.instances[1].close();
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(2);
});

it("releases an unavailable version waiter without reconnecting forever", async () => {
  const { serverVersion } = await import("./transport");
  const version = serverVersion();
  Socket.instances[0].close();
  await expect(version).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(1);
});

it("keeps an in-flight legacy request alive after its last listener leaves", async () => {
  const { listen, invoke } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  const request = invoke("task_snapshot");
  const socket = Socket.instances[0];
  off();
  expect(socket.readyState).toBe(Socket.CONNECTING);
  socket.open(); socket.message({ type: "hello" });
  const frame = JSON.parse(socket.send.mock.calls[0][0]);
  socket.message({ type: "response", id: frame.id, ok: true, payload: "complete" });
  await expect(request).resolves.toBe("complete");
  socket.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.instances).toHaveLength(1);
});

it("preserves a version waiter when the last subscription leaves during handshake", async () => {
  const { listen, serverVersion } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  const version = serverVersion();
  const socket = Socket.instances[0];
  off();
  expect(socket.readyState).toBe(Socket.CONNECTING);
  socket.open(); socket.message({ type: "hello", version: "2" });
  await expect(version).resolves.toBe("2");
});

it("disposes sent mutations as uncertain and reads as disconnected without replay", async () => {
  const { invoke, disposeWebBridge } = await import("./transport");
  const legacy = invoke("mcp_set_enabled", {});
  const stable = invoke("runtime_worker_control", { request: { requestId: "stable" } });
  const read = invoke("runtime_observer_snapshot");
  const legacyRejected = expect(legacy).rejects.toMatchObject({ code: "request-uncertain" });
  const stableRejected = expect(stable).rejects.toMatchObject({ code: "request-uncertain", requestId: "stable" });
  const readRejected = expect(read).rejects.toMatchObject({ code: "transport-disconnected" });
  const socket = Socket.instances[0];
  socket.open(); socket.message({ type: "hello" });
  expect(socket.send).toHaveBeenCalledTimes(3);
  disposeWebBridge();
  await Promise.all([legacyRejected, stableRejected, readRejected]);
  expect(socket.readyState).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(Socket.instances).toHaveLength(1);
});

it("disposes unsent requests and version waiters and ignores all late socket callbacks", async () => {
  const { invoke, listen, serverVersion, disposeWebBridge } = await import("./transport");
  const callback = vi.fn();
  const off = await listen("task://changed", callback);
  const legacy = invoke("task_snapshot");
  const stable = invoke("runtime_worker_control", { request: { requestId: "unsent" } });
  const version = serverVersion();
  const rejected = [legacy, stable].map(request => expect(request).rejects.toMatchObject({ code: "transport-disconnected" }));
  const socket = Socket.instances[0];
  const lateOpen = socket.onopen;
  const lateMessage = socket.onmessage;
  const lateClose = socket.onclose;
  disposeWebBridge();
  await Promise.all(rejected);
  await expect(version).resolves.toBeNull();
  const nextOff = await listen("task://changed", callback);
  lateOpen?.();
  lateMessage?.({ data: JSON.stringify({ type: "hello" }) });
  lateMessage?.({ data: JSON.stringify({ type: "event", name: "task://changed", payload: 1 }) });
  lateClose?.();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(socket.send).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(2);
  off(); nextOff();
});

it("disposes a disconnected replayable request and cancels its queued reconnect", async () => {
  const { invoke, disposeWebBridge } = await import("./transport");
  const request = invoke("runtime_worker_control", { request: { requestId: "lost" } });
  const rejected = expect(request).rejects.toMatchObject({ code: "request-uncertain" });
  const socket = Socket.instances[0];
  socket.open(); socket.message({ type: "hello" }); socket.close();
  disposeWebBridge();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(Socket.instances).toHaveLength(1);
});

it("supersedes an older queued retry when a consumer opens a fresh connection", async () => {
  const { listen } = await import("./transport");
  const off = await listen("task://changed", vi.fn());
  Socket.instances[0].close();
  await vi.advanceTimersByTimeAsync(500);
  const secondOff = await listen("task://changed", vi.fn());
  Socket.instances[1].close();
  await vi.advanceTimersByTimeAsync(500);
  expect(Socket.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1500);
  expect(Socket.instances).toHaveLength(3);
  off(); secondOff();
});

it.each([2, 3])("settles legacy work before replacing a socket in state %s whose close event is queued", async (closingState) => {
  const { invoke, listen } = await import("./transport");
  const mutation = invoke("mcp_set_enabled", {});
  const rejected = expect(mutation).rejects.toMatchObject({ code: "request-uncertain", command: "mcp_set_enabled" });
  const stable = invoke("runtime_worker_control", { request: { requestId: "stable-control" } });
  const first = Socket.instances[0];
  first.open(); first.message({ type: "hello" });
  const stableFrame = first.send.mock.calls.map(call => JSON.parse(call[0])).find(frame => frame.cmd === "runtime_worker_control");
  const lateClose = first.onclose;
  first.readyState = closingState;
  const off = await listen("task://changed", vi.fn());
  await rejected;
  const second = Socket.instances[1];
  second.open(); second.message({ type: "hello" });
  expect(second.send.mock.calls.map(call => JSON.parse(call[0]))).toEqual([stableFrame]);
  lateClose?.();
  second.message({ type: "response", id: stableFrame.id, ok: true, payload: "accepted" });
  await expect(stable).resolves.toBe("accepted");
  expect(Socket.instances.flatMap(socket => socket.send.mock.calls).map(call => JSON.parse(call[0])).filter(frame => frame.cmd === "mcp_set_enabled")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(2);
  off();
});

it.each([false, true])("settles old legacy work (sent=%s) without discarding a new mutation on the replacement socket", async (sent) => {
  const { invoke } = await import("./transport");
  const old = invoke("mcp_set_enabled", {});
  const rejected = expect(old).rejects.toMatchObject({ code: sent ? "request-uncertain" : "transport-disconnected", command: "mcp_set_enabled" });
  const first = Socket.instances[0];
  if (sent) { first.open(); first.message({ type: "hello" }); }
  const lateClose = first.onclose;
  first.readyState = 2;
  const next = invoke("skills_hub_mutate", { requestId: "new-mutation" });
  await rejected;
  const second = Socket.instances[1];
  second.open(); second.message({ type: "hello" });
  const frames = second.send.mock.calls.map(call => JSON.parse(call[0]));
  expect(frames.map(frame => frame.cmd)).toEqual(["skills_hub_mutate"]);
  lateClose?.();
  second.message({ type: "response", id: frames[0].id, ok: true, payload: "current" });
  await expect(next).resolves.toBe("current");
  expect(first.send).toHaveBeenCalledTimes(sent ? 1 : 0);
  expect(Socket.instances.flatMap(socket => socket.send.mock.calls).map(call => JSON.parse(call[0])).filter(frame => frame.cmd === "skills_hub_mutate")).toHaveLength(1);
  second.close();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Socket.instances).toHaveLength(2);
});
