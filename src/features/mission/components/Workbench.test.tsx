import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { resetMissionRuntime } from "../runtime";
import { resetMissionStore, useMissionStore } from "../store";
import { MissionWorkbench } from "./Workbench";

/**
 * 工作台框架（M0 验收）：三个入口可切换；新建流程；内置示例装载；
 * React Flow 是重依赖，测试中以替身挂载，画布行为另有纯函数测试。
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
vi.mock("@xyflow/react", () => ({
  ReactFlow: () => <div data-testid="react-flow" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn() }),
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}));

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  act(() => {
    root.render(<MissionWorkbench />);
  });
}

function clickText(text: string): void {
  const button = [...document.body.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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

describe("MissionWorkbench frame", () => {
  it("opens with the seeded demo flow and switches between the three entries", () => {
    mount();
    const store = useMissionStore.getState();
    expect(store.flows).toHaveLength(1);
    expect(store.flows[0].name).toContain("PR");

    expect(container.textContent).toContain("流程助手");
    clickText("流程列表");
    expect(useMissionStore.getState().activeView).toBe("flows");
    expect(container.textContent).toContain("每件事，都有自己的进度");
    clickText("收件箱");
    expect(useMissionStore.getState().activeView).toBe("inbox");
    expect(container.textContent).toContain("流程有了消息");
    clickText("流程编排");
    expect(useMissionStore.getState().activeView).toBe("studio");
  });

  it("creates a new empty flow from the header action", () => {
    mount();
    clickText("新建流程");
    const store = useMissionStore.getState();
    expect(store.flows).toHaveLength(2);
    expect(store.selectedFlowId).toBe(store.flows[0].id);
    expect(store.canvasMode).toBe("definition");
    expect(store.flows[0].draft).toBeNull();
  });

  it("opens the about dialog with the safety boundary", () => {
    mount();
    const about = container.querySelector<HTMLButtonElement>('button[aria-label="查看说明"]')!;
    act(() => {
      about.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).toContain("AI 负责编排，人掌握目标和决定");
    expect(document.body.textContent).toContain("缺少能力，不可运行");
    clickText("关闭");
    expect(document.body.textContent).not.toContain("AI 负责编排，人掌握目标和决定");
  });
});
