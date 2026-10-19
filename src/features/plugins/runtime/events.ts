import { listen, isWeb } from "@/lib/transport";
import { listenEngineEvents, type EngineEventPayload } from "@/lib/events";
import type { Disposer, HostChatSession, HostChatActivationEvent } from "@ccgui/plugin-sdk";

/**
 * Plugin event bus (plan §5.2 ctx.events). Carries host→plugin topics (e.g.
 * `usage://updated`, bridged from engine events below) and plugin↔plugin
 * topics. Delivery is synchronous; listener errors are isolated so one bad
 * plugin can't break the bus for others.
 */
type Listener = (data: unknown) => void;

/** Topic plugins subscribe to for live token-usage snapshots (plan §5.2). */
export const USAGE_UPDATED_TOPIC = "usage://updated";

/** Engine `done` events (SDK 0.3.8): `data.usage` carries the turn's final
 *  usage, the only usage channel for engines like grok that never emit a
 *  standalone usage event, and the precise turn-end signal for all others.
 *  Native Claude (session-state lifecycle) reports each response's usage on
 *  usage://updated instead (see forwardUsageEvent) and its final done may
 *  carry null; only a legacy Claude CLI that reports no session state and
 *  has no background task at the end of its reply still reports usage solely
 *  here. */
export const USAGE_DONE_TOPIC = "usage://done";

/** Active-session switches (SDK 0.3.8): `{ engine, sessionId }`; a pending
 * tab reports sessionId null, clearing all tabs reports both null. Actual
 * native window focus also carries { origin: "host", reason: "window-focus",
 * target: HostChatSession }. Blur preserves selection; no heartbeat emits it. */
export const SESSION_ACTIVATED_TOPIC = "session://activated";

/** Host→plugin topic carrying the composer's in-progress draft (plan §5.2). */
export const COMPOSER_DRAFT_TOPIC = "composer://draft";

/**
 * Retained topics: the latest payload is replayed to late subscribers.
 *
 * `session://activated` is retained because the host emits it while the chat
 * store hydrates on app start (restored tabs go through activateTab then
 * selectSession), typically before plugins finish loading (read main.js,
 * dynamic import, activate - each async). A plugin subscribing later would
 * otherwise never learn the active session/engine, and the SDK exposes no
 * getter to ask for it. Replay is idempotent for consumers (the same value
 * they would have received live); every other topic stays fire-and-forget.
 */
const RETAINED_TOPICS = new Set<string>([SESSION_ACTIVATED_TOPIC]);
const retained = new Map<string, unknown>();

const listeners = new Map<string, Set<Listener>>();

export const pluginBus = {
  on(topic: string, cb: Listener): Disposer {
    let set = listeners.get(topic);
    if (!set) {
      set = new Set();
      listeners.set(topic, set);
    }
    set.add(cb);
    // Late subscriber on a retained topic: deliver the current value once, so
    // "which session is active right now" is answerable at any point in time.
    if (RETAINED_TOPICS.has(topic) && retained.has(topic)) {
      try {
        cb(retained.get(topic));
      } catch (error) {
        console.error(`[plugins] retained listener on "${topic}" threw`, error);
      }
    }
    return () => {
      set.delete(cb);
      if (set.size === 0) listeners.delete(topic);
    };
  },

  emit(topic: string, data: unknown): void {
    if (RETAINED_TOPICS.has(topic)) retained.set(topic, data);
    const set = listeners.get(topic);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(data);
      } catch (error) {
        console.error(`[plugins] listener on "${topic}" threw`, error);
      }
    }
  },
};

/** Drop listeners and retained payloads (tests only). */
export function resetPluginBusForTests(): void {
  listeners.clear();
  retained.clear();
}

/**
 * Emit-side topic namespace guard (plan §5.2): a plugin may emit only its own
 * `plugin:<id>:*` topics and shared `plugin-`-prefixed topics (e.g.
 * plugin-config://changed). Host topics (usage://updated, composer://draft)
 * and other plugins' `plugin:<otherId>:*` namespaces throw, because emit is
 * broadcast: cross-namespace writes would let one plugin impersonate the
 * host or spam a sibling.
 */
export function assertPluginEmitTopic(pluginId: string, topic: string): void {
  if (topic.startsWith(`plugin:${pluginId}:`) || topic.startsWith("plugin-")) return;
  throw new Error(
    `[plugins] "${pluginId}" may not emit topic "${topic}" (allowed: plugin:${pluginId}:* or shared plugin-*)`,
  );
}

let bridged = false;
let agentBridged = false;

/** 插件 agent 事件话题前缀：agent://<pluginId>，payload 为引擎事件信封。 */
export const AGENT_EVENT_TOPIC_PREFIX = "agent://";

/** run id 内嵌属主（Rust plugin_agent_start: pa-<pluginId>-<32hex>）。 */
export function pluginIdFromAgentRunId(runId: string): string | null {
  if (!runId.startsWith("pa-") || runId.length <= 36) return null;
  return runId.slice(3, -33);
}

/**
 * 把插件 agent 轮次的独立事件流（plugin-agent://event）按 run id 前缀
 * 路由回属主插件的总线话题。与聊天引擎流隔离：插件 run 不会进 chat
 * store，chat store 也不会收养这些事件。事件原样透传：Claude 原生生命周期的
 * turn_complete / tasks / activity 也在其中，不像 usage://updated 那样
 * 合成 usage（契约见 SDK ctx.agent 注释，消费方须忽略不认识的 kind）。
 */
export function bridgePluginAgentEvents(): void {
  if (agentBridged) return;
  agentBridged = true;
  void listen<EngineEventPayload[]>("plugin-agent://event", (e) => {
    for (const event of e.payload) {
      const pluginId = pluginIdFromAgentRunId(event.runId);
      if (pluginId) pluginBus.emit(`${AGENT_EVENT_TOPIC_PREFIX}${pluginId}`, event);
    }
  });
}

/**
 * Re-emit engine `usage` events onto the plugin bus. Bound once at plugin
 * bootstrap; plugins never touch the raw engine stream (they have no invoke).
 */
export function bridgeUsageEvents(): void {
  if (bridged) return;
  bridged = true;
  void bridgeHostChatFocusEvents().catch(() => {
    console.warn("[plugins] native host chat focus listener unavailable");
  });
  void listenEngineEvents((batch) => {
    for (const event of batch) forwardUsageEvent(event);
  });
}

/** A native response may finish while the run still owns background work.
 * Preserve its usage on the existing nonterminal channel; only actual run
 * settlement belongs on usage://done. A response the host UI interrupted (Stop
 * while background tasks run) is the same turn_complete with data.interrupted=true
 * and the run stays open, so it is forwarded like any other. Its usage may be
 * zero (the real CLI reports none for an interrupted response); a null usage
 * emits nothing. The flag itself is not part of the usage topic. */
export function forwardUsageEvent(event: EngineEventPayload): void {
  if (event.kind === "usage") pluginBus.emit(USAGE_UPDATED_TOPIC, event);
  else if (event.kind === "turn_complete") {
    const usage = (event.data as { usage?: unknown } | null)?.usage;
    if (usage != null) pluginBus.emit(USAGE_UPDATED_TOPIC, { ...event, kind: "usage", data: usage });
  } else if (event.kind === "done") pluginBus.emit(USAGE_DONE_TOPIC, event);
}

/** Emit an active-session switch onto the plugin bus (chat store calls this
 *  from activateTab/selectSession). Not part of bridgeUsageEvents: the source
 *  is the store, not the engine stream. Retained, so plugins that finish
 *  loading later still receive the latest value when they subscribe. */
export function emitSessionActivated(engine: string | null, sessionId: string | null,
  attention?: Pick<HostChatActivationEvent, "origin" | "reason" | "target">): void {
  const payload = { engine, sessionId, ...attention } satisfies HostChatActivationEvent;
  if (payload.target) {
    payload.target = Object.freeze({ ...payload.target });
    Object.freeze(payload);
  }
  pluginBus.emit(SESSION_ACTIVATED_TOPIC, payload);
}

/** Host-owned native focus signal. Desktop-only, no DOM focus heuristic or
 * polling. The loader binds usage/focus once per document; pagehide and the
 * returned disposer release the native listener, including async setup races. */
export async function bridgeHostChatFocusEvents(deps: {
  desktop?: boolean;
  current?: () => Promise<HostChatSession | null>;
  onFocusChanged?: (callback: (focused: boolean) => void) => Promise<Disposer>;
} = {}): Promise<Disposer> {
  if (!(deps.desktop ?? !isWeb)) return () => {};
  let disposed = false;
  let generation = 0;
  let unlisten: Disposer | undefined;
  const stop = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    window.removeEventListener("pagehide", stop);
    unlisten?.();
  };
  window.addEventListener("pagehide", stop, { once: true });
  const current = deps.current ?? (async () => {
    const { desktopChatFacade } = await import("./chat-bridge");
    return (await desktopChatFacade()).current();
  });
  const onFocusChanged = deps.onFocusChanged ?? (async (callback: (focused: boolean) => void) => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onFocusChanged(({ payload }) => callback(payload));
  });
  try {
    unlisten = await onFocusChanged((focused) => {
      const selectedGeneration = ++generation;
      if (!focused || disposed) return;
      void current().then((target) => {
        if (disposed || generation !== selectedGeneration || !target) return;
        emitSessionActivated(target.engine, target.nativeSessionId, { origin: "host", reason: "window-focus", target });
      }).catch(() => { console.warn("[plugins] native focus target unavailable"); });
    });
    if (disposed) unlisten();
    return stop;
  } catch (error) { stop(); throw error; }
}
