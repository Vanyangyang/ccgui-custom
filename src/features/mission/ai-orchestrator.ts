import i18n from "@/lib/i18n";
import { missionPromptRunner } from "./agent-runner";
import { layoutMissionFlow } from "./engine/layout";
import {
  buildMissionProposalPrompt,
  diffMissionDefinitions,
  parseMissionProposal,
} from "./engine/protocol";
import type { MissionValidationIssue } from "./engine/validator";
import { missionId } from "./ids";
import { resolveMissionExecution } from "./runtime";
import { useMissionStore } from "./store";
import type { MissionConversationMessage, MissionFlowDefinition } from "./types";

/**
 * AI 编排链路（M3）：
 * 用户对话 → 宿主 agent 读取（草稿 + 能力目录 + 要求）→ 结构化提案（JSON）
 * → schema + 业务校验 → 更新草稿（新版本）→ 画布渲染 + 变更摘要。
 *
 * 校验失败/无法解析时不做任何改动，也不假装执行；模型输出原文只作为
 * 对话内容保留（不渲染 HTML）。
 */

function message(
  role: MissionConversationMessage["role"],
  text: string,
  extra: Partial<MissionConversationMessage> = {},
): MissionConversationMessage {
  return { id: missionId("msg"), role, text, createdAt: Date.now(), ...extra };
}

/** 结构化 issue → 当前语言的说明行。 */
export function localizeMissionIssues(issues: MissionValidationIssue[]): string[] {
  return issues.map((issue) => {
    const key = `mission.issue${issue.code[0].toUpperCase()}${issue.code.slice(1)}`;
    return i18n.t(key, issue.params);
  });
}

function applyProposal(
  flowId: string,
  definition: MissionFlowDefinition,
  reply: string,
): void {
  const store = useMissionStore.getState();
  const flow = store.flows.find((item) => item.id === flowId);
  if (!flow) return;
  const next: MissionFlowDefinition = {
    ...definition,
    version: (flow.draft?.version ?? 0) + 1,
  };
  const laidOut = layoutMissionFlow(next);
  const lines = flow.draft
    ? diffMissionDefinitions(flow.draft, laidOut).map((line) =>
        i18n.t(`mission.${line.key}`, line.params),
      )
    : [
        i18n.t("mission.changeGenerated", {
          count: laidOut.nodes.length,
        }),
      ];
  store.updateDraft(flowId, laidOut);
  store.appendMessage(
    flowId,
    message("assistant", reply.trim() || i18n.t("mission.conversationHintApplied"), {
      change: { version: laidOut.version, lines },
    }),
  );
}

/** 发送一条编排消息；流式/解析/校验失败都如实写回对话。 */
export async function sendMissionMessage(flowId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useMissionStore.getState();
  const flow = store.flows.find((item) => item.id === flowId);
  if (!flow || store.generatingByFlow[flowId]) return;

  store.appendMessage(flowId, message("user", trimmed));

  const current = useMissionStore.getState().flows.find((item) => item.id === flowId);
  if (!current) return;
  // 优先流程固定的执行配置；失效时回退到当前会话/默认环境（生成不阻塞）。
  let resolution = resolveMissionExecution(current);
  if (resolution.invalidReason || !resolution.execution) {
    resolution = resolveMissionExecution(null);
  }
  const execution = resolution.execution;
  if (!execution) {
    store.appendMessage(flowId, message("assistant", i18n.t("mission.conversationHintNoEngine")));
    return;
  }
  const prompt = buildMissionProposalPrompt({
    flowName: current.name,
    flowGoal: current.goal,
    draft: current.draft,
    history: current.messages.map((row) => ({ role: row.role, text: row.text })),
    message: trimmed,
  });

  store.setGenerating(flowId, true);
  try {
    const session = missionPromptRunner()({
      engine: execution.engine,
      workspacePath: execution.workspacePath,
      prompt,
      model: execution.model,
      effort: execution.effort,
      providerId: execution.providerId,
      readOnly: false,
    });
    const { text: output } = await session.promise;
    const result = parseMissionProposal(output);
    if (result.ok && result.proposal) {
      if (result.proposal.definition) {
        applyProposal(flowId, result.proposal.definition, result.proposal.reply);
      } else {
        useMissionStore
          .getState()
          .appendMessage(
            flowId,
            message(
              "assistant",
              result.proposal.reply.trim() || i18n.t("mission.conversationHintUnknown"),
            ),
          );
      }
      return;
    }
    const issueLines = result.issues ? localizeMissionIssues(result.issues) : [];
    useMissionStore.getState().appendMessage(
      flowId,
      message("assistant", i18n.t("mission.conversationHintInvalid"), {
        error:
          issueLines.length > 0
            ? `${i18n.t("mission.conversationHintIssues")}\n${issueLines.join("\n")}`
            : undefined,
      }),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    useMissionStore
      .getState()
      .appendMessage(flowId, message("assistant", i18n.t("mission.conversationHintFailed", { detail })));
  } finally {
    useMissionStore.getState().setGenerating(flowId, false);
  }
}
