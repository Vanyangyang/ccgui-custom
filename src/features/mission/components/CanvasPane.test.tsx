import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { buildPrReviewDemoFlow } from "../builtin/pr-review";
import { MissionScheduler } from "../engine/scheduler";
import { createSimulatedExecutor } from "../engine/simulated";
import { resetMissionRuntime } from "../runtime";
import { resetMissionStore, useMissionStore } from "../store";
import type { MissionRun } from "../types";
import { CanvasPane } from "./CanvasPane";

/**
 * 画布挂载回归：真实 React Flow（jsdom + ResizeObserver/DOM 矩阵替身）。
 * 验证定义视图的组/子节点渲染、运行视图的任务卡数量与选中行为。
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
  m22 = 1;
  constructor(_transform?: string) {}
};

vi.mock("@/features/chat/store", () => {
  const state = { active: null, engines: [], workspaces: [] };
  const useChatStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useChatStore };
});
vi.mock("@/lib/ipc", () => ({
  ipc: { missionAgentStart: vi.fn(), missionAgentInterrupt: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

let container: HTMLDivElement;
let root: Root;

function seedFlow(): void {
  const definition = buildPrReviewDemoFlow();
  const now = Date.now();
  const store = useMissionStore.getState();
  store.upsertFlow({
    id: "flow-1",
    name: definition.name,
    goal: definition.goal,
    draft: definition,
    versions: [],
    runIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  store.selectFlow("flow-1", "definition");
}

async function seedRunToAttention(): Promise<MissionRun> {
  const definition = buildPrReviewDemoFlow();
  const scheduler = new MissionScheduler({
    executor: createSimulatedExecutor({ delayMs: 0 }),
    emit: () => {},
    onRunChanged: () => {},
    now: () => Date.now(),
    newId: (prefix) => `${prefix}-1`,
  });
  const run = scheduler.createRun(definition, "flow-1", definition.name);
  scheduler.start(run);
  for (let step = 0; step < 500; step++) {
    if (run.tasks.every((task) => task.status !== "running")) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  useMissionStore.getState().upsertRun(structuredClone(run));
  return run;
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<CanvasPane />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function clickNode(nodeId: string): void {
  const element = container.querySelector(`[data-id="${nodeId}"]`);
  if (!element) throw new Error(`node not found: ${nodeId}`);
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetMissionStore();
  resetMissionRuntime();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CanvasPane", () => {
  it("renders the definition graph with group and body nodes", async () => {
    seedFlow();
    await mount();
    expect(container.querySelectorAll(".react-flow__node").length).toBe(8);
    expect(container.querySelector(".react-flow__node-missionGroup")).toBeTruthy();
    expect(container.querySelector('[data-id="body:review:analyze"]')).toBeTruthy();
    // 连线的渲染由 React Flow 在真实尺寸测量后进行，jsdom 下不断言；
    // 连接数据由 mission-graph 的纯函数测试覆盖。
    expect(container.textContent).toContain("禁止手工改图");
  });

  it("renders one task card per foreach item in the run view", async () => {
    seedFlow();
    const run = await seedRunToAttention();
    useMissionStore.getState().setCanvasMode("run");
    await mount();
    const items = container.querySelectorAll(".react-flow__node-missionItem");
    expect(items).toHaveLength(30);
    const waiting = container.querySelectorAll(
      '.react-flow__node-missionItem [data-state="waiting_human"]',
    );
    expect(waiting.length).toBe(5);
    expect(container.textContent).toContain("已终结");
    void run;
  });

  it("selects the owning task when an item card is clicked", async () => {
    seedFlow();
    const run = await seedRunToAttention();
    useMissionStore.getState().setCanvasMode("run");
    await mount();
    const firstItem = container.querySelector<HTMLElement>(".react-flow__node-missionItem")!;
    const wrap = firstItem.closest<HTMLElement>("[data-id]") ?? firstItem;
    const wrapId = wrap.getAttribute("data-id")!;
    clickNode(wrapId);
    const selected = useMissionStore.getState().selectedNodeKey;
    expect(selected?.startsWith("task:")).toBe(true);
    const taskId = selected!.slice("task:".length);
    expect(run.tasks.some((task) => task.id === taskId)).toBe(true);
  });

  it("selects a definition node on click", async () => {
    seedFlow();
    await mount();
    clickNode("node:source");
    expect(useMissionStore.getState().selectedNodeKey).toBe("node:source");
    expect(container.textContent).toContain("AI DEFINITION");
  });
});
