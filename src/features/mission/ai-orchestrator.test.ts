import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineInfo } from "@/lib/ipc";

/**
 * M3 编排链路验收（假 agent runner，不启动真实引擎）：
 * 对话生成合法流程并可启动；修改产生新版本且不影响进行中的运行；
 * 非法提案原子性不生效；缺能力标注「不可运行」；只读约束不能兑现时不启动。
 */

interface MockChatState {
  active: {
    engine: string;
    sessionId: string;
    workspacePath: string;
    model?: string;
    provider?: string;
    effort?: string;
  } | null;
  engines: EngineInfo[];
  workspaces: Array<{ path: string }>;
}

const chatState: MockChatState = {
  active: null,
  engines: [],
  workspaces: [{ path: "/tmp/mission-workspace" }],
};

vi.mock("@/features/chat/store", () => ({
  useChatStore: { getState: () => chatState },
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { missionAgentStart: vi.fn(), missionAgentInterrupt: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

import { setMissionPromptRunnerForTest } from "./agent-runner";
import { sendMissionMessage } from "./ai-orchestrator";
import { resetMissionRuntime, startMissionRun } from "./runtime";
import { resetMissionStore, useMissionStore } from "./store";
import { validateMissionFlow, isFlowRunnable } from "./engine/validator";

const CLAUDE_ENGINE: EngineInfo = {
  id: "claude",
  available: true,
  enabled: true,
  supportsImages: true,
  permissions: ["auto"],
  supportsToolConstraints: true,
};

const CODEX_ENGINE: EngineInfo = {
  id: "codex",
  available: true,
  enabled: true,
  supportsImages: false,
  permissions: ["auto"],
  supportsToolConstraints: false,
};

function proposalDefinition(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    name: "全仓 PR 审查",
    goal: "审查所有打开的 PR",
    settings: { concurrency: 3, retries: 1, approval: "risk", verification: false },
    nodes: [
      {
        id: "source",
        type: "input",
        title: "读取 PR",
        input: { capabilityId: "demo.repo.pullRequests", params: { count: 4 } },
      },
      {
        id: "review",
        type: "foreach",
        title: "逐项审查",
        foreach: {
          over: "source",
          concurrency: 3,
          body: {
            nodes: [
              {
                id: "analyze",
                type: "agent",
                title: "分析变更",
                agent: { instruction: "分析代码与权限风险", readOnly: true },
              },
              {
                id: "route",
                type: "agent",
                title: "风险分流",
                agent: { instruction: "输出 risk=high 或 risk=low", readOnly: false },
              },
              { id: "confirm", type: "human", title: "确认", human: { ask: "确认审查意见" } },
              { id: "archive", type: "output", title: "归档意见", output: { artifact: "审查意见" } },
            ],
            edges: [
              { id: "e1", from: "analyze", to: "route" },
              { id: "e2", from: "route", to: "confirm", condition: "risk=high" },
              { id: "e3", from: "route", to: "archive" },
            ],
          },
        },
      },
      {
        id: "summary",
        type: "output",
        title: "审查汇总",
        output: { artifact: "审查结果与例外清单" },
      },
    ],
    edges: [
      { id: "e-source", from: "source", to: "review" },
      { id: "e-summary", from: "review", to: "summary" },
    ],
    ...overrides,
  };
}

function proposalJson(definition: unknown, reply = "好的。"): string {
  return ["说明", "```json", JSON.stringify({ reply, definition }), "```"].join("\n");
}

/** 默认假 runner：编排提示词返回给定提案；agent 节点提示词返回 low risk。 */
function installFakeRunner(proposal: (prompt: string) => string): void {
  setMissionPromptRunnerForTest((options) => ({
    promise: Promise.resolve({
      text: options.prompt.includes("流程编排器")
        ? proposal(options.prompt)
        : "risk=low\n分析完成",
    }),
    interrupt: () => {},
  }));
}

async function flush(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到断言为真或超时（避免测试依赖单次定时）。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await flush(20);
  }
}

beforeEach(() => {
  resetMissionStore();
  resetMissionRuntime();
  chatState.engines = [CLAUDE_ENGINE];
  chatState.active = null;
  setMissionPromptRunnerForTest();
});

afterEach(() => {
  setMissionPromptRunnerForTest();
});

describe("mission AI orchestration", () => {
  it("generates a valid, startable flow from a natural-language goal", async () => {
    installFakeRunner(() => proposalJson(proposalDefinition()));
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR，最多并发 3 个");

    const flow = useMissionStore.getState().flows.find((item) => item.id === flowId)!;
    expect(flow.draft).not.toBeNull();
    expect(flow.draft!.version).toBe(1);
    const issues = validateMissionFlow(flow.draft!);
    expect(isFlowRunnable(issues)).toBe(true);
    const last = flow.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.change?.version).toBe(1);
    expect(last.change?.lines.length).toBeGreaterThan(0);

    const started = startMissionRun(flowId);
    expect(started.ok).toBe(true);
    // 运行真实启动：入队 4 个输入项，等待模拟输入后逐项展开。
    await waitFor(() =>
      (useMissionStore.getState().runs[started.runId!]?.tasks ?? []).some(
        (task) => task.itemId !== null,
      ),
    );
    const run = useMissionStore.getState().runs[started.runId!];
    expect(run).toBeTruthy();
    expect(run.snapshot.version).toBe(1);
  });

  it("applies a revision as a new version and never touches a live run", async () => {
    installFakeRunner(() => proposalJson(proposalDefinition()));
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR");
    const started = startMissionRun(flowId);
    expect(started.ok).toBe(true);
    const runId = started.runId!;

    // 修改提案：并发 3 → 1，只保留既有节点 id。
    installFakeRunner(() =>
      proposalJson(
        proposalDefinition({
          settings: { concurrency: 1, retries: 2, approval: "all", verification: false },
        }),
        "已按你的要求调整。",
      ),
    );
    await sendMissionMessage(flowId, "并发上限改为 1，所有项都人工确认");

    const state = useMissionStore.getState();
    const flow = state.flows.find((item) => item.id === flowId)!;
    expect(flow.draft!.version).toBe(2);
    expect(flow.draft!.settings.concurrency).toBe(1);
    // 进行中的运行仍是启动时的快照。
    const run = state.runs[runId];
    expect(run.snapshot.version).toBe(1);
    expect(run.snapshot.settings.concurrency).toBe(3);
    expect(run.snapshot.settings.approval).toBe("risk");
  });

  it("leaves the draft unchanged when the proposal fails validation", async () => {
    installFakeRunner(() => proposalJson(proposalDefinition()));
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR");
    const version = useMissionStore.getState().flows.find((f) => f.id === flowId)!.draft!.version;

    // 非法提案：缺少 output 节点 + 循环连线 → 结构校验直接拒绝。
    installFakeRunner(() =>
      proposalJson({
        name: "坏流程",
        goal: "bad",
        settings: { concurrency: 5, retries: 1, approval: "risk", verification: true },
        nodes: [
          { id: "a", type: "agent", title: "A", agent: { instruction: "a" } },
          { id: "b", type: "agent", title: "B", agent: { instruction: "b" } },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "a" },
        ],
      }),
    );
    await sendMissionMessage(flowId, "随便改改");

    const flow = useMissionStore.getState().flows.find((f) => f.id === flowId)!;
    expect(flow.draft!.version).toBe(version);
    const last = flow.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.error).toBeTruthy();
    expect(flow.draft!.name).toBe("全仓 PR 审查");
  });

  it("keeps an unwired capability as a step but blocks the run", async () => {
    installFakeRunner(() =>
      proposalJson(
        proposalDefinition({
          nodes: [
            {
              id: "source",
              type: "input",
              title: "读取 PR",
              input: { capabilityId: "demo.repo.pullRequests", params: { count: 2 } },
            },
            {
              id: "merge",
              type: "tool",
              title: "自动合并 PR",
              tool: { capabilityId: "github.pr.merge" },
            },
            { id: "summary", type: "output", title: "汇总", output: { artifact: "结果" } },
          ],
          edges: [
            { id: "e1", from: "source", to: "merge" },
            { id: "e2", from: "merge", to: "summary" },
          ],
        }),
      ),
    );
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查后自动合并 PR");

    // 步骤生成并保留在草稿里……
    const flow = useMissionStore.getState().flows.find((f) => f.id === flowId)!;
    expect(flow.draft).not.toBeNull();
    expect(flow.draft!.nodes.some((node) => node.id === "merge")).toBe(true);
    const issues = validateMissionFlow(flow.draft!);
    expect(issues.some((issue) => issue.severity === "unavailable")).toBe(true);

    // ……但运行被阻止，且不伪造执行。
    const started = startMissionRun(flowId);
    expect(started.ok).toBe(false);
    expect(started.issues?.some((issue) => issue.code === "unavailableTool")).toBe(true);
  });

  it("refuses to start read-only nodes when the engine cannot enforce constraints", async () => {
    chatState.engines = [CODEX_ENGINE];
    installFakeRunner(() => proposalJson(proposalDefinition()));
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR");

    const started = startMissionRun(flowId);
    expect(started.ok).toBe(false);
    expect(started.issues?.some((issue) => issue.code === "readOnlyUnsupported")).toBe(true);
  });

  it("passes the session execution overrides to the generator", async () => {
    chatState.active = {
      engine: "claude",
      sessionId: "s1",
      workspacePath: "/tmp/mission-workspace",
      model: "anthropic/opus",
      provider: "channel-1",
      effort: "high",
    };
    let capturedModel: unknown = null;
    let capturedProvider: unknown = null;
    let capturedEffort: unknown = null;
    setMissionPromptRunnerForTest((options) => {
      capturedModel = options.model;
      capturedProvider = options.providerId;
      capturedEffort = options.effort;
      return {
        promise: Promise.resolve({ text: proposalJson(proposalDefinition()) }),
        interrupt: () => {},
      };
    });
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR");
    expect(capturedModel).toBe("anthropic/opus");
    expect(capturedProvider).toBe("channel-1");
    expect(capturedEffort).toBe("high");
  });

  it("reports engine absence instead of pretending to generate", async () => {
    installFakeRunner(() => proposalJson(proposalDefinition()));
    chatState.engines = [];
    const flowId = useMissionStore.getState().createFlow();
    await sendMissionMessage(flowId, "审查所有 PR");
    const flow = useMissionStore.getState().flows.find((f) => f.id === flowId)!;
    expect(flow.draft).toBeNull();
    expect(flow.messages.at(-1)!.text).toContain("引擎");
  });
});
