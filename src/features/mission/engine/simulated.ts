import { findCapability } from "../catalog";
import type { MissionExecutor, MissionTaskContext } from "./scheduler";
import type { MissionFlowNode } from "../types";

/**
 * 内置演示执行器（M1）。
 *
 * 重要边界：这里所有的输入、工具与 agent 都是本地确定性模拟，不访问
 * 网络、不调用模型、不读写外部系统；UI 必须把它标成「演示」。真实执行
 * （M3）走宿主 agent 管线，与这里互不混淆。
 *
 * 失败也是确定性的：第 12 项核查在第 1 次尝试失败（自动重试后通过），
 * 第 24 项两次失败后升级为人工恢复——用于完整跑通恢复链路。
 */

const DEMO_TITLES = [
  "消息输出完整性",
  "工具状态回收",
  "历史会话恢复",
  "代码块复制",
  "插件类型同步",
  "窗口位置恢复",
  "快捷键提示",
  "Markdown 表格",
  "权限作用域",
  "命令执行边界",
  "外部工具授权",
  "执行器重连",
  "流式渲染",
  "终端性能",
  "文件操作权限",
  "测试隔离",
  "结果缓存",
  "主题切换",
  "错误日志脱敏",
  "取消与恢复",
  "多窗口同步",
  "工作区检索",
  "路径边界",
  "设置迁移",
  "输入法兼容",
  "资源清理",
  "文件预览",
  "事件顺序",
  "语言切换",
  "空状态提示",
];

export interface SimulatedExecutorOptions {
  /** 每个节点的模拟耗时；测试传 0。 */
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemIndex(context: MissionTaskContext): number {
  const value = context.item?.value;
  if (value && typeof value === "object" && typeof (value as { index?: unknown }).index === "number") {
    return (value as { index: number }).index;
  }
  const id = context.item?.id ?? "";
  const match = id.match(/(\d+)$/);
  return match ? Number(match[1]) - 1 : 0;
}

interface DemoItem {
  id: string;
  label: string;
  title: string;
  risk: "high" | "low";
  index: number;
}

function buildItems(
  prefix: string,
  count: number,
  titles: readonly string[],
  riskEvery: number,
): DemoItem[] {
  const safeCount = Math.max(1, Math.min(100, Math.floor(count)));
  return Array.from({ length: safeCount }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    label: prefix === "PR" ? `PR #${221 + index}` : `${prefix} ${index + 1}`,
    title: titles[index % titles.length],
    risk: index % riskEvery === 0 ? "high" : "low",
    index,
  }));
}

function numericParam(node: MissionFlowNode, name: string, fallback: number): number {
  const raw = node.input?.params?.[name];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export function createSimulatedExecutor(options: SimulatedExecutorOptions = {}): MissionExecutor {
  const delayMs = options.delayMs ?? 0;

  return {
    async runInput(node): Promise<unknown> {
      await sleep(delayMs);
      const capability = node.input?.capabilityId;
      switch (capability) {
        case "demo.repo.pullRequests":
          return buildItems("PR", numericParam(node, "count", 30), DEMO_TITLES, 7);
        case "demo.feedback.list":
          return buildItems("反馈", numericParam(node, "count", 12), DEMO_TITLES.slice(3), 5);
        case "demo.notes.list":
          return buildItems("资料", numericParam(node, "count", 3), DEMO_TITLES.slice(10), 3);
        default:
          throw new Error(`simulated input is not implemented: ${String(capability)}`);
      }
    },

    async runTool(node, context): Promise<unknown> {
      await sleep(delayMs);
      const capability = node.tool?.capabilityId;
      const known = findCapability(capability);
      if (!known) throw new Error(`unknown capability: ${String(capability)}`);
      if (known.provider !== "simulated") {
        throw new Error(`capability is not wired for real execution: ${String(capability)}`);
      }
      const item = context.item?.label ?? "run";
      if (capability === "demo.ci.check") {
        const index = itemIndex(context);
        const attempt = context.task.attempt;
        if ((index === 11 && attempt === 1) || (index === 23 && attempt <= 2)) {
          throw new Error(`demo check failed on attempt ${attempt}`);
        }
        return { ok: true, item, note: "演示核查已完成", checkedAt: context.run.startedAt };
      }
      return { ok: true, item, note: "演示核查已完成" };
    },

    async runAgent(node, context): Promise<unknown> {
      await sleep(delayMs);
      const item = context.item?.value as DemoItem | undefined;
      switch (node.id) {
        case "analyze":
          return {
            simulated: true,
            item: context.item?.label,
            findings: [
              "变更范围与测试覆盖已记录（演示）",
              "权限与安全边界已逐条核对（演示）",
            ],
            risk: item?.risk ?? "low",
          };
        case "route":
          return {
            simulated: true,
            item: context.item?.label,
            risk: item?.risk ?? "high",
            reason:
              item?.risk === "high"
                ? "演示判定：触及权限或安全边界"
                : "演示判定：常规变更，可归档意见",
          };
        default:
          return {
            simulated: true,
            item: context.item?.label,
            note: "模拟完成；未调用真实模型",
            instruction: node.agent?.instruction ?? "",
          };
      }
    },
  };
}
