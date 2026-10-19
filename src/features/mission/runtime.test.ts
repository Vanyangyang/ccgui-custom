import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineInfo } from "@/lib/ipc";

/**
 * 执行环境解析（方案之外的用户确认方案 B）：
 * 流程固定配置优先 → 当前聊天会话（含模型/渠道/effort）→ 第一个可用引擎；
 * 固定配置失效时启动明确报错，不静默回退。
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
  workspaces: Array<{ path: string; name: string }>;
}

const chatState: MockChatState = { active: null, engines: [], workspaces: [] };

vi.mock("@/features/chat/store", () => {
  const useChatStore = Object.assign(
    (selector: (s: MockChatState) => unknown) => selector(chatState),
    { getState: () => chatState },
  );
  return { useChatStore };
});
vi.mock("@/lib/ipc", () => ({
  ipc: { missionAgentStart: vi.fn(), missionAgentInterrupt: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

import { setMissionPromptRunnerForTest } from "./agent-runner";
import { resetMissionRuntime, resolveMissionExecution, startMissionRun } from "./runtime";
import { resetMissionStore, useMissionStore } from "./store";
import type { MissionFlow } from "./types";

const CLAUDE: EngineInfo = {
  id: "claude",
  available: true,
  enabled: true,
  supportsImages: true,
  permissions: ["auto"],
  supportsToolConstraints: true,
};

const CODEX: EngineInfo = {
  id: "codex",
  available: true,
  enabled: true,
  supportsImages: false,
  permissions: ["auto"],
  supportsToolConstraints: false,
};

const DEFINITION = {
  version: 1,
  name: "测试流程",
  goal: "g",
  settings: { concurrency: 2, retries: 1, approval: "risk" as const, verification: false },
  nodes: [
    {
      id: "source",
      type: "input" as const,
      title: "输入",
      position: { x: 0, y: 0 },
      input: { capabilityId: "demo.repo.pullRequests", params: { count: 2 } },
    },
    {
      id: "review",
      type: "foreach" as const,
      title: "逐项",
      position: { x: 0, y: 0 },
      foreach: {
        over: "source",
        concurrency: 2,
        body: {
          nodes: [
            {
              id: "analyze",
              type: "agent" as const,
              title: "分析",
              position: { x: 0, y: 0 },
              agent: { instruction: "分析", readOnly: true, provider: "simulated" as const },
            },
          ],
          edges: [] as Array<{ id: string; from: string; to: string }>,
        },
      },
    },
    {
      id: "summary",
      type: "output" as const,
      title: "汇总",
      position: { x: 0, y: 0 },
      output: { artifact: "报告" },
    },
  ],
  edges: [
    { id: "e1", from: "source", to: "review" },
    { id: "e2", from: "review", to: "summary" },
  ],
};

function seedFlow(execution?: MissionFlow["execution"]): string {
  const flow: MissionFlow = {
    id: "flow-1",
    name: DEFINITION.name,
    goal: DEFINITION.goal,
    draft: structuredClone(DEFINITION),
    execution,
    versions: [],
    runIds: [],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  useMissionStore.getState().upsertFlow(flow);
  return flow.id;
}

beforeEach(() => {
  resetMissionStore();
  resetMissionRuntime();
  chatState.active = null;
  chatState.engines = [CLAUDE];
  chatState.workspaces = [{ path: "/w1", name: "项目A" }];
  setMissionPromptRunnerForTest(() => ({
    promise: Promise.resolve({ text: "risk=low" }),
    interrupt: () => {},
  }));
});

afterEach(() => {
  setMissionPromptRunnerForTest();
});

describe("resolveMissionExecution", () => {
  it("follows the active chat session including model/provider/effort", () => {
    chatState.active = {
      engine: "claude",
      sessionId: "s1",
      workspacePath: "/w1",
      model: "anthropic/opus",
      provider: "channel-1",
      effort: "high",
    };
    const resolution = resolveMissionExecution();
    expect(resolution.source).toBe("session");
    expect(resolution.execution).toEqual({
      engine: "claude",
      workspacePath: "/w1",
      model: "anthropic/opus",
      providerId: "channel-1",
      effort: "high",
    });
  });

  it("prefers a pinned flow execution over the session", () => {
    chatState.active = { engine: "claude", sessionId: "s1", workspacePath: "/w1" };
    chatState.engines = [CLAUDE, CODEX];
    const resolution = resolveMissionExecution({
      execution: {
        engine: "codex",
        workspacePath: "/w1",
        model: "gpt-x",
        providerId: null,
        effort: null,
      },
    } as MissionFlow);
    expect(resolution.source).toBe("flow");
    expect(resolution.execution?.engine).toBe("codex");
    expect(resolution.execution?.model).toBe("gpt-x");
  });

  it("reports invalid pinned config instead of silently falling back", () => {
    const engineGone = resolveMissionExecution({
      execution: {
        engine: "grok",
        workspacePath: "/w1",
        model: null,
        providerId: null,
        effort: null,
      },
    } as MissionFlow);
    expect(engineGone.invalidReason).toBe("engineUnavailable");
    expect(engineGone.execution).toBeNull();

    chatState.engines = [CLAUDE, CODEX];
    const workspaceGone = resolveMissionExecution({
      execution: {
        engine: "claude",
        workspacePath: "/gone",
        model: null,
        providerId: null,
        effort: null,
      },
    } as MissionFlow);
    expect(workspaceGone.invalidReason).toBe("workspaceMissing");
  });

  it("falls back to the first usable engine without a session or pin", () => {
    chatState.engines = [{ ...CLAUDE, enabled: false }, CODEX];
    const resolution = resolveMissionExecution();
    expect(resolution.source).toBe("default");
    expect(resolution.execution?.engine).toBe("codex");
  });
});

describe("startMissionRun execution plumbing", () => {
  it("pins the flow execution into the run snapshot", () => {
    const flowId = seedFlow({
      engine: "claude",
      workspacePath: "/w1",
      model: "anthropic/opus",
      providerId: "channel-1",
      effort: "high",
    });
    const started = startMissionRun(flowId);
    expect(started.ok).toBe(true);
    const run = useMissionStore.getState().runs[started.runId!];
    expect(run.execution).toEqual({
      engine: "claude",
      workspacePath: "/w1",
      model: "anthropic/opus",
      providerId: "channel-1",
      effort: "high",
    });
  });

  it("blocks the run when the pinned engine is unavailable", () => {
    chatState.engines = [CODEX];
    const flowId = seedFlow({
      engine: "claude",
      workspacePath: "/w1",
      model: null,
      providerId: null,
      effort: null,
    });
    const started = startMissionRun(flowId);
    expect(started.ok).toBe(false);
    expect(started.issues?.some((issue) => issue.code === "engineUnavailable")).toBe(true);
  });

  it("blocks the run when the pinned workspace disappeared", () => {
    const flowId = seedFlow({
      engine: "claude",
      workspacePath: "/gone",
      model: null,
      providerId: null,
      effort: null,
    });
    const started = startMissionRun(flowId);
    expect(started.ok).toBe(false);
    expect(started.issues?.some((issue) => issue.code === "workspaceMissing")).toBe(true);
  });

  it("stores and clears the pinned execution through the store action", () => {
    const flowId = seedFlow();
    useMissionStore.getState().setFlowExecution(flowId, {
      engine: "claude",
      workspacePath: "/w1",
      model: "m1",
      providerId: null,
      effort: null,
    });
    expect(useMissionStore.getState().flows[0].execution?.model).toBe("m1");
    useMissionStore.getState().setFlowExecution(flowId, null);
    expect(useMissionStore.getState().flows[0].execution).toBeNull();
  });
});
