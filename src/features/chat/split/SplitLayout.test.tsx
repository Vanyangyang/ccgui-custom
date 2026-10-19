import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSession } from "../store/persistence";
import { useChatStore } from "../store";
import { SplitDragProvider, useDragSource } from "./drag";
import { useSplitStore } from "./store";
import { SplitLayout } from "./SplitLayout";
import { listPanes, makeBranch, makePane } from "./tree";

// 真实的 ChatConversation 会拉进 markdown / 引擎目录 / IPC；这里只验证布局层
// （格子、标题栏、分隔条、落点），对话本身在浏览器 fixture 与真实应用里验。
vi.mock("../components/ChatConversation", () => ({
  ChatConversation: ({ active }: { active: ActiveSession | null }) => (
    <div data-testid="conversation">{active?.sessionId ?? "none"}</div>
  ),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
  };
});

function session(id: string | null, workspacePath = "/repo"): ActiveSession {
  return { engine: "claude", sessionId: id, workspacePath };
}

let node: HTMLDivElement;
let root: Root;
let startNewChat: ReturnType<typeof vi.fn>;
let focusTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  localStorage.clear();
  startNewChat = vi.fn();
  focusTab = vi.fn();
  useSplitStore.setState({ root: null, focusedPaneId: null });
  useChatStore.setState({
    active: session("a"),
    openTabs: [session("a"), session("b")],
    sessions: [],
    streamingByKey: {},
    focusTab: focusTab as never,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

async function render(extra?: ReactNode) {
  await act(async () => {
    root.render(
      <SplitDragProvider>
        <div style={{ position: "relative", width: 800, height: 600 }}>
          <SplitLayout
            active={useChatStore.getState().active}
            engines={[]}
            workspaces={[]}
            startNewChat={startNewChat}
          />
        </div>
        {extra}
      </SplitDragProvider>,
    );
  });
}

function paneElements(): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>("[data-split-pane]")];
}

function buttonWithLabel(label: string, within: HTMLElement): HTMLButtonElement {
  const button = [...within.querySelectorAll("button")].find(
    (el) => el.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`button ${label} not found`);
  return button as HTMLButtonElement;
}

function setTwoPanes() {
  const left = makePane(session("a"));
  const right = makePane(session("b"));
  useSplitStore.setState({ root: makeBranch("row", left, right), focusedPaneId: left.id });
  return { left, right };
}

describe("SplitLayout", () => {
  it("renders the solo conversation without a pane header", async () => {
    await render();
    expect(paneElements()).toHaveLength(1);
    expect(paneElements()[0].dataset.splitPane).toBe("solo");
    expect(node.textContent).toContain("a");
    expect(node.querySelector('[role="separator"]')).toBeNull();
  });

  it("renders one frame per pane with header actions and a divider", async () => {
    setTwoPanes();
    await render();
    expect(paneElements()).toHaveLength(2);
    const headers = [...node.querySelectorAll<HTMLElement>(".group\\/pane")];
    expect(headers).toHaveLength(2);
    expect(buttonWithLabel("chat.splitRight", headers[0])).toBeTruthy();
    expect(buttonWithLabel("chat.splitDown", headers[0])).toBeTruthy();
    expect(buttonWithLabel("chat.closePane", headers[0])).toBeTruthy();
    const divider = node.querySelector<HTMLElement>('[role="separator"]');
    expect(divider).not.toBeNull();
    expect(divider!.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider!.getAttribute("aria-valuenow")).toBe("50");
  });

  it("splits a pane into an empty one and closes it back", async () => {
    const { left } = setTwoPanes();
    await render();
    const first = paneElements()[0];
    await act(async () => buttonWithLabel("chat.splitRight", first).click());
    expect(listPanes(useSplitStore.getState().root).map((pane) => pane.session?.sessionId ?? null)).toEqual([
      "a",
      null,
      "b",
    ]);
    expect(left.session?.sessionId).toBe("a");
    // 新格子是空的：不渲染对话，给的是「拖入/新建」提示。
    expect(node.textContent).toContain("chat.emptyPaneHint");
    await act(async () =>
      buttonWithLabel("chat.closePane", paneElements()[1]).click(),
    );
    expect(listPanes(useSplitStore.getState().root).map((pane) => pane.session?.sessionId ?? null)).toEqual([
      "a",
      "b",
    ]);
  });

  it("closing the second-to-last pane returns to solo view", async () => {
    setTwoPanes();
    await render();
    await act(async () => buttonWithLabel("chat.closePane", paneElements()[1]).click());
    expect(useSplitStore.getState().root).toBeNull();
    expect(paneElements()).toHaveLength(1);
    expect(paneElements()[0].dataset.splitPane).toBe("solo");
  });

  it("resizes a split from the divider keyboard controls", async () => {
    setTwoPanes();
    await render();
    const divider = node.querySelector<HTMLElement>('[role="separator"]')!;
    divider.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 600, right: 0, bottom: 600, x: 0, y: 0 }) as DOMRect;
    await act(async () => {
      divider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    const branch = useSplitStore.getState().root;
    expect(branch?.kind === "split" ? branch.ratio : 0).toBeCloseTo(0.52);
  });
});

describe("split drag and drop", () => {
  /** 侧栏行的替身：真实行用的是同一个 useDragSource。 */
  function DragSourceRow({ target }: { target: ActiveSession }) {
    const startDrag = useDragSource({ kind: "session", session: target, label: "拖我" });
    return (
      <button type="button" data-testid="row" onPointerDown={startDrag}>
        row
      </button>
    );
  }

  function stubPaneRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
    element.getBoundingClientRect = () =>
      ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
      }) as DOMRect;
  }

  function pointer(type: string, x: number, y: number) {
    window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  }

  it("splits the solo view by dragging a session onto its edge", async () => {
    // 拖拽源必须与布局在同一个 provider 里（真实应用里侧栏与中心区同层）。
    await render(<DragSourceRow target={session("b")} />);
    const solo = paneElements()[0];
    stubPaneRect(solo, { left: 0, top: 0, width: 800, height: 600 });
    document.elementFromPoint = () => solo;
    const row = node.querySelector<HTMLElement>('[data-testid="row"]')!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0, button: 0 }),
      );
    });
    await act(async () => pointer("pointermove", 796, 300));
    expect(node.querySelector("[data-split-drop-hint]")).not.toBeNull();
    await act(async () => pointer("pointerup", 796, 300));
    expect(listPanes(useSplitStore.getState().root).map((pane) => pane.session?.sessionId ?? null)).toEqual([
      "a",
      "b",
    ]);
    expect(focusTab).toHaveBeenCalledWith("claude", "b", "/repo");
  });

  it("swaps pane contents when a pane is dropped on another pane's center", async () => {
    setTwoPanes();
    await render();
    const [first, second] = paneElements();
    stubPaneRect(first, { left: 0, top: 0, width: 400, height: 600 });
    stubPaneRect(second, { left: 400, top: 0, width: 400, height: 600 });
    document.elementFromPoint = () => first;
    const header = first.querySelector<HTMLElement>(".group\\/pane")!;
    await act(async () => {
      header.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 10, button: 0 }),
      );
    });
    document.elementFromPoint = () => second;
    await act(async () => pointer("pointermove", 600, 300));
    await act(async () => pointer("pointerup", 600, 300));
    expect(listPanes(useSplitStore.getState().root).map((pane) => pane.session?.sessionId ?? null)).toEqual([
      "b",
      "a",
    ]);
  });
});
