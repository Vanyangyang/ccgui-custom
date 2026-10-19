import type { MissionFlowDefinition } from "../types";
import { layoutMissionFlow } from "../engine/layout";

/**
 * 内置演示流程：全仓 PR 审查与风险分流。
 *
 * 安全边界（方案 §2）：只形成审查意见，不合并 PR、不发表评论、不访问
 * 外部系统；输入与核查均为本地演示数据（catalog 中 provider=simulated）。
 */
export const PR_REVIEW_FLOW_ID = "flow-builtin-pr-review";

export function buildPrReviewDemoFlow(): MissionFlowDefinition {
  const definition: MissionFlowDefinition = {
    version: 1,
    name: "全仓 PR 审查与风险分流",
    goal:
      "审查这个项目所有打开的 PR，最多并发 5 个。每个 PR 检查变更、测试与权限风险；低风险归档审查意见，高风险找我确认。失败先重试，最后汇总。不要自动合并。",
    settings: {
      concurrency: 5,
      retries: 1,
      approval: "risk",
      verification: true,
    },
    nodes: [
      {
        id: "source",
        type: "input",
        title: "读取仓库打开中的 PR",
        description: "固定本次处理范围（演示数据，不访问 GitHub）",
        position: { x: 0, y: 0 },
        input: {
          capabilityId: "demo.repo.pullRequests",
          params: { count: 30, seed: 1 },
        },
      },
      {
        id: "review",
        type: "foreach",
        title: "逐项独立审查",
        description: "每个 PR 独立上下文，运行时展开为独立任务",
        position: { x: 0, y: 0 },
        foreach: {
          over: "source",
          concurrency: 5,
          body: {
            nodes: [
              {
                id: "analyze",
                type: "agent",
                title: "Agent 分析变更与风险",
                description: "逐项审查代码、测试与权限边界（演示：不调用真实模型）",
                position: { x: 0, y: 0 },
                agent: {
                  instruction:
                    "审查该项变更的代码、测试与权限风险；只输出审查意见，不修改任何文件。",
                  readOnly: true,
                  provider: "simulated",
                },
              },
              {
                id: "verify",
                type: "tool",
                title: "CI / 依据核查",
                description: "确定性核查，与 AI 判断分开（演示）",
                position: { x: 0, y: 0 },
                tool: { capabilityId: "demo.ci.check" },
              },
              {
                id: "route",
                type: "agent",
                title: "按风险分流",
                description: "高风险进入人工确认，低风险归档意见",
                position: { x: 0, y: 0 },
                agent: {
                  instruction: "判定该项风险等级：触及权限或安全边界为 high，否则为 low。",
                  readOnly: true,
                  provider: "simulated",
                },
              },
              {
                id: "review_human",
                type: "human",
                title: "等待业务决定",
                description: "不占并发槽，其他任务继续",
                position: { x: 0, y: 0 },
                human: { ask: "确认这份审查意见，或补充要求后重新处理。" },
              },
              {
                id: "archive",
                type: "output",
                title: "保存审查意见",
                description: "不进行外部写入",
                position: { x: 0, y: 0 },
                output: { artifact: "该项审查意见" },
              },
            ],
            edges: [
              { id: "e-analyze-verify", from: "analyze", to: "verify", condition: "verification=true" },
              { id: "e-analyze-route", from: "analyze", to: "route", condition: "verification=false" },
              { id: "e-verify-route", from: "verify", to: "route" },
              {
                id: "e-route-human",
                from: "route",
                to: "review_human",
                label: "高风险",
                condition: "risk=high or approval=all",
              },
              { id: "e-route-archive", from: "route", to: "archive", label: "低风险" },
            ],
          },
        },
      },
      {
        id: "summary",
        type: "output",
        title: "审查结果与例外清单",
        description: "所有分支终结后才生成汇总",
        position: { x: 0, y: 0 },
        output: { artifact: "审查结果与例外清单" },
      },
    ],
    edges: [
      { id: "e-source-review", from: "source", to: "review" },
      { id: "e-review-summary", from: "review", to: "summary" },
    ],
  };
  return layoutMissionFlow(definition);
}
