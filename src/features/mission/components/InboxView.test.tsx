import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { resetMissionRuntime } from "../runtime";
import { resetMissionStore, useMissionStore } from "../store";
import type {
  MissionFlowDefinition,
  MissionInboxItem,
  MissionRun,
  MissionTaskInstance,
  MissionTaskStatus,
} from "../types";
import { InboxView } from "./InboxView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 收件箱交互回归（M2）：
 * 已读 ≠ 已处理；批准/反馈/排除推动任务；空反馈不授权。
 */

vi.mock("@/features/chat/store", () => ({
  useChatStore: { getState: () => ({ active: null, engines: [], workspaces: [] }) },
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { missionAgentStart: vi.fn(), missionAgentInterrupt: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

const definition: MissionFlowDefinition = {
  version: 1,
  name: "测试流程",
  goal: "验证收件箱",
  settings: { concurrency: 3, retries: 1, approval: "risk", verification: false },
  nodes: [
    { id: "source", type: "input", title: "输入", position: { x: 0, y: 0 }, input: { capabilityId: "demo.repo.pullRequests" } },
    {
      id: "review",
      type: "foreach",
      title: "逐项审查",
      position: { x: 0, y: 0 },
      foreach: {
        over: "source",
        concurrency: 3,
        body: {
          nodes: [
            {
              id: "analyze",
              type: "agent",
              title: "分析",
              position: { x: 0, y: 0 },
              agent: { instruction: "分析", provider: "simulated" },
            },
            {
              id: "review_human",
              type: "human",
              title: "等待业务决定",
              position: { x: 0, y: 0 },
              human: { ask: "确认" },
            },
          ],
          edges: [{ id: "be1", from: "analyze", to: "review_human" }],
        },
      },
    },
    { id: "summary", type: "output", title: "汇总", position: { x: 0, y: 0 }, output: { artifact: "结果" } },
  ],
  edges: [
    { id: "e1", from: "source", to: "review" },
    { id: "e2", from: "review", to: "summary" },
  ],
};

function makeTask(status: MissionTaskStatus, index: number): MissionTaskInstance {
  return {
    id: `run-9:review_human-${index}`,
    runId: "run-9",
    nodeId: "review_human",
    title: "等待业务决定",
    status,
    attempt: 1,
    round: 0,
    feedback: [],
    approved: false,
    forceApproval: false,
    itemId: `item-${index}`,
    itemLabel: `PR #${index}`,
    parentTaskId: "run-9:review",
  };
}

function makeParentAndAnalyze(index: number): MissionTaskInstance[] {
  return [
    {
      id: "run-9:review",
      runId: "run-9",
      nodeId: "review",
      title: "逐项审查",
      status: "succeeded",
      attempt: 1,
      round: 0,
      feedback: [],
      approved: false,
      forceApproval: false,
      itemId: null,
      itemLabel: null,
      parentTaskId: null,
    },
    {
      id: `run-9:analyze-${index}`,
      runId: "run-9",
      nodeId: "analyze",
      title: "分析",
      status: "succeeded",
      attempt: 1,
      round: 0,
      feedback: [],
      approved: false,
      forceApproval: false,
      itemId: `item-${index}`,
      itemLabel: `PR #${index}`,
      parentTaskId: "run-9:review",
    },
  ];
}

function seedInbox(options: {
  waiting?: boolean;
  failed?: boolean;
}): { waitingTask: MissionTaskInstance | null; failedTask: MissionTaskInstance | null } {
  const tasks: MissionTaskInstance[] = [];
  if (options.waiting) tasks.push(...makeParentAndAnalyze(1), makeTask("waiting_human", 1));
  if (options.failed) tasks.push(...makeParentAndAnalyze(2), makeTask("failed", 2));
  const run: MissionRun = {
    id: "run-9",
    flowId: "flow-test",
    flowName: "测试流程",
    snapshot: definition,
    tasks,
    startedAt: 1,
  };
  const flow = {
    id: "flow-test",
    name: "测试流程",
    goal: "验证收件箱",
    draft: definition,
    versions: [],
    runIds: ["run-9"],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const items: MissionInboxItem[] = [];
  const waitingTask = tasks.find((task) => task.status === "waiting_human") ?? null;
  const failedTask = tasks.find((task) => task.status === "failed") ?? null;
  if (waitingTask) {
    items.push({
      id: "notice-waiting",
      flowId: "flow-test",
      runId: "run-9",
      taskId: waitingTask.id,
      nodeKey: `task:${waitingTask.id}`,
      type: "attention",
      title: "PR #1 · 需要人工确认",
      body: "需要业务判断。",
      read: false,
      resolved: false,
      createdAt: 1,
      dedupeKey: "attention:1",
    });
  }
  if (failedTask) {
    items.push({
      id: "notice-failed",
      flowId: "flow-test",
      runId: "run-9",
      taskId: failedTask.id,
      nodeKey: `task:${failedTask.id}`,
      type: "failed",
      title: "PR #2 · 重试超限",
      body: "需要恢复。",
      read: true,
      resolved: false,
      createdAt: 2,
      dedupeKey: "failure:2",
    });
  }
  const store = useMissionStore.getState();
  store.upsertFlow(flow);
  store.upsertRun(run);
  for (const item of items) store.upsertInbox(item);
  store.selectFlow("flow-test", "run", "run-9");
  return { waitingTask, failedTask };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  act(() => {
    root.render(<InboxView />);
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

function clickNotice(id: string): void {
  const row = container.querySelector(`[data-notice="${id}"]`);
  if (!row) throw new Error(`notice not found: ${id}`);
  act(() => {
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
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

describe("InboxView", () => {
  it("marks a notice read without approving the task", () => {
    const { waitingTask } = seedInbox({ waiting: true });
    mount();
    clickNotice("notice-waiting");

    const state = useMissionStore.getState();
    expect(state.inbox.find((item) => item.id === "notice-waiting")?.read).toBe(true);
    expect(state.inbox.find((item) => item.id === "notice-waiting")?.resolved).toBe(false);
    const task = state.runs["run-9"].tasks.find((row) => row.id === waitingTask!.id)!;
    expect(task.status).toBe("waiting_human");
  });

  it("approves an attention task and resolves its notice", () => {
    const { waitingTask } = seedInbox({ waiting: true });
    mount();
    clickNotice("notice-waiting");
    clickText("确认并归档");

    const state = useMissionStore.getState();
    expect(state.inbox.find((item) => item.id === "notice-waiting")?.resolved).toBe(true);
    const task = state.runs["run-9"].tasks.find((row) => row.id === waitingTask!.id)!;
    expect(task.status).toBe("succeeded");
    expect(task.approved).toBe(true);
  });

  it("requires feedback text and requeues the branch only after a real value", () => {
    const { waitingTask } = seedInbox({ waiting: true });
    mount();
    clickNotice("notice-waiting");
    clickText("补充要求");

    clickText("反馈并重新处理");
    expect(container.textContent).toContain("请填写补充要求");

    const textarea = container.querySelector<HTMLTextAreaElement>("#mission-inbox-feedback")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "补充权限测试证据");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickText("反馈并重新处理");

    const state = useMissionStore.getState();
    const task = state.runs["run-9"].tasks.find((row) => row.id === waitingTask!.id)!;
    expect(task.round).toBe(1);
    expect(task.feedback).toEqual(["补充权限测试证据"]);
    expect(task.forceApproval).toBe(true);
    // 反馈分支被重新执行；不会停留在旧的等待状态。
    expect(["queued", "running", "waiting_human"]).toContain(task.status);
  });

  it("excludes a failed item instead of pretending it succeeded", () => {
    seedInbox({ failed: true });
    mount();
    clickNotice("notice-failed");
    clickText("排除此项");

    const state = useMissionStore.getState();
    const task = state.runs["run-9"].tasks.find(
      (row) => row.nodeId === "review_human",
    )!;
    expect(task.status).toBe("excluded");
    expect(state.inbox.find((item) => item.id === "notice-failed")?.resolved).toBe(true);
  });

  it("locates the exact run and task on the canvas", () => {
    const { failedTask } = seedInbox({ failed: true });
    mount();
    clickNotice("notice-failed");
    clickText("在画布定位");

    const state = useMissionStore.getState();
    expect(state.activeView).toBe("studio");
    expect(state.canvasMode).toBe("run");
    expect(state.selectedRunId).toBe("run-9");
    expect(state.selectedNodeKey).toBe(`task:${failedTask!.id}`);
  });
});
