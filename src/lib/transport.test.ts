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
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
