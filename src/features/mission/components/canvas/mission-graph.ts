import type { Edge, Node } from "@xyflow/react";
import {
  MISSION_BODY_NODE_HEIGHT,
  MISSION_BODY_NODE_WIDTH,
  MISSION_GROUP_HEADER,
  MISSION_GROUP_PADDING,
} from "../../engine/layout";
import type { MissionValidationIssue } from "../../engine/validator";
import type {
  MissionFlowDefinition,
  MissionFlowNode,
  MissionRun,
  MissionTaskInstance,
  MissionTaskStatus,
} from "../../types";

/**
 * 画布数据映射（纯函数，可单测）：
 * 定义视图 = AI 生成的节点/连线；运行视图 = 控制节点 + foreach 池里的
 * 每项任务卡。节点位置来自自动布局，人不能手动摆放。
 */

export interface MissionItemView {
  itemId: string;
  label: string;
  status: MissionTaskStatus;
  /** 当前/最近到达的子流程节点 id。 */
  stageNodeId: string | null;
  tasks: MissionTaskInstance[];
  approved: boolean;
}

export interface MissionDefinitionNodeData extends Record<string, unknown> {
  kind: "definition";
  node: MissionFlowNode;
  status: MissionTaskStatus | null;
  unavailableReason: string | null;
  simulated: boolean;
  selected: boolean;
  hasFeedback: boolean;
}

export interface MissionGroupNodeData extends Record<string, unknown> {
  kind: "group";
  node: MissionFlowNode;
  itemCount: number;
  runningCount: number;
  concurrency: number;
}

export interface MissionItemNodeData extends Record<string, unknown> {
  kind: "item";
  item: MissionItemView;
  selected: boolean;
  /** 子流程节点标题（按执行顺序），用于展示进度。 */
  stageTitles: string[];
  stageTitle: string | null;
}

export type MissionCanvasNodeData =
  | MissionDefinitionNodeData
  | MissionGroupNodeData
  | MissionItemNodeData;

export type MissionCanvasNode = Node<MissionCanvasNodeData>;

/** 单项状态优先级：失败 > 等待 > 执行 > 排队 > 排除 > 完成。 */
export function unitStatusOfTasks(tasks: MissionTaskInstance[]): MissionTaskStatus {
  const has = (status: MissionTaskStatus): boolean => tasks.some((task) => task.status === status);
  if (has("failed")) return "failed";
  if (has("waiting_human")) return "waiting_human";
  if (has("running")) return "running";
  if (has("queued")) return "queued";
  if (has("excluded")) return "excluded";
  return "succeeded";
}

/** 运行中某个定义节点的聚合状态（含 foreach 的子任务）。 */
export function runStatusForNode(
  run: MissionRun,
  node: MissionFlowNode,
): MissionTaskStatus | null {
  const tasks = run.tasks.filter((task) => task.nodeId === node.id);
  if (node.type === "foreach") {
    const children = run.tasks.filter((task) =>
      tasks.some((parent) => parent.id === task.parentTaskId),
    );
    if (children.length === 0) {
      return tasks.length > 0 ? unitStatusOfTasks(tasks) : null;
    }
    return unitStatusOfTasks(children);
  }
  if (tasks.length === 0) return null;
  return unitStatusOfTasks(tasks);
}

/** 按 foreach 顶层任务分组出每项视图。 */
export function deriveRunItems(run: MissionRun, foreachNodeId: string): MissionItemView[] {
  const parents = run.tasks.filter((task) => task.nodeId === foreachNodeId);
  const items: MissionItemView[] = [];
  for (const parent of parents) {
    const children = run.tasks.filter((task) => task.parentTaskId === parent.id);
    const itemIds = [...new Set(children.map((child) => child.itemId))];
    for (const itemId of itemIds) {
      if (!itemId) continue;
      const itemTasks = children.filter((child) => child.itemId === itemId);
      items.push({
        itemId,
        label: itemTasks[0]?.itemLabel ?? itemId,
        status: unitStatusOfTasks(itemTasks),
        stageNodeId: currentStageNodeId(itemTasks),
        tasks: itemTasks,
        approved: itemTasks.some((task) => task.approved),
      });
    }
  }
  return items;
}

function currentStageNodeId(tasks: MissionTaskInstance[]): string | null {
  const running = tasks.find((task) => task.status === "running");
  if (running) return running.nodeId;
  const waiting = tasks.find((task) => task.status === "waiting_human");
  if (waiting) return waiting.nodeId;
  const failed = tasks.find((task) => task.status === "failed");
  if (failed) return failed.nodeId;
  const withOutput = tasks.filter((task) => task.output !== undefined);
  return withOutput.at(-1)?.nodeId ?? null;
}

/** 某个定义节点在 foreach 子流程里的标题（用于任务卡 stage 文案）。 */
export function bodyNodeTitle(
  definition: MissionFlowDefinition,
  foreachNodeId: string,
  nodeId: string | null,
): string | null {
  if (!nodeId) return null;
  const parent = definition.nodes.find((node) => node.id === foreachNodeId);
  return parent?.foreach?.body.nodes.find((child) => child.id === nodeId)?.title ?? null;
}

function groupSize(children: MissionFlowNode[], cardWidth: number, cardHeight: number): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const child of children) {
    width = Math.max(width, child.position.x + cardWidth);
    height = Math.max(height, child.position.y + cardHeight);
  }
  return {
    width: Math.round(width + MISSION_GROUP_PADDING),
    height: Math.round(height + MISSION_GROUP_PADDING),
  };
}

export interface MissionCanvasInput {
  definition: MissionFlowDefinition;
  run: MissionRun | null;
  mode: "definition" | "run";
  selectedNodeKey: string | null;
  issues: MissionValidationIssue[];
}

const unavailableCodes = new Set(["unavailableTool", "unknownTool", "readOnlyUnsupported"]);

function unavailableReasonFor(
  node: MissionFlowNode,
  issues: MissionValidationIssue[],
): string | null {
  const found = issues.find(
    (issue) => issue.nodeId === node.id && unavailableCodes.has(issue.code),
  );
  return found ? found.code : null;
}

function isSimulatedNode(node: MissionFlowNode): boolean {
  if (node.type === "agent") return node.agent?.provider === "simulated";
  const capabilityId = node.input?.capabilityId ?? node.tool?.capabilityId;
  if (!capabilityId) return false;
  return capabilityId.startsWith("demo.");
}

export function buildMissionCanvas(input: MissionCanvasInput): {
  nodes: MissionCanvasNode[];
  edges: Edge[];
} {
  const { definition, run, mode, selectedNodeKey, issues } = input;
  const selectedTaskId = selectedNodeKey?.startsWith("task:")
    ? selectedNodeKey.slice("task:".length)
    : null;
  const nodes: MissionCanvasNode[] = [];
  const edges: Edge[] = [];
  const renderedTop = new Set<string>();

  for (const node of definition.nodes) {
    renderedTop.add(node.id);
  }

  for (const node of definition.nodes) {
    const isRun = mode === "run" && run !== null;
    const status = isRun ? runStatusForNode(run, node) : null;
    if (node.type === "foreach" && node.foreach) {
      const foreach = node.foreach;
      if (isRun) {
        const items = deriveRunItems(run, node.id);
        const runningCount = items.filter((item) => item.status === "running").length;
        const columns = Math.min(Math.max(items.length, 1), 6);
        const cardWidth = 136;
        const cardHeight = 82;
        const gap = 14;
        const width = columns * (cardWidth + gap) - gap + MISSION_GROUP_PADDING * 2;
        const rows = Math.ceil(items.length / columns);
        const height = Math.max(rows, 1) * (cardHeight + gap) - gap + MISSION_GROUP_HEADER + MISSION_GROUP_PADDING;
        nodes.push({
          id: `node:${node.id}`,
          type: "missionGroup",
          position: node.position,
          draggable: false,
          selectable: true,
          style: { width, height },
          data: {
            kind: "group",
            node,
            itemCount: items.length,
            runningCount,
            concurrency: node.foreach.concurrency,
          },
        });
        items.forEach((item, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          nodes.push({
            id: `item:${item.itemId}`,
            type: "missionItem",
            parentId: `node:${node.id}`,
            extent: "parent",
            position: {
              x: MISSION_GROUP_PADDING + column * (cardWidth + gap),
              y: MISSION_GROUP_HEADER + row * (cardHeight + gap),
            },
            draggable: false,
            data: {
              kind: "item",
              item,
              selected:
                selectedTaskId !== null &&
                item.tasks.some((task) => task.id === selectedTaskId),
              stageTitles: foreach.body.nodes.map((child) => child.title),
              stageTitle: bodyNodeTitle(definition, node.id, item.stageNodeId),
            },
          });
        });
      } else {
        const size = groupSize(
          foreach.body.nodes,
          MISSION_BODY_NODE_WIDTH,
          MISSION_BODY_NODE_HEIGHT,
        );
        nodes.push({
          id: `node:${node.id}`,
          type: "missionGroup",
          position: node.position,
          draggable: false,
          selectable: true,
          style: size,
          data: {
            kind: "group",
            node,
            itemCount: foreach.body.nodes.length,
            runningCount: 0,
            concurrency: foreach.concurrency,
          },
        });
        for (const child of foreach.body.nodes) {
          nodes.push({
            id: `body:${node.id}:${child.id}`,
            type: child.type,
            parentId: `node:${node.id}`,
            extent: "parent",
            position: child.position,
            draggable: false,
            selectable: true,
            data: {
              kind: "definition",
              node: child,
              status: null,
              unavailableReason: unavailableReasonFor(child, issues),
              simulated: isSimulatedNode(child),
              selected: selectedNodeKey === `body:${node.id}:${child.id}`,
              hasFeedback: false,
            },
          });
        }
        for (const edge of foreach.body.edges) {
          edges.push({
            id: `body-edge:${node.id}:${edge.id}`,
            source: `body:${node.id}:${edge.from}`,
            target: `body:${node.id}:${edge.to}`,
            label: edge.label,
            animated: edge.kind === "feedback",
            style: edge.kind === "recovery" || edge.kind === "feedback" ? { strokeDasharray: "5 5" } : undefined,
          });
        }
      }
      continue;
    }

    const tasks = run?.tasks.filter((task) => task.nodeId === node.id) ?? [];
    const hasFeedback = tasks.some((task) => task.feedback.length > 0);
    nodes.push({
      id: `node:${node.id}`,
      type: node.type,
      position: node.position,
      draggable: false,
      selectable: true,
      data: {
        kind: "definition",
        node,
        status,
        unavailableReason: unavailableReasonFor(node, issues),
        simulated: isSimulatedNode(node),
        selected: selectedNodeKey === `node:${node.id}`,
        hasFeedback,
      },
    });
  }

  for (const edge of definition.edges) {
    if (!renderedTop.has(edge.from) || !renderedTop.has(edge.to)) continue;
    edges.push({
      id: `edge:${edge.id}`,
      source: `node:${edge.from}`,
      target: `node:${edge.to}`,
      label: edge.label,
      animated: edge.kind === "feedback",
      style: edge.kind === "recovery" || edge.kind === "feedback" ? { strokeDasharray: "5 5" } : undefined,
    });
  }

  return { nodes, edges };
}
