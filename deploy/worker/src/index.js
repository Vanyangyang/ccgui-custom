/**
 * CC GUI 中继（Cloudflare Worker）——让手机在外网访问本机 CC GUI，而无需在
 * 本机开放任何入站端口。
 *
 * 桌面端主动外连 /agent?key=<secret> 并保持一条 WebSocket；此后每个进来的请求
 * 都成为这条连接上的一条流，因此「谁能进来」仍然只由桌面端自己的桥接决定：URL
 * 里的 token 与逐设备授权都在应用内完成。本 Worker 只校验 key 并搬运字节。
 *
 * 流是具名且多路复用的，每个 key 一个 Durable Object 持有 agent socket，所以
 * 重连的桌面端永远不会和自己交错。
 *
 * ---
 *
 * CC GUI relay: lets a phone reach the desktop app without opening any
 * inbound port on the desktop.
 *
 * The desktop dials OUT to /agent?key=<secret> and keeps one WebSocket open.
 * Every request that arrives here becomes a stream on that socket, so the
 * desktop's own bridge stays the only thing that decides who gets in: the
 * token in the URL and the per-device approval both happen inside the app.
 * This Worker only checks the key and moves bytes.
 *
 * Streams are named and multiplexed, and one Durable Object per key owns the
 * agent socket, so a reconnecting desktop can never interleave with itself.
 */

const AGENT_PATH = "/agent";
const PROFILE_SCOPE = /^dev-[a-f0-9]{64}$/;

export async function profileCredential(key, scope) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}\0${key}`));
  return "ccgui-dev-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function profileRoomName(key, scope) {
  return scope ? `${key}\0development-profile\0${scope}` : key;
}

export class Relay {
  constructor() {
    /** @type {WebSocket | null} */
    this.agent = null;
    this.nextId = 1;
    /** @type {Map<number, (t: string, frame: any) => void>} */
    this.streams = new Map();
  }

  send(frame, agent = this.agent) {
    if (this.agent === agent && agent?.readyState === WebSocket.OPEN) agent.send(JSON.stringify(frame));
  }

  closeStreams() {
    const previous = [...this.streams.values()];
    this.streams.clear();
    for (const deliver of previous) deliver("close", {});
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === AGENT_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      // A reconnecting desktop replaces the previous socket; otherwise the
      // phone would keep talking into a pipe nobody reads.
      if (this.agent && this.agent !== server) {
        // close is asynchronous: release old streams before changing ownership,
        // otherwise the stale socket's identity guard cannot clean them up.
        this.closeStreams();
        try {
          this.agent.close(1012, "replaced by a new agent connection");
        } catch {}
      }
      this.agent = server;
      server.addEventListener("message", (event) => {
        if (this.agent === server) this.onAgentFrame(event.data);
      });
      server.addEventListener("close", () => {
        if (this.agent !== server) return;
        this.agent = null;
        this.closeStreams();
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.agent || this.agent.readyState !== WebSocket.OPEN) {
      return new Response(
        "CC GUI 桌面端未连接到中继。请在电脑上打开 CC GUI → 设置 → 远程访问 → 外网访问，启动中转。",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return request.headers.get("Upgrade") === "websocket"
      ? this.tunnelSocket(request)
      : this.tunnelHttp(request);
  }

  /** HTTP: request head + body in, response head + chunks out. */
  async tunnelHttp(request) {
    const agent = this.agent;
    const id = this.nextId++;
    const body = new Uint8Array(await request.arrayBuffer());
    if (this.agent !== agent || agent?.readyState !== WebSocket.OPEN) {
      return new Response("relay agent replaced while reading request", { status: 502 });
    }
    const headers = {};
    for (const [name, value] of request.headers) {
      // The hop is TLS-terminated here; the desktop's bridge sees plain HTTP.
      if (["host", "cf-connecting-ip", "cf-ray", "upgrade", "connection"].includes(name.toLowerCase())) continue;
      headers[name] = value;
    }

    let resolveHead;
    const headReady = new Promise((r) => (resolveHead = r));
    let controller;
    const queued = [];
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
        for (const chunk of queued.splice(0)) c.enqueue(chunk);
      },
      cancel: () => {
        this.streams.delete(id);
        this.send({ t: "close", id }, agent);
      },
    });

    this.streams.set(id, (kind, frame) => {
      if (kind === "head") {
        resolveHead({ status: frame.status, headers: frame.headers ?? {} });
        return;
      }
      if (kind === "data") {
        const bytes = bytesFromBase64(frame.b64);
        if (controller) {
          try {
            controller.enqueue(bytes);
          } catch {}
        } else {
          queued.push(bytes);
        }
        return;
      }
      if (kind === "close" || kind === "error") {
        this.streams.delete(id);
        const finish = () => {
          try {
            controller?.close();
          } catch {}
        };
        // A stream that died before its head still needs a valid response.
        resolveHead({ status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
        if (controller) finish();
        else queued.push(new TextEncoder().encode(frame.message ?? "relay stream closed"));
        return;
      }
    });

    const path = new URL(request.url).pathname + new URL(request.url).search;
    this.send({ t: "open", id, method: request.method, path, headers }, agent);
    if (body.length) this.send({ t: "body", id, b64: base64FromBytes(body) }, agent);
    this.send({ t: "end", id }, agent);

    // A head that never came back still has to release the stream: the desktop
    // may answer later (or never), and leaving the entry in `streams` leaks one
    // per timed-out request while the phone waits on a body nobody will close.
    let timeoutId;
    const timeout = new Promise((r) => {
      timeoutId = setTimeout(
        () => r({ status: 504, headers: { "content-type": "text/plain; charset=utf-8" }, expired: true }),
        30000,
      );
    });
    const head = await Promise.race([headReady, timeout]);
    clearTimeout(timeoutId);
    if (head.expired) {
      this.streams.delete(id);
      this.send({ t: "close", id }, agent);
      try {
        controller?.close();
      } catch {}
    }
    return new Response(stream, { status: head.status, headers: head.headers });
  }

  /** Live socket (the app's /ws): frames travel both ways, unframed. */
  tunnelSocket(request) {
    const agent = this.agent;
    // Actual browser upgrade headers, before accepting the socket. Never accept
    // an Origin/device assertion from a later JSON message or proxy header.
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin) return new Response("forbidden origin", { status: 403 });
    const id = this.nextId++;
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const headers = {};
    for (const [name, value] of request.headers) {
      if (["host", "cf-connecting-ip", "cf-ray", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"].includes(name.toLowerCase())) continue;
      headers[name] = value;
    }

    this.streams.set(id, (kind, frame) => {
      if (kind === "data") {
        try {
          // The app's client reads JSON; a frame the desktop sent as text must
          // not turn into a Blob on the way (it used to, and every response was
          // dropped).
          const bytes = bytesFromBase64(frame.b64);
          if (frame.text === false) server.send(bytes);
          else server.send(new TextDecoder().decode(bytes));
        } catch {}
        return;
      }
      if (kind === "close" || kind === "error") {
        this.streams.delete(id);
        try {
          server.close(1012, "relay stream closed");
        } catch {}
      }
    });

    const path = new URL(request.url).pathname + new URL(request.url).search;
    this.send({ t: "open", id, ws: true, path, headers }, agent);

    server.addEventListener("message", (event) => {
      if (this.agent !== agent || !this.streams.has(id)) return;
      const isText = typeof event.data === "string";
      const bytes = isText ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      this.send({ t: "data", id, b64: base64FromBytes(bytes), text: isText }, agent);
    });
    server.addEventListener("close", () => {
      if (this.agent !== agent || !this.streams.has(id)) return;
      this.streams.delete(id);
      this.send({ t: "close", id }, agent);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  onAgentFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const deliver = this.streams.get(frame.id);
    deliver?.(frame.t, frame);
  }
}

function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesFromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Public origin metadata only, not identity authentication. Capability
// negotiation must never read keys; origin comparison uses URL normalization.
function relayOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function profileOrigins(env) {
  const stableOrigin = relayOrigin(env.STABLE_RELAY_ORIGIN);
  const developmentOrigin = relayOrigin(env.DEVELOPMENT_RELAY_ORIGIN);
  return stableOrigin && developmentOrigin && stableOrigin !== developmentOrigin
    ? { stableOrigin, developmentOrigin } : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origins = profileOrigins(env);
    if (url.pathname === "/.well-known/ccgui-relay-profile") {
      return Response.json({ protocol: "ccgui-profile-v2", profilePrefix: "/.ccgui-dev/", independentCredentials: true,
        independentOrigin: !!origins, ...(origins ?? {}) });
    }
    const queryScope = url.pathname === AGENT_PATH ? url.searchParams.get("profile") : null;
    const pathScope = /^\/\.ccgui-dev\/(dev-[a-f0-9]{64})(\/.*)$/.exec(url.pathname);
    if (queryScope !== null && !PROFILE_SCOPE.test(queryScope)) return new Response("invalid profile", { status: 400 });
    if (url.pathname.startsWith("/.ccgui-dev/") && !pathScope) return new Response("invalid profile route", { status: 400 });
    const development = queryScope !== null || pathScope !== null;
    // Fail before reading credentials, selecting a room or replacing an agent.
    // The development origin cannot serve the stable route either.
    if ((development && (!origins || url.origin !== origins.developmentOrigin))
      || (!development && origins && url.origin === origins.developmentOrigin)) {
      return new Response("independent development origin required", { status: 403 });
    }
    const key = development ? env.DEVELOPMENT_RELAY_KEY : env.RELAY_KEY;
    if (!key) return new Response("relay key is not configured", { status: 500 });
    if (development && key === env.RELAY_KEY) return new Response("development relay requires independent credentials", { status: 403 });

    // 1. The desktop's own connection: /agent?key=<secret>.
    if (url.pathname === AGENT_PATH) {
      const scope = url.searchParams.get("profile");
      if (scope !== null && !PROFILE_SCOPE.test(scope)) return new Response("invalid profile", { status: 400 });
      const expected = scope ? await profileCredential(key, scope) : key;
      if (url.searchParams.get("key") !== expected) return new Response("forbidden", { status: 403 });
      return env.RELAY.get(env.RELAY.idFromName(profileRoomName(key, scope))).fetch(request);
    }

    if (url.pathname.startsWith("/.ccgui-dev/")) {
      const match = /^\/\.ccgui-dev\/(dev-[a-f0-9]{64})(\/.*)$/.exec(url.pathname);
      if (!match) return new Response("invalid profile route", { status: 400 });
      // Only this room receives the stripped browser route. Its streams and
      // agent replacement/close state never belong to the stable room.
      url.pathname = match[2];
      return env.RELAY.get(env.RELAY.idFromName(profileRoomName(key, match[1]))).fetch(new Request(url, request));
    }

    // 2. Everyone else is the phone, and its URL carries the app's own token:
    //    the desktop's bridge is what decides (token + per-device approval),
    //    so this Worker holds no policy beyond "is there a desktop attached".
    return env.RELAY.get(env.RELAY.idFromName(key)).fetch(request);
  },
};
