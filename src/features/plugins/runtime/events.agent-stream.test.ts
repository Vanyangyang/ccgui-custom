import { beforeEach, describe, expect, it, vi } from "vitest";

// bridgePluginAgentEvents 只订阅一次 plugin-agent://event；用可驱动的 listen 替身
// 取回宿主注册的处理函数，按真实形状（事件批 EngineEventPayload[]）喂入。
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@/lib/transport", () => ({
  isWeb: false,
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn(async () => () => {}) }));

import {
  AGENT_EVENT_TOPIC_PREFIX,
  bridgePluginAgentEvents,
  pluginBus,
  resetPluginBusForTests,
  USAGE_DONE_TOPIC,
  USAGE_UPDATED_TOPIC,
} from "./events";

const RUN = `pa-demo-${"a".repeat(32)}`;
const base = { runId: RUN, sessionId: "s", engine: "claude" };

describe("agent://<pluginId> stream contract (SDK ctx.agent)", () => {
  beforeEach(() => resetPluginBusForTests());

  it("passes Claude native lifecycle events through untouched, in order", () => {
    bridgePluginAgentEvents();
    const handler = handlers.get("plugin-agent://event");
    expect(handler).toBeTypeOf("function");

    const seen: unknown[] = [];
    pluginBus.on(`${AGENT_EVENT_TOPIC_PREFIX}demo`, (e) => seen.push(e));
    const hostUsage = vi.fn();
    pluginBus.on(USAGE_UPDATED_TOPIC, hostUsage);
    pluginBus.on(USAGE_DONE_TOPIC, hostUsage);

    const batch = [
      { ...base, seq: 1, kind: "activity", data: { state: "running" } },
      { ...base, seq: 2, kind: "tasks", data: { tasks: [{ id: "t1", kind: "local_bash", description: "tests", status: "running", background: true }] } },
      { ...base, seq: 3, kind: "turn_complete", ts: 10, genMs: 5, data: { usage: { output_tokens: 7 } } },
      { ...base, seq: 4, kind: "activity", data: { state: "waiting" } },
      { ...base, seq: 5, kind: "done", data: { usage: null } },
    ];
    handler!({ payload: batch });

    // 原样透传：per-response 用量只在 turn_complete.data.usage，终态 done 的
    // usage 为 null；插件 run 流不做 usage:// 合成，也不泄漏到宿主话题。
    expect(seen).toEqual(batch);
    seen.forEach((event, i) => expect(event).toBe(batch[i]));
    expect(hostUsage).not.toHaveBeenCalled();
  });

  it("keeps an interrupted turn_complete non-terminal and untouched (interrupted flag preserved)", () => {
    bridgePluginAgentEvents();
    const handler = handlers.get("plugin-agent://event")!;
    const seen: Array<{ kind: string; data: unknown }> = [];
    pluginBus.on(`${AGENT_EVENT_TOPIC_PREFIX}demo`, (e) => seen.push(e as { kind: string; data: unknown }));

    const batch = [
      { ...base, seq: 1, kind: "turn_complete", data: { usage: { output_tokens: 3 }, interrupted: true } },
      { ...base, seq: 2, kind: "activity", data: { state: "waiting" } },
      { ...base, seq: 3, kind: "done", data: { usage: null } },
    ];
    handler({ payload: batch });

    // 打断后的响应是普通 turn_complete（不是 error）；其后运行仍可继续到 waiting / done。
    expect(seen).toEqual(batch);
    expect(seen.map((e) => e.kind)).toEqual(["turn_complete", "activity", "done"]);
    expect(seen[0].data).toEqual({ usage: { output_tokens: 3 }, interrupted: true });
  });

  it("routes by run-id owner prefix and drops runs without a plugin prefix", () => {
    bridgePluginAgentEvents();
    const handler = handlers.get("plugin-agent://event")!;
    const mine = vi.fn();
    const other = vi.fn();
    pluginBus.on(`${AGENT_EVENT_TOPIC_PREFIX}demo`, mine);
    pluginBus.on(`${AGENT_EVENT_TOPIC_PREFIX}other`, other);

    handler({
      payload: [
        { ...base, seq: 1, kind: "tasks", data: { tasks: [] } },
        { ...base, runId: "chat-run", seq: 2, kind: "tasks", data: { tasks: [] } },
      ],
    });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
