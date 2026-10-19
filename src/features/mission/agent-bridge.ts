import { listenMissionAgentEvents, type EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { missionId } from "./ids";

/**
 * 任务工作台 ↔ 原生 agent 管线的桥（M3）。
 *
 * 与聊天/插件共用同一条引擎进程管线，但事件走独立的
 * `mission-agent://event` 流；这里按 run id 路由回调用方。
 *
 * 只读节点通过 `allowed_tools` 白名单交给原生层真正兑现；引擎不支持时
 * `mission_agent_start` 直接拒绝，由调用方如实展示失败。
 */

/** 只读节点允许的工具集合（claude 工具名）。写工具由原生层显式拒绝。 */
export const MISSION_READ_ONLY_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

type AgentEventListener = (event: EngineEventPayload) => void;

const listeners = new Map<string, AgentEventListener>();
let bridged = false;

function ensureBridged(): void {
  if (bridged) return;
  bridged = true;
  void listenMissionAgentEvents((events) => {
    for (const event of events) {
      const listener = listeners.get(event.runId);
      if (!listener) continue;
      listener(event);
      if (event.kind === "done") listeners.delete(event.runId);
    }
  });
}

export interface MissionAgentRunOptions {
  engine: string;
  workspacePath: string;
  sessionId?: string | null;
  prompt: string;
  model?: string | null;
  /** 思考档位；null/undefined = 引擎默认。 */
  effort?: string | null;
  providerId?: string | null;
  /** 该节点是否声明只读（逐节点工具白名单）。 */
  readOnly?: boolean;
  onEvent: AgentEventListener;
}

export interface MissionAgentRunHandle {
  runId: string;
  sessionId: string | null;
  /** 取消监听并中断该轮次（用于节点取消/运行取消）。 */
  interrupt(): void;
}

/** 启动一个 agent 轮次；先注册监听再 invoke，避免错过首批事件。 */
export async function startMissionAgentRun(
  options: MissionAgentRunOptions,
): Promise<MissionAgentRunHandle> {
  ensureBridged();
  const runId = `mission-${missionId("agent")}`;
  listeners.set(runId, options.onEvent);
  try {
    const result = await ipc.missionAgentStart({
      runId,
      engine: options.engine,
      workspacePath: options.workspacePath,
      sessionId: options.sessionId ?? null,
      prompt: options.prompt,
      model: options.model ?? null,
      effort: options.effort ?? null,
      providerId: options.providerId ?? null,
      allowedTools: options.readOnly ? [...MISSION_READ_ONLY_TOOLS] : null,
    });
    return {
      runId: result.runId,
      sessionId: result.sessionId,
      interrupt: () => {
        listeners.delete(result.runId);
        void ipc.missionAgentInterrupt(result.runId).catch(() => {});
      },
    };
  } catch (error) {
    listeners.delete(runId);
    throw error;
  }
}

export type MissionAgentEventListener = AgentEventListener;

/**
 * 收集一次 agent 轮次的文本输出直到 done/error。
 * 只累积原文，不做任何字符动画/截断；解析由调用方在结束时进行。
 */
export function runMissionAgentPrompt(
  options: Omit<MissionAgentRunOptions, "onEvent"> & { signal?: AbortSignal },
): { promise: Promise<{ text: string }>; interrupt: () => void } {
  let handle: MissionAgentRunHandle | null = null;
  let text = "";
  let messageText = "";
  let settled = false;
  let resolveFn: (value: { text: string }) => void;
  let rejectFn: (error: Error) => void;

  const promise = new Promise<{ text: string }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const settle = (): void => {
    if (settled) return;
    settled = true;
    resolveFn({ text: text.length > 0 ? text : messageText });
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectFn(error instanceof Error ? error : new Error(String(error)));
  };

  const onAbort = (): void => {
    handle?.interrupt();
    fail(new Error("agent run cancelled"));
  };
  if (options.signal) {
    if (options.signal.aborted) {
      fail(new Error("agent run cancelled"));
      return { promise, interrupt: () => {} };
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  void startMissionAgentRun({
    ...options,
    onEvent: (event) => {
      switch (event.kind) {
        case "delta":
          text += typeof event.data === "string" ? event.data : "";
          break;
        case "message": {
          const data = event.data as { role?: string; text?: string } | null;
          if (data?.role === "assistant" && typeof data.text === "string") {
            messageText = data.text;
          }
          break;
        }
        case "error": {
          const data = event.data as { message?: string } | string | null;
          const message = typeof data === "string" ? data : (data?.message ?? "agent run failed");
          fail(new Error(message));
          break;
        }
        case "done":
          settle();
          break;
      }
    },
  })
    .then((created) => {
      handle = created;
      if (settled || options.signal?.aborted) created.interrupt();
    })
    .catch(fail);

  return {
    promise: promise.finally(() => {
      options.signal?.removeEventListener("abort", onAbort);
    }),
    interrupt: () => {
      handle?.interrupt();
    },
  };
}
