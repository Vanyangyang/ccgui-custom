import { runMissionAgentPrompt, type MissionAgentRunOptions } from "./agent-bridge";
import { buildAgentNodePrompt, parseAgentKeyValues, type MissionAgentRunner } from "./engine/native";

/**
 * agent 轮次运行器注入点：默认接原生桥；测试注入假 runner，从而在
 * 不启动真实引擎的情况下验证编排协议与执行链路。
 */

export type MissionPromptRunner = (
  options: Omit<MissionAgentRunOptions, "onEvent"> & { signal?: AbortSignal },
) => { promise: Promise<{ text: string }>; interrupt: () => void };

const defaultRunner: MissionPromptRunner = (options) => runMissionAgentPrompt(options);
let promptRunner: MissionPromptRunner = defaultRunner;

export function missionPromptRunner(): MissionPromptRunner {
  return promptRunner;
}

/** 仅测试使用：替换 agent 轮次运行器；空参恢复默认原生桥。 */
export function setMissionPromptRunnerForTest(runner?: MissionPromptRunner): void {
  promptRunner = runner ?? defaultRunner;
}

/** 原生 agent 节点的执行器：提示词 → 引擎轮次 → 结构化 key=value 输出。 */
export const missionAgentNodeRunner: MissionAgentRunner = async ({
  node,
  context,
  execution,
  signal,
}) => {
  const prompt = buildAgentNodePrompt(node, context);
  const session = promptRunner({
    engine: execution.engine,
    workspacePath: execution.workspacePath,
    prompt,
    model: execution.model,
    effort: execution.effort,
    providerId: execution.providerId,
    readOnly: node.agent?.readOnly === true,
    signal,
  });
  const { text } = await session.promise;
  return parseAgentKeyValues(text);
};
