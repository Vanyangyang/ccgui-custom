import { findCapability } from "../catalog";
import type { MissionFlowNode, MissionRun, MissionRunExecution } from "../types";
import type { MissionExecutor, MissionTaskContext } from "./scheduler";

/**
 * 原生执行器（M3）：把 agent 节点接到宿主 agent 管线，工具节点按能力
 * provider 分流（simulated 用演示执行器；原生能力未接入时如实报错）。
 *
 * 引擎保持纯 TS：真实的 agent 调用、超时、取消都由注入的 runner 完成。
 */

export interface MissionAgentInvocation {
  node: MissionFlowNode;
  context: MissionTaskContext;
  execution: MissionRunExecution;
  /** 任务/运行被取消时触发；runner 应中断对应的原生进程。 */
  signal: AbortSignal;
}

export type MissionAgentRunner = (invocation: MissionAgentInvocation) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** agent 节点的提示词：节点目标 + 本次输入 + 上游结果 + 补充要求。 */
export function buildAgentNodePrompt(node: MissionFlowNode, context: MissionTaskContext): string {
  const sections: string[] = [
    "你是任务工作台中的一个 agent 节点，只负责这一步，不做流程编排。",
    `节点任务：${node.agent?.instruction ?? node.title}`,
  ];
  if (context.item) {
    sections.push(`输入项：${context.item.label}`);
    if (context.item.value !== undefined) {
      sections.push(`输入数据：${JSON.stringify(context.item.value)}`);
    }
  }
  const upstream = Object.entries(context.upstream);
  if (upstream.length > 0) {
    sections.push(
      `上游结果：\n${upstream
        .map(([nodeId, value]) => `- ${nodeId}: ${JSON.stringify(value)}`)
        .join("\n")}`,
    );
  }
  if (context.task.feedback.length > 0) {
    sections.push(`用户补充要求（必须满足，然后重新给出结果）：\n${context.task.feedback.join("\n")}`);
  }
  sections.push(
    [
      "输出要求：",
      "- 直接给出本步骤的结果，简洁、可被后续步骤使用；不要复述这些规则。",
      '- 如果需要给后续条件判断提供字段，请用独立的 key=value 行输出（例如 risk=high），不要只写在句子里。',
      node.agent?.readOnly
        ? "- 只读约束：只允许查看资料，不要修改文件、不要执行命令、不要外部写入。"
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return sections.join("\n\n");
}

/**
 * 把 agent 的自由文本解析成结构化输出：key=value 行成为字段，其余保留在
 * text 字段。条件连线据此判断分支（不猜测语义）。
 */
export function parseAgentKeyValues(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = { text: text.trim() };
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    result[match[1]] = match[2];
  }
  return result;
}

export interface MissionRunExecutorOptions {
  /** 演示能力（输入/工具/模拟 agent）的执行器。 */
  simulated: MissionExecutor;
  /** 运行绑定的引擎上下文；没有则原生 agent 节点无法执行。 */
  executionForRun: (run: MissionRun) => MissionRunExecution | null;
  /** 原生 agent runner；缺省时原生 agent 节点直接失败。 */
  agentRunner?: MissionAgentRunner;
  timeoutMs?: number;
}

export function createMissionRunExecutor(options: MissionRunExecutorOptions): MissionExecutor {
  const controllers = new Map<string, AbortController>();

  return {
    runInput(node, context) {
      const capability = findCapability(node.input?.capabilityId);
      if (capability?.provider === "simulated") {
        return options.simulated.runInput(node, context);
      }
      throw new Error(`input capability is not wired: ${String(node.input?.capabilityId)}`);
    },

    runTool(node, context) {
      const capability = findCapability(node.tool?.capabilityId);
      if (capability?.provider === "simulated") {
        return options.simulated.runTool(node, context);
      }
      throw new Error(
        `capability cannot execute: ${capability?.id ?? String(node.tool?.capabilityId)}`,
      );
    },

    async runAgent(node, context) {
      if (node.agent?.provider === "simulated") {
        return options.simulated.runAgent(node, context);
      }
      if (!options.agentRunner) {
        throw new Error("no agent runner is configured for native agent nodes");
      }
      const execution = options.executionForRun(context.run);
      if (!execution) {
        throw new Error("run has no execution context (engine/workspace)");
      }
      const controller = new AbortController();
      controllers.set(context.task.id, controller);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          options.agentRunner({
            node,
            context,
            execution,
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`agent node timed out after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controllers.delete(context.task.id);
      }
    },

    cancelTask(taskId) {
      controllers.get(taskId)?.abort();
      controllers.delete(taskId);
    },
  };
}
