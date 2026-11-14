import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerEventTransport, WorkerEventTransportError } from "./worker-event-transport";

// Vitest does not expose Vite's hot context. Evaluate the actual module with
// that one environment binding supplied so tests invoke its real dispose hook.
const compiled = transpileModule(
  readFileSync(resolve(process.cwd(), "src/lib/transport.ts"), "utf8").replaceAll("import.meta.hot", "globalThis.__hot"),
  { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } },
).outputText;

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: Socket[] = [];
  readyState = Socket.CONNECTING;
  binaryType = "";
  sent: Record<string, unknown>[] = [];
  onopen?: (() => void) | null;
  onclose?: (() => void) | null;
  onmessage?: ((event: { data: string }) => void) | null;
  constructor(_url: string) { Socket.all.push(this); }
  send(frame: string) { this.sent.push(JSON.parse(frame)); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  hello() { this.readyState = Socket.OPEN; this.onopen?.(); this.message({ type: "hello", version: "1" }); }
  reply(frame: Record<string, unknown>, payload: unknown) { this.message({ type: "response", id: frame.id, ok: true, payload }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

let transport: typeof import("./transport");
let dispose: () => void;
let logError: ReturnType<typeof vi.fn>;
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  const exports = {};
  logError = vi.fn();
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === "./relay-profile") return { relayProfilePath: (path: string) => path };
      if (name === "./worker-event-transport") return { WorkerEventTransport, WorkerEventTransportError };
      if (name.startsWith("@tauri-apps/api/")) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
    __hot: { dispose: (callback: () => void) => { dispose = callback; } },
    window: { location: { search: "" } },
    location: { protocol: "https:", host: "fixture.test" },
    WebSocket: Socket, Promise, Map, Set, Error, TextDecoder, URLSearchParams, crypto,
    setTimeout, clearTimeout, console: { error: logError },
  });
  transport = exports as typeof transport;
});
afterEach(async () => {
  dispose();
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["respond_plan_review", "send_message", "send_follow_up"])("fences %s when HMR follows the support probe response", async (command) => {
  const request = transport.invoke(command, { sessionId: "session", runId: "run", requestId: "decision" });
  const rejected = expect(request).rejects.toMatchObject({ code: "transport-disconnected" });
  const socket = Socket.all[0];
  socket.hello();
  expect(socket.sent.map(frame => frame.cmd)).toEqual(["runtime_worker_sources"]);
  socket.reply(socket.sent[0], []);
  dispose(); // Before the already-resolved probe's await continuation runs.
  await flush();
  expect(Socket.all).toHaveLength(1);
  await rejected;
  expect(socket.sent.map(frame => frame.cmd)).toEqual(["runtime_worker_sources"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("fences an engine subscription between raw registration and its await continuation", async () => {
  const listener = vi.fn();
  const ready = transport.listen("engine://event", listener);
  const rejected = expect(ready).rejects.toMatchObject({ code: "transport-disconnected" });
  const socket = Socket.all[0];
  const lateMessage = socket.onmessage;
  dispose();
  await flush();
  expect(Socket.all).toHaveLength(1);
  await rejected;
  lateMessage?.({ data: JSON.stringify({ type: "event", name: "engine://event", payload: "stale" }) });
  expect(listener).not.toHaveBeenCalled();
  expect(socket.sent).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

async function pendingStart() {
  const request = transport.invoke("send_message", { runId: "accepted-run", prompt: "fixture" });
  const socket = Socket.all[0];
  socket.hello();
  let replied = 0;
  for (let step = 0; step < 5; step++) {
    await flush();
    const start = socket.sent.find(frame => frame.cmd === "runtime_worker_start");
    if (start) return { request, socket, start };
    for (const frame of socket.sent.slice(replied)) {
      expect(frame.cmd).toBe("runtime_worker_sources");
      socket.reply(frame, []);
    }
    replied = socket.sent.length;
  }
  throw new Error("Worker start was not reached");
}

it("preserves an accepted start across HMR without queuing attachment work", async () => {
  const { request, socket, start } = await pendingStart();
  const count = socket.sent.length;
  socket.reply(start, { handled: true, value: { runId: "accepted-run" } });
  dispose();
  await expect(request).resolves.toEqual({ runId: "accepted-run" });
  await flush();
  expect(Socket.all).toHaveLength(1);
  expect(socket.sent).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
  expect(logError).not.toHaveBeenCalled();
});

it.each(["pending", "resolved"])("does not revive attachment work after its %s source read is disposed", async (phase) => {
  const { request, socket, start } = await pendingStart();
  socket.reply(start, { handled: true, value: { runId: "accepted-run" } });
  await expect(request).resolves.toEqual({ runId: "accepted-run" });
  await flush();
  const sourceRead = socket.sent.at(-1)!;
  expect(sourceRead.cmd).toBe("runtime_worker_sources");
  const count = socket.sent.length;
  if (phase === "resolved") socket.reply(sourceRead, [{ streamId: "worker-run", runId: "accepted-run", head: 1 }]);
  dispose();
  await flush();
  expect(Socket.all).toHaveLength(1);
  expect(socket.sent).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
  expect(logError).not.toHaveBeenCalled();
});

it("rejects fresh calls on the disposed module and retains sent mutation uncertainty", async () => {
  const pending = transport.invoke("runtime_worker_control", { request: { requestId: "control" } });
  const rejected = expect(pending).rejects.toMatchObject({ code: "request-uncertain" });
  const socket = Socket.all[0];
  socket.hello();
  dispose();
  await rejected;
  await expect(transport.invoke("task_snapshot")).rejects.toMatchObject({ code: "transport-disconnected" });
  await expect(transport.listen("task://changed", vi.fn())).rejects.toMatchObject({ code: "transport-disconnected" });
  await expect(transport.serverVersion()).resolves.toBeNull();
  expect(Socket.all).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
