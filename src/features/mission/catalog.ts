/**
 * 能力目录：AI 只能组合「已声明」的能力；已声明但未接入的能力会被校验
 * 标成「缺少能力，不可运行」，绝不伪装执行（方案 §4.3 / §8）。
 *
 * provider 含义：
 *  - "simulated"：已实现但只做本地模拟，不访问外部系统（内置示例流程使用；
 *    UI 必须明示「演示」）。
 *  - "native"：真实接入宿主能力（第一版还没有工具类原生能力）。
 *  - "unavailable"：目录中声明、尚未接入——可被流程引用，但校验直接判
 *    不可运行。
 */

export type MissionCapabilityKind = "input" | "tool";
export type MissionCapabilityProvider = "simulated" | "native" | "unavailable";

export interface MissionCapabilityParam {
  type: "string" | "number" | "boolean";
  required?: boolean;
  description: string;
}

export interface MissionCapability {
  id: string;
  kind: MissionCapabilityKind;
  title: string;
  description: string;
  provider: MissionCapabilityProvider;
  params: Record<string, MissionCapabilityParam>;
  /** 结果形状说明，供 AI 提示与校验提示使用。 */
  resultKind: "collection" | "record";
}

export const MISSION_CAPABILITIES: readonly MissionCapability[] = [
  {
    id: "demo.repo.pullRequests",
    kind: "input",
    title: "读取仓库打开中的 PR",
    description: "提供本次要处理的 PR 集合（演示数据，不访问 GitHub）",
    provider: "simulated",
    params: {
      count: { type: "number", required: true, description: "PR 数量（1–100）" },
      seed: { type: "number", description: "演示数据种子" },
    },
    resultKind: "collection",
  },
  {
    id: "demo.ci.check",
    kind: "tool",
    title: "CI / 依据核查",
    description: "对单项输入做确定性核查（演示：本地模拟，不访问 CI）",
    provider: "simulated",
    params: {},
    resultKind: "record",
  },
  {
    id: "demo.feedback.list",
    kind: "input",
    title: "读取待归类反馈",
    description: "提供本次要归类的客户反馈集合（演示数据）",
    provider: "simulated",
    params: {
      count: { type: "number", required: true, description: "反馈数量（1–100）" },
      seed: { type: "number", description: "演示数据种子" },
    },
    resultKind: "collection",
  },
  {
    id: "demo.classify.check",
    kind: "tool",
    title: "分类依据核查",
    description: "核对反馈归类依据（演示：本地模拟）",
    provider: "simulated",
    params: {},
    resultKind: "record",
  },
  {
    id: "demo.notes.list",
    kind: "input",
    title: "读取资料清单",
    description: "提供本次要整理的资料集合（演示数据）",
    provider: "simulated",
    params: {
      count: { type: "number", required: true, description: "资料数量（1–100）" },
      seed: { type: "number", description: "演示数据种子" },
    },
    resultKind: "collection",
  },
  {
    id: "demo.docs.verify",
    kind: "tool",
    title: "资料证据核查",
    description: "核对材料中的依据（演示：本地模拟）",
    provider: "simulated",
    params: {},
    resultKind: "record",
  },
  {
    id: "github.pr.comment",
    kind: "tool",
    title: "在 PR 上发表评论",
    description: "向 GitHub 写入评论（尚未接入）",
    provider: "unavailable",
    params: {
      body: { type: "string", required: true, description: "评论内容" },
    },
    resultKind: "record",
  },
  {
    id: "github.pr.merge",
    kind: "tool",
    title: "合并 PR",
    description: "合并代码（尚未接入；本工作台默认不执行外部写入）",
    provider: "unavailable",
    params: {},
    resultKind: "record",
  },
  {
    id: "im.sendMessage",
    kind: "tool",
    title: "发送消息到外部系统",
    description: "向外部 IM/工单系统发送消息（尚未接入）",
    provider: "unavailable",
    params: {
      target: { type: "string", required: true, description: "目标会话" },
      text: { type: "string", required: true, description: "消息内容" },
    },
    resultKind: "record",
  },
];

export function findCapability(id: string | undefined): MissionCapability | undefined {
  if (!id) return undefined;
  return MISSION_CAPABILITIES.find((capability) => capability.id === id);
}

/** 能力是否可执行：已实现（模拟或原生）都算；unavailable 不算。 */
export function isCapabilityRunnable(capability: MissionCapability | undefined): boolean {
  return capability !== undefined && capability.provider !== "unavailable";
}

/** AI 提示用：能力目录的紧凑文本描述。 */
export function capabilityCatalogPrompt(): string {
  return MISSION_CAPABILITIES.map((capability) => {
    const params = Object.entries(capability.params)
      .map(([name, param]) => `${name}:${param.type}${param.required ? "!" : ""}`)
      .join(",");
    const state =
      capability.provider === "unavailable"
        ? "不可用"
        : capability.provider === "simulated"
          ? "演示"
          : "已接入";
    return `- ${capability.id} (${capability.kind}, ${state}) ${capability.title}${params ? ` [${params}]` : ""}`;
  }).join("\n");
}
