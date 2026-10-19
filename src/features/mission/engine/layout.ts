import { Graph, layout } from "@dagrejs/dagre";
import type { MissionFlowDefinition, MissionFlowNode, MissionPosition } from "../types";

/**
 * 自动布局：人不能手动摆节点（方案 §4.3「程序自动布局」），所以节点位置
 * 由 dagre 分层计算。definition 与运行画布共用同一份位置。
 *
 * foreach 子流程先单独分层，再作为一个「组节点」参与顶层布局；组的尺寸
 * 由子流程包围盒决定。子节点位置是相对组左上角的坐标（React Flow 父子
 * 节点约定）。
 */

export const MISSION_NODE_WIDTH = 204;
export const MISSION_NODE_HEIGHT = 84;
export const MISSION_BODY_NODE_WIDTH = 176;
export const MISSION_BODY_NODE_HEIGHT = 72;
export const MISSION_GROUP_PADDING = 28;
export const MISSION_GROUP_HEADER = 52;

interface Size {
  width: number;
  height: number;
}

function layoutLayer(
  nodes: MissionFlowNode[],
  edges: Array<{ from: string; to: string }>,
  sizeOf: (node: MissionFlowNode) => Size,
): Map<string, MissionPosition> {
  const graph = new Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 34, ranksep: 96, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const size = sizeOf(node);
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of edges) {
    if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.setEdge(edge.from, edge.to);
  }
  const result: Map<string, MissionPosition> = new Map();
  if (nodes.length === 0) return result;
  layout(graph);
  for (const node of nodes) {
    const point = graph.node(node.id);
    const size = sizeOf(node);
    result.set(node.id, {
      x: Math.round(point.x - size.width / 2),
      y: Math.round(point.y - size.height / 2),
    });
  }
  return result;
}

interface GroupGeometry {
  size: Size;
  inner: Map<string, MissionPosition>;
}

function layoutBody(node: MissionFlowNode): GroupGeometry | null {
  const body = node.foreach?.body;
  if (!body || body.nodes.length === 0) return null;
  const inner = layoutLayer(body.nodes, body.edges, () => ({
    width: MISSION_BODY_NODE_WIDTH,
    height: MISSION_BODY_NODE_HEIGHT,
  }));
  let maxX = 0;
  let maxY = 0;
  for (const position of inner.values()) {
    maxX = Math.max(maxX, position.x + MISSION_BODY_NODE_WIDTH);
    maxY = Math.max(maxY, position.y + MISSION_BODY_NODE_HEIGHT);
  }
  const size: Size = {
    width: maxX + MISSION_GROUP_PADDING * 2,
    height: maxY + MISSION_GROUP_HEADER + MISSION_GROUP_PADDING,
  };
  return { size, inner };
}

/** 返回带新坐标的节点副本（不改动入参）。 */
export function layoutMissionFlow(flow: MissionFlowDefinition): MissionFlowDefinition {
  const groups = new Map<string, GroupGeometry>();
  const sizing = new Map<string, Size>();
  for (const node of flow.nodes) {
    if (node.type === "foreach") {
      const geometry = layoutBody(node);
      if (geometry) {
        groups.set(node.id, geometry);
        sizing.set(node.id, geometry.size);
      }
    }
  }
  const top = layoutLayer(flow.nodes, flow.edges, (node) => sizing.get(node.id) ?? {
    width: MISSION_NODE_WIDTH,
    height: MISSION_NODE_HEIGHT,
  });

  const nodes = flow.nodes.map((node) => {
    const position = top.get(node.id) ?? node.position;
    if (node.type !== "foreach" || !node.foreach) return { ...node, position };
    const geometry = groups.get(node.id);
    if (!geometry) return { ...node, position };
    const bodyNodes = node.foreach.body.nodes.map((child) => {
      const inner = geometry.inner.get(child.id) ?? child.position;
      return {
        ...child,
        position: {
          x: inner.x + MISSION_GROUP_PADDING,
          y: inner.y + MISSION_GROUP_HEADER,
        },
      };
    });
    return {
      ...node,
      position,
      foreach: {
        ...node.foreach,
        body: { ...node.foreach.body, nodes: bodyNodes },
      },
    };
  });

  return { ...flow, nodes };
}
