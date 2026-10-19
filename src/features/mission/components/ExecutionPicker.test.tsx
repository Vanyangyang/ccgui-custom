import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { EngineInfo } from "@/lib/ipc";
import { resetMissionRuntime } from "../runtime";
import { resetMissionStore, useMissionStore } from "../store";
import type { MissionFlow } from "../types";
import { ExecutionPicker } from "./ExecutionPicker";

/**
 * 执行环境选择器（方案 B）：默认跟随会话 → 改任意一项固定到流程；
 * 固定后运行使用该配置，可一键恢复跟随。
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: EngineInfo = {
  id: "claude",
  available: true,
  enabled: true,
  supportsImages: true,
  permissions: ["auto"],
  supportsToolConstraints: true,
};

const chatState = {
  active: null as null | {
    engine: string;
    sessionId: string;
    workspacePath: string;
    model?: string;
    provider?: string;
  },
  engines: [CLAUDE],
  workspaces: [{ path: "/w1", name: "项目A" }],
};

vi.mock("@/features/chat/store", () => {
  const useChatStore = Object.assign(
    (selector: (s: typeof chatState) => unknown) => selector(chatState),
    { getState: () => chatState },
  );
  return { useChatStore };
});

const listEngineModels = vi.fn(async () => ({
  models: [
    { id: "model-a", name: "模型A", provider: "anthropic" },
    { id: "model-b", name: "模型B", provider: "anthropic" },
  ],
  authoritative: true,
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    missionAgentStart: vi.fn(),
    missionAgentInterrupt: vi.fn(),
    listEngineModels: (...args: unknown[]) => listEngineModels(...(args as [])),
  },
}));
vi.mock("@/lib/events", () => ({
  listenMissionAgentEvents: vi.fn(async () => () => {}),
}));

let container: HTMLDivElement;
let root: Root;

function Host() {
  const flow = useMissionStore((s) => s.flows.find((item) => item.id === "flow-1") ?? null);
  if (!flow) return null;
  return <ExecutionPicker flow={flow} run={null} />;
}

function seedFlow(): void {
  const flow: MissionFlow = {
    id: "flow-1",
    name: "测试流程",
    goal: "g",
    draft: null,
    versions: [],
    runIds: [],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  useMissionStore.getState().upsertFlow(flow);
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<Host />);
  });
}

async function clickText(text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function changeSelect(label: string, value: string): Promise<void> {
  const select = [...container.querySelectorAll("label")].find((row) =>
    row.textContent?.includes(label),
  )?.querySelector("select");
  if (!select) throw new Error(`select not found: ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetMissionStore();
  resetMissionRuntime();
  seedFlow();
  chatState.active = null;
  chatState.engines = [CLAUDE];
  chatState.workspaces = [{ path: "/w1", name: "项目A" }];
  listEngineModels.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ExecutionPicker", () => {
  it("shows the session-derived environment and marks it as following", async () => {
    chatState.active = {
      engine: "claude",
      sessionId: "s1",
      workspacePath: "/w1",
      model: "model-b",
    };
    await mount();
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("跟随当前会话");
    expect(useMissionStore.getState().flows[0].execution).toBeUndefined();
  });

  it("pins the flow to the chosen model and unpins back to following", async () => {
    await mount();
    await clickText("Claude Code");
    // 弹层打开后拉取目录（引擎 + 工作区）。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listEngineModels).toHaveBeenCalledWith("claude", "/w1");
    expect(container.textContent).toContain("模型A");

    await changeSelect("模型", "model-a");
    let flow = useMissionStore.getState().flows[0];
    expect(flow.execution).toEqual({
      engine: "claude",
      workspacePath: "/w1",
      model: "model-a",
      providerId: null,
      effort: null,
    });
    expect(container.textContent).toContain("模型A");
    expect(container.textContent).not.toContain("跟随当前会话");

    await clickText("恢复跟随会话");
    flow = useMissionStore.getState().flows[0];
    expect(flow.execution).toBeNull();
    expect(container.textContent).toContain("跟随当前会话");
  });

  it("switching the engine resets the model and pins the new engine", async () => {
    chatState.engines = [
      CLAUDE,
      { ...CLAUDE, id: "codex", supportsToolConstraints: false, supportsImages: false },
    ];
    await mount();
    await clickText("Claude Code");
    await changeSelect("引擎", "codex");
    const flow = useMissionStore.getState().flows[0];
    expect(flow.execution?.engine).toBe("codex");
    expect(flow.execution?.model).toBeNull();
    expect(container.textContent).toContain("Codex CLI");
  });

  it("shows the pinned snapshot as read-only in the run view", async () => {
    await act(async () => {
      root.render(
        <ExecutionPicker
          flow={{
            ...useMissionStore.getState().flows[0],
            execution: {
              engine: "claude",
              workspacePath: "/w1",
              model: "model-a",
              providerId: null,
              effort: null,
            },
          }}
          run={{
            id: "run-1",
            flowId: "flow-1",
            flowName: "测试流程",
            snapshot: {
              version: 1,
              name: "t",
              goal: "g",
              settings: { concurrency: 1, retries: 0, approval: "risk", verification: false },
              nodes: [],
              edges: [],
            },
            execution: {
              engine: "claude",
              workspacePath: "/w1",
              model: "model-a",
              providerId: null,
              effort: null,
            },
            tasks: [],
            startedAt: 1,
          }}
        />,
      );
    });
    expect(container.textContent).toContain("model-a");
    // 运行快照只读：没有可点击的弹层触发器。
    expect(container.querySelector("button")).toBeNull();
  });
});
