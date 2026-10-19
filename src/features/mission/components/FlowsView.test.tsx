import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { resetMissionStore, useMissionStore } from "../store";
import type { MissionFlow, MissionRun } from "../types";
import { FlowsView } from "./FlowsView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/features/chat/store", () => ({
  useChatStore: { getState: () => ({ active: null, engines: [], workspaces: [] }) },
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { missionAgentStart: vi.fn(), missionAgentInterrupt: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

let container: HTMLDivElement;
let root: Root;

function seedFlows(): void {
  const now = Date.now();
  const definition = {
    version: 2,
    name: "全仓 PR 审查",
    goal: "审查所有 PR",
    settings: { concurrency: 3, retries: 1, approval: "risk" as const, verification: false },
    nodes: [
      { id: "source", type: "input" as const, title: "输入", position: { x: 0, y: 0 }, input: { capabilityId: "demo.repo.pullRequests" } },
      { id: "summary", type: "output" as const, title: "汇总", position: { x: 0, y: 0 }, output: { artifact: "报告" } },
    ],
    edges: [{ id: "e1", from: "source", to: "summary" }],
  };
  const runningFlow: MissionFlow = {
    id: "flow-running",
    name: "全仓 PR 审查",
    goal: definition.goal,
    draft: definition,
    versions: [],
    runIds: ["run-1"],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const draftFlow: MissionFlow = {
    id: "flow-draft",
    name: "客户反馈整理",
    goal: "整理反馈",
    draft: { ...definition, name: "客户反馈整理" },
    versions: [],
    runIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const run: MissionRun = {
    id: "run-1",
    flowId: "flow-running",
    flowName: runningFlow.name,
    snapshot: definition,
    startedAt: now,
    tasks: [
      { id: "run-1:t1", runId: "run-1", nodeId: "source", title: "输入", status: "running", attempt: 1, round: 0, feedback: [], approved: false, forceApproval: false, itemId: null, itemLabel: null, parentTaskId: null },
      { id: "run-1:t2", runId: "run-1", nodeId: "summary", title: "汇总", status: "queued", attempt: 1, round: 0, feedback: [], approved: false, forceApproval: false, itemId: null, itemLabel: null, parentTaskId: null },
    ],
  };
  const store = useMissionStore.getState();
  store.upsertFlow(runningFlow);
  store.upsertFlow(draftFlow);
  store.upsertRun(run);
}

function mount(): void {
  act(() => {
    root.render(<FlowsView />);
  });
}

function clickText(text: string): void {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function typeInto(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  resetMissionStore();
  seedFlows();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FlowsView", () => {
  it("lists drafts and runs with their live status", () => {
    mount();
    expect(container.textContent).toContain("全仓 PR 审查");
    expect(container.textContent).toContain("客户反馈整理");
    expect(container.querySelector('[data-flow="flow-running"]')?.textContent).toContain("执行中");
    expect(container.querySelector('[data-flow="flow-draft"]')?.textContent).toContain("草稿");
  });

  it("filters by running / draft and by search text", () => {
    mount();
    clickText("运行中");
    expect(container.querySelector('[data-flow="flow-running"]')).toBeTruthy();
    expect(container.querySelector('[data-flow="flow-draft"]')).toBeNull();

    clickText("草稿");
    expect(container.querySelector('[data-flow="flow-running"]')).toBeNull();
    expect(container.querySelector('[data-flow="flow-draft"]')).toBeTruthy();

    clickText("全部");
    typeInto('input[aria-label="搜索流程名称…"]', "客户");
    expect(container.querySelector('[data-flow="flow-running"]')).toBeNull();
    expect(container.querySelector('[data-flow="flow-draft"]')).toBeTruthy();
  });

  it("opens the draft editor through 与 AI 修改 and the run through 查看运行", () => {
    mount();
    clickText("与 AI 修改");
    let state = useMissionStore.getState();
    expect(state.selectedFlowId).toBe("flow-running");
    expect(state.canvasMode).toBe("definition");
    expect(state.activeView).toBe("studio");

    clickText("查看运行");
    state = useMissionStore.getState();
    expect(state.selectedRunId).toBe("run-1");
    expect(state.canvasMode).toBe("run");
  });
});
