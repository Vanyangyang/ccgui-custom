import test from "node:test";
import assert from "node:assert/strict";
import worker, { Relay, profileCredential, profileRoomName } from "../deploy/worker/src/index.js";

const key = "synthetic-relay-key-not-a-live-credential";
const devKey = "synthetic-development-key-not-a-live-credential";
const a = `dev-${"a".repeat(64)}`;
const b = `dev-${"b".repeat(64)}`;

test("profile capability advertisement reads no key and selects no room", async () => {
  const env = { STABLE_RELAY_ORIGIN: "https://relay.fixture", DEVELOPMENT_RELAY_ORIGIN: "https://dev.fixture",
    get RELAY_KEY() { throw new Error("must not read a key"); }, get DEVELOPMENT_RELAY_KEY() { throw new Error("must not read a key"); },
    RELAY: { get() { throw new Error("must not select a room"); } } };
  const response = await worker.fetch(new Request("https://dev.fixture/.well-known/ccgui-relay-profile"), env);
  assert.deepEqual(await response.json(), { protocol: "ccgui-profile-v2", profilePrefix: "/.ccgui-dev/", independentCredentials: true,
    independentOrigin: true, stableOrigin: "https://relay.fixture", developmentOrigin: "https://dev.fixture" });
});

test("shared, unknown and wrong development origins reject before keys or rooms", async () => {
  const env = { STABLE_RELAY_ORIGIN: "https://relay.fixture", DEVELOPMENT_RELAY_ORIGIN: "https://dev.fixture",
    get RELAY_KEY() { throw new Error("must not read a key"); }, get DEVELOPMENT_RELAY_KEY() { throw new Error("must not read a key"); },
    RELAY: { get() { throw new Error("must not select a room"); } } };
  for (const url of [`https://relay.fixture/agent?profile=${a}`, `https://relay.fixture/.ccgui-dev/${a}/`, "https://dev.fixture/agent"]) {
    assert.equal((await worker.fetch(new Request(url), env)).status, 403);
  }
  for (const developmentOrigin of [undefined, "https://RELAY.fixture:443/"]) {
    const missing_or_shared = Object.create(env);
    missing_or_shared.DEVELOPMENT_RELAY_ORIGIN = developmentOrigin;
    assert.equal((await worker.fetch(new Request(`https://relay.fixture/agent?profile=${a}`),
      missing_or_shared)).status, 403);
  }
});

test("legacy worker rejects scoped credentials before selecting its stable room", async () => {
  const token = await profileCredential(key, a);
  assert.notEqual(token, key);
  let selections = 0;
  // Frozen legacy /agent authorization boundary, from the pre-patch Worker.
  const legacy = (url: URL) => {
    if (url.pathname === "/agent" && url.searchParams.get("key") !== key) return 403;
    selections += 1;
    return 101;
  };
  assert.equal(legacy(new URL(`https://relay.fixture/agent?key=${token}&profile=${a}`)), 403);
  assert.equal(selections, 0);
  assert.equal(profileRoomName(key, null), key);
  assert.notEqual(profileRoomName(key, a), key);
  assert.notEqual(profileRoomName(key, a), profileRoomName(key, b));
});

test("development registration, reconnect, stale frames and exit preserve the stable session", async () => {
  const NativeResponse = globalThis.Response;
  const NativeSocket = globalThis.WebSocket;
  const NativePair = (globalThis as any).WebSocketPair;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: unknown[] = [];
    received: unknown[] = [];
    peer?: Socket;
    listeners = new Map<string, Array<(event: any) => void>>();
    accept() {}
    addEventListener(name: string, listener: (event: any) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    emit(name: string, event: any = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
    send(data: unknown) { this.sent.push(data); this.peer?.received.push(data); }
    // Cloudflare close notifications can arrive after the replacement socket.
    // Keep notification delivery explicit so this fixture cannot hide that race.
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.peer) this.peer.readyState = 3;
    }
  }
  class Pair {
    0 = new Socket();
    1 = new Socket();
    constructor() { this[0].peer = this[1]; this[1].peer = this[0]; }
  }
  class EdgeResponse extends NativeResponse {
    webSocket?: Socket;
    edgeStatus: number;
    constructor(body: any, init: any = {}) {
      super(body, { ...init, status: init.status === 101 ? 200 : init.status });
      this.edgeStatus = init.status ?? 200;
      this.webSocket = init.webSocket;
    }
    get status() { return this.edgeStatus; }
  }
  (globalThis as any).WebSocket = Socket;
  (globalThis as any).WebSocketPair = Pair;
  (globalThis as any).Response = EdgeResponse;
  try {
    const rooms = new Map<string, Relay>();
    const env = { STABLE_RELAY_ORIGIN: "https://relay.fixture", DEVELOPMENT_RELAY_ORIGIN: "https://dev.fixture",
      RELAY_KEY: key, DEVELOPMENT_RELAY_KEY: devKey, RELAY: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!rooms.has(name)) rooms.set(name, new Relay());
        return rooms.get(name)!;
      },
    } };
    const request = (path: string) => {
      const origin = path.includes("profile=") || path.startsWith("/.ccgui-dev/") ? "https://dev.fixture" : "https://relay.fixture";
      return new Request(`${origin}${path}`, { headers: { Upgrade: "websocket", Origin: origin } });
    };
    await worker.fetch(request(`/agent?key=${key}`), env);
    const stable = rooms.get(key)!;
    const stableAgent = stable.agent as unknown as Socket;
    await worker.fetch(request("/ws?token=synthetic-stable-session"), env);
    const stableStreams = stable.streams.size;
    const stableFrames = stableAgent.sent.length;
    const token = await profileCredential(devKey, a);
    const connect = () => worker.fetch(request(`/agent?key=${token}&profile=${a}`), env);
    await connect();
    const development = rooms.get(profileRoomName(devKey, a))!;
    const oldAgent = development.agent as unknown as Socket;
    const oldPhone = await worker.fetch(request(`/.ccgui-dev/${a}/ws?token=synthetic-development-session`), env) as unknown as EdgeResponse;
    const openFrame = JSON.parse(String(oldAgent.sent[0]));
    assert.equal(openFrame.path, "/ws?token=synthetic-development-session");
    const oldHttp = worker.fetch(new Request(`https://dev.fixture/.ccgui-dev/${a}/pending-http`), env);
    let releaseBody!: (body: ArrayBuffer) => void;
    const oldUpload = development.fetch({
      url: "https://dev.fixture/slow-upload", method: "POST", headers: new Headers(),
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { releaseBody = resolve; }),
    } as Request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(development.streams.size, 2);
    await connect();
    const currentAgent = development.agent as unknown as Socket;
    assert.equal(oldPhone.webSocket?.readyState, 3, "old browser must close before its agent's delayed close event");
    assert.equal(development.streams.size, 0, "both old WS and HTTP streams must be cleared synchronously");
    releaseBody(new ArrayBuffer(0));
    assert.equal((await oldUpload).status, 502, "an old request body must not register a stream on the replacement");
    assert.deepEqual(currentAgent.sent, []);
    const oldHttpResponse = await oldHttp;
    assert.equal(oldHttpResponse.status, 502);
    assert.equal(await oldHttpResponse.text(), "", "old HTTP body must finish instead of hanging");
    const currentPhone = await worker.fetch(request(`/.ccgui-dev/${a}/ws?token=synthetic-development-session`), env) as unknown as EdgeResponse;
    const newStream = [...development.streams.keys()].at(-1)!;
    const framesBeforeStaleCallbacks = [...currentAgent.sent];
    oldAgent.emit("close");
    oldPhone.webSocket?.peer?.emit("close");
    oldPhone.webSocket?.peer?.emit("message", { data: "late browser frame" });
    assert.equal(development.agent, currentAgent);
    assert.equal(currentPhone.webSocket?.readyState, Socket.OPEN);
    assert.equal(development.streams.has(newStream), true, "stale close must not clear the replacement's streams");
    assert.deepEqual(currentAgent.sent, framesBeforeStaleCallbacks, "stale browser callbacks must not send frames to the new agent");
    oldAgent.emit("message", { data: JSON.stringify({ t: "data", id: newStream, b64: btoa("stale"), text: true }) });
    assert.deepEqual(currentPhone.webSocket?.received, []);
    currentAgent.emit("message", { data: JSON.stringify({ t: "data", id: newStream, b64: btoa("current"), text: true }) });
    assert.deepEqual(currentPhone.webSocket?.received, ["current"]);
    const currentHttp = worker.fetch(new Request(`https://dev.fixture/.ccgui-dev/${a}/second-http`), env);
    await new Promise<void>((resolve) => setImmediate(resolve));
    currentAgent.close(); // Normal development exit/update, only its own room.
    currentAgent.emit("close");
    assert.equal(development.agent, null);
    assert.equal(development.streams.size, 0);
    assert.equal(currentPhone.webSocket?.readyState, 3);
    const currentHttpResponse = await currentHttp;
    assert.equal(currentHttpResponse.status, 502);
    assert.equal(await currentHttpResponse.text(), "");
    assert.equal(stable.agent, stableAgent);
    assert.equal(stableAgent.readyState, Socket.OPEN);
    assert.equal(stableAgent.sent.length, stableFrames);
    assert.equal(stable.streams.size, stableStreams);
    const wrong = await worker.fetch(request(`/agent?key=${key}&profile=${b}`), env);
    assert.equal(wrong.status, 403);
    assert.equal(rooms.has(profileRoomName(devKey, b)), false);
  } finally {
    globalThis.Response = NativeResponse;
    globalThis.WebSocket = NativeSocket;
    (globalThis as any).WebSocketPair = NativePair;
  }
});
