import { findCapability, isCapabilityRunnable } from "../catalog";
import type {
  MissionFlowDefinition,
  MissionFlowEdge,
  MissionFlowNode,
  MissionNodeType,
} from "../types";
import { isValidCondition } from "./conditions";

/**
 * 流程校验：schema 级（必需字段/类型/节点类型）+ 业务级（能力是否存在、
 * 上下游是否匹配、是否有环/悬空、并发与重试范围）。
 *
 * 返回结构化 issue（code + params），文案由 UI 侧经 i18n 渲染，引擎不
 * 依赖界面语言。`severity === "error"` 表示不可运行。
 */

export interface MissionValidationIssue {
  code: string;
  /**
   * error       = 结构/引用错误：提案与运行都不通过；
   * unavailable = 能力缺口：草稿可以保存并在画布上标注，但运行被阻止；
   * warning     = 提示（不阻塞）。
   */
  severity: "error" | "unavailable" | "warning";
  nodeId?: string;
  params: Record<string, string | number>;
}

const NODE_TYPES: readonly MissionNodeType[] = [
  "input",
  "tool",
  "agent",
  "foreach",
  "human",
  "output",
];

function issue(
  code: string,
  severity: MissionValidationIssue["severity"],
  params: Record<string, string | number> = {},
  nodeId?: string,
): MissionValidationIssue {
  return { code, severity, nodeId, params };
}

/** 计算从一组边出发、每个节点的祖先集合。 */
function ancestorsOf(
  nodes: MissionFlowNode[],
  edges: MissionFlowEdge[],
): Map<string, Set<string>> {
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) incoming.get(edge.to)?.push(edge.from);
  const result = new Map<string, Set<string>>();
  for (const node of nodes) {
    const seen = new Set<string>();
    const queue = [...(incoming.get(node.id) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(incoming.get(next) ?? []));
    }
    result.set(node.id, seen);
  }
  return result;
}

/** 找出有向图中的环（返回环上节点；无环返回空）。 */
function findCycles(nodes: MissionFlowNode[], edges: MissionFlowEdge[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((node) => [node.id, WHITE]));
  const stack: string[] = [];
  const cycle = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const state = color.get(next) ?? BLACK;
      if (state === GRAY) {
        // 环：从栈中 next 之后的部分都是环上节点。
        const from = stack.indexOf(next);
        for (const nodeId of stack.slice(from)) cycle.add(nodeId);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const node of nodes) {
    if ((color.get(node.id) ?? BLACK) === WHITE) visit(node.id);
  }
  return [...cycle];
}

/** 每个节点是否能到达某个终结节点（output，或本层没有出边的节点）。 */
function reachableToTerminal(
  nodes: MissionFlowNode[],
  edges: MissionFlowEdge[],
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  const terminals = new Set(
    nodes.filter((node) => node.type === "output" || (outgoing.get(node.id)?.length ?? 0) === 0).map((node) => node.id),
  );
  const canReach = new Set(terminals);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (canReach.has(node.id)) continue;
      if ((outgoing.get(node.id) ?? []).some((next) => canReach.has(next))) {
        canReach.add(node.id);
        changed = true;
      }
    }
  }
  return canReach;
}

function validateEdges(
  nodes: MissionFlowNode[],
  edges: MissionFlowEdge[],
  issues: MissionValidationIssue[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      issues.push(issue("duplicateEdge", "error", { id: edge.id }));
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push(
        issue(
          "unknownEdgeNode",
          "error",
          { edge: edge.id, node: !nodeIds.has(edge.from) ? edge.from : edge.to },
        ),
      );
      continue;
    }
    if (edge.from === edge.to) {
      issues.push(issue("selfLoop", "error", { node: edge.from }));
    }
    if (!isValidCondition(edge.condition)) {
      issues.push(
        issue(
          "invalidCondition",
          "error",
          { edge: edge.id, condition: edge.condition ?? "" },
          edge.from,
        ),
      );
    }
  }
  for (const nodeId of findCycles(nodes, edges)) {
    issues.push(issue("cycle", "error", { nodes: nodeId }, nodeId));
  }
}

function validateNodeConfig(
  node: MissionFlowNode,
  issues: MissionValidationIssue[],
): void {
  switch (node.type) {
    case "input": {
      if (!node.input?.capabilityId) {
        issues.push(issue("missingConfig", "error", { node: node.title || node.id }, node.id));
        break;
      }
      const capability = findCapability(node.input.capabilityId);
      if (!capability) {
        issues.push(
          issue("unknownTool", "unavailable", { node: node.title, capability: node.input.capabilityId }, node.id),
        );
      } else if (!isCapabilityRunnable(capability)) {
        issues.push(
          issue("unavailableTool", "unavailable", { node: node.title, capability: node.input.capabilityId }, node.id),
        );
      }
      break;
    }
    case "tool": {
      if (!node.tool?.capabilityId) {
        issues.push(issue("missingTool", "error", { node: node.title || node.id }, node.id));
        break;
      }
      const capability = findCapability(node.tool.capabilityId);
      if (!capability) {
        issues.push(
          issue("unknownTool", "unavailable", { node: node.title, capability: node.tool.capabilityId }, node.id),
        );
      } else if (!isCapabilityRunnable(capability)) {
        issues.push(
          issue("unavailableTool", "unavailable", { node: node.title, capability: node.tool.capabilityId }, node.id),
        );
      }
      break;
    }
    case "agent": {
      if (!node.agent?.instruction?.trim()) {
        issues.push(issue("missingConfig", "error", { node: node.title || node.id }, node.id));
      }
      break;
    }
    case "human": {
      if (!node.human?.ask?.trim()) {
        issues.push(issue("missingConfig", "error", { node: node.title || node.id }, node.id));
      }
      break;
    }
    case "output": {
      if (!node.output?.artifact?.trim()) {
        issues.push(issue("missingConfig", "error", { node: node.title || node.id }, node.id));
      }
      break;
    }
    case "foreach": {
      if (!node.foreach?.over) {
        issues.push(issue("foreachMissingOver", "error", { node: node.title || node.id }, node.id));
        break;
      }
      if (!Number.isFinite(node.foreach.concurrency) || node.foreach.concurrency < 1 || node.foreach.concurrency > 10) {
        issues.push(issue("foreachConcurrency", "error", { node: node.title || node.id }, node.id));
      }
      if (!node.foreach.body || node.foreach.body.nodes.length === 0) {
        issues.push(issue("foreachEmptyBody", "error", { node: node.title || node.id }, node.id));
      }
      break;
    }
    default:
      issues.push(
        issue("unknownNodeType", "error", { id: node.id, type: String(node.type) }, node.id),
      );
  }
}

/**
 * 校验整份流程定义。foreach 子流程单独校验（ID 作用域独立）。
 */
export function validateMissionFlow(flow: MissionFlowDefinition): MissionValidationIssue[] {
  const issues: MissionValidationIssue[] = [];

  if (!Number.isFinite(flow.settings.concurrency) || flow.settings.concurrency < 1 || flow.settings.concurrency > 10) {
    issues.push(issue("concurrencyRange", "error"));
  }
  if (!Number.isFinite(flow.settings.retries) || flow.settings.retries < 0 || flow.settings.retries > 3) {
    issues.push(issue("retriesRange", "error"));
  }
  if (flow.nodes.length === 0) {
    issues.push(issue("emptyFlow", "error"));
    return issues;
  }

  const nodeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (nodeIds.has(node.id)) issues.push(issue("duplicateNode", "error", { id: node.id }));
    nodeIds.add(node.id);
    if (!NODE_TYPES.includes(node.type)) {
      issues.push(issue("unknownNodeType", "error", { id: node.id, type: String(node.type) }, node.id));
      continue;
    }
    validateNodeConfig(node, issues);
  }
  validateEdges(flow.nodes, flow.edges, issues);

  // 除 input 外，顶层节点必须有入边。
  const incoming = new Map<string, number>();
  for (const edge of flow.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  for (const node of flow.nodes) {
    if (node.type !== "input" && (incoming.get(node.id) ?? 0) === 0) {
      issues.push(issue("missingUpstream", "error", { node: node.title || node.id }, node.id));
    }
  }

  if (!flow.nodes.some((node) => node.type === "output")) {
    issues.push(issue("missingOutput", "error"));
  }

  // 顶层：引用了不可达终结路径的节点给 warning（不阻塞运行）。
  const reachable = reachableToTerminal(flow.nodes, flow.edges);
  for (const node of flow.nodes) {
    if (!reachable.has(node.id)) {
      issues.push(issue("danglingBranch", "warning", { node: node.title || node.id }, node.id));
    }
  }

  // foreach 子流程。
  for (const node of flow.nodes) {
    if (node.type !== "foreach" || !node.foreach) continue;
    const body = node.foreach.body;
    if (!body || body.nodes.length === 0) continue;
    const bodyIds = new Set<string>();
    for (const child of body.nodes) {
      if (bodyIds.has(child.id)) issues.push(issue("duplicateNode", "error", { id: child.id }, child.id));
      bodyIds.add(child.id);
      // 第一版只支持一层 foreach（运行时按数据展开一次）。
      if (child.type === "foreach") {
        issues.push(issue("nestedForeach", "error", { node: child.title || child.id }, child.id));
        continue;
      }
      validateNodeConfig(child, issues);
    }
    validateEdges(body.nodes, body.edges, issues);
    const ancestors = ancestorsOf(flow.nodes, flow.edges).get(node.id) ?? new Set<string>();
    if (!ancestors.has(node.foreach.over)) {
      issues.push(
        issue("foreachUnknownOver", "error", { node: node.title || node.id, over: node.foreach.over }, node.id),
      );
    }
  }

  // 全演示流程给 warning，UI 展示「演示」标记。
  const usedCapabilities = flow.nodes.flatMap((node) => {
    const ids = [node.input?.capabilityId, node.tool?.capabilityId];
    const body = node.foreach?.body.nodes ?? [];
    for (const child of body) {
      ids.push(child.input?.capabilityId, child.tool?.capabilityId);
    }
    return ids.filter((id): id is string => typeof id === "string");
  });
  if (
    usedCapabilities.length > 0 &&
    usedCapabilities.every((id) => findCapability(id)?.provider === "simulated")
  ) {
    issues.push(issue("simulatedOnly", "warning"));
  }

  return issues;
}

export function hasBlockingIssues(issues: MissionValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

/** 是否有能力缺口（草稿可保存，但不可运行）。 */
export function hasUnavailableCapabilities(issues: MissionValidationIssue[]): boolean {
  return issues.some((item) => item.severity === "unavailable");
}

/** 是否可运行：无结构错误且无能力缺口。 */
export function isFlowRunnable(issues: MissionValidationIssue[]): boolean {
  return !issues.some((item) => item.severity === "error" || item.severity === "unavailable");
}

/** 该流程是否只使用演示能力（UI 标记用）。 */
export function usesOnlySimulatedCapabilities(flow: MissionFlowDefinition): boolean {
  const ids = flow.nodes.flatMap((node) => [
    ...(node.input?.capabilityId ? [node.input.capabilityId] : []),
    ...(node.tool?.capabilityId ? [node.tool.capabilityId] : []),
    ...((node.foreach?.body.nodes ?? []).flatMap((child) => [
      ...(child.input?.capabilityId ? [child.input.capabilityId] : []),
      ...(child.tool?.capabilityId ? [child.tool.capabilityId] : []),
    ])),
  ]);
  return ids.length > 0 && ids.every((id) => findCapability(id)?.provider === "simulated");
}
