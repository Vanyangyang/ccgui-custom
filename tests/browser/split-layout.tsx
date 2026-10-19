// Open /tests/browser/split-layout.html with the Vite dev server running.
// Verifies the Trellis-style conversation split against real DOM layout:
// dragging a sidebar session onto the right edge of the single conversation
// must create a second pane at half width, 「向下分屏」 must add an empty pane,
// closing a pane must collapse back to a single column, dragging the divider
// must honor the pointer ratio, and the layout must be persisted (and removed
// again) in localStorage. Real SplitLayout + SplitDragProvider + drag layer and
// the real ChatConversation in every pane; only the chat store's focusTab and
// the git store's IPC-backed actions are stubbed. No app, no backend, no model.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../../src/index.css";
import "../../src/lib/i18n";
import { useChatStore } from "../../src/features/chat/store";
import { useGitStore } from "../../src/features/git/store";
import type { Workspace } from "../../src/lib/ipc";
import type { SessionMeta } from "../../src/lib/ipc";
import {
  SplitDragProvider,
  useDragSource,
} from "../../src/features/chat/split/drag";
import { SessionTabStrip } from "../../src/features/chat/components/SessionTabStrip";
import type { SessionTabItem } from "../../src/features/chat/components/SessionTab";
import { SplitLayout } from "../../src/features/chat/split/SplitLayout";
import { SPLIT_LAYOUT_KEY, useSplitStore } from "../../src/features/chat/split/store";
import { listPanes } from "../../src/features/chat/split/tree";

localStorage.setItem("ccgui-next.language", "zh");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 夹具跑真实 i18n（zh），按钮按可见语义词查。
const SPLIT_RIGHT = "向右分屏";
const SPLIT_DOWN = "向下分屏";
const CLOSE_PANE = "关闭这一格";

const failures: string[] = [];
const notes: string[] = [];

// 夹具自身要能看见页面里的异常：否则渲染报错只体现在「元素找不到」。
window.addEventListener("error", (event) => {
  notes.push(`window error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  notes.push(`unhandled rejection: ${String((event as PromiseRejectionEvent).reason)}`);
});
const nativeConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  notes.push(`console.error: ${args.map((arg) => String(arg)).join(" ")}`.slice(0, 400));
  nativeConsoleError(...args);
};

function check(condition: boolean, label: string) {
  if (condition) notes.push(`ok   ${label}`);
  else failures.push(label);
}

function near(actual: number, expected: number, tolerance: number) {
  return Math.abs(actual - expected) <= tolerance;
}

const SESSION_A = { engine: "claude", sessionId: "aaa-111", workspacePath: "/ws/a" };
const SESSION_B = { engine: "claude", sessionId: "bbb-222", workspacePath: "/ws/a" };

function meta(sessionId: string, title: string): SessionMeta {
  return {
    engine: "claude",
    sessionId,
    workspacePath: "/ws/a",
    filePath: `/ws/a/${sessionId}.jsonl`,
    fileSize: 1,
    fileMtimeMs: 1,
    title,
    preview: "",
    createdAt: null,
    updatedAt: Date.now(),
    messageCount: 0,
    pinned: false,
    customTitle: null,
  } as SessionMeta;
}

const SESSION_STATE = {
  messages: [],
  subagentHistory: [],
  nextBefore: null,
  loading: false,
  streaming: false,
  turnStartedAt: null,
  activeModel: null,
  activeEffort: null,
  activeProvider: null,
  usage: null,
  turnUsage: null,
  error: null,
  retry: null,
  compaction: null,
  queue: [],
  interrupted: false,
  planReviewResume: null,
};

/** Sidebar row stand-in: the real drag source hook, same as the real row. */
function DragRow({ sessionId, session }: { sessionId: string; session: typeof SESSION_A }) {
  const startDrag = useDragSource({
    kind: "session",
    session,
    label: sessionId,
  });
  return (
    <button
      type="button"
      data-row={sessionId}
      onPointerDown={(event) => {
        notes.push(`pointerdown on row ${sessionId}`);
        startDrag(event);
      }}
      style={{
        display: "block",
        width: "100%",
        padding: "6px 8px",
        border: "1px solid #ccc",
        borderRadius: 6,
        background: "#fff",
        textAlign: "left",
        cursor: "grab",
      }}
    >
      {sessionId}
    </button>
  );
}

const TABS: SessionTabItem[] = [
  { key: "claude/aaa-111", label: "会话 A", streaming: false, session: SESSION_A },
  { key: "claude/bbb-222", label: "会话 B", streaming: false, session: SESSION_B },
];

function Harness() {
  const [active] = useState(SESSION_A);
  return (
    <SplitDragProvider>
      <div style={{ display: "flex", gap: 8, width: 980, height: 620 }}>
        <div
          style={{ width: 200, display: "flex", flexDirection: "column", gap: 6 }}
          data-fixture-sidebar=""
        >
          <DragRow sessionId="aaa-111" session={SESSION_A} />
          <DragRow sessionId="bbb-222" session={SESSION_B} />
        </div>
        <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column" }}>
          <SessionTabStrip
            tabs={TABS}
            activeKey="claude/aaa-111"
            onSelect={() => {}}
            onClose={() => {}}
            closeLabel="关闭"
            onReorder={() => {}}
          />
          <div
            data-fixture-center=""
            style={{
              position: "relative",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              border: "1px solid #ddd",
              borderRadius: 8,
              background: "#fff",
            }}
          >
            <SplitLayout
              active={active}
              engines={[]}
              workspaces={[] as Workspace[]}
              startNewChat={() => {}}
            />
          </div>
        </div>
      </div>
    </SplitDragProvider>
  );
}

function pointer(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
  );
}

function centerOf(el: Element) {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function panes() {
  return [...document.querySelectorAll<HTMLElement>("[data-split-pane]")];
}

function paneIds() {
  return panes().map((el) => el.dataset.splitPane ?? "");
}

function sessionIds() {
  const root = useSplitStore.getState().root;
  return listPanes(root).map((pane) => pane.session?.sessionId ?? null);
}

function headerButton(paneEl: HTMLElement, label: string) {
  return [...paneEl.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
}

async function main() {
  useChatStore.setState({
    active: SESSION_A,
    openTabs: [SESSION_A, SESSION_B],
    sessions: [meta("aaa-111", "会话 A"), meta("bbb-222", "会话 B")],
    engines: [],
    workspaces: [],
    bySession: {
      "claude/aaa-111": { ...SESSION_STATE },
      "claude/bbb-222": { ...SESSION_STATE },
    },
    // 激活会话会走原生 IPC：夹具只记录，不真的切会话。
    focusTab: ((engine: string, sessionId: string | null) => {
      notes.push(`focusTab ${engine}/${sessionId}`);
    }) as never,
  });
  // git 状态刷新走 IPC：夹具里静默。
  useGitStore.setState({
    refresh: (async () => {}) as never,
    loadBranches: (async () => {}) as never,
  });
  useSplitStore.setState({ root: null, focusedPaneId: null });
  localStorage.removeItem(SPLIT_LAYOUT_KEY);

  const container = document.getElementById("fixture");
  if (!container) throw new Error("fixture container missing");
  const root = createRoot(container);
  // 真实 ChatConversation 的下拉菜单用 react-router 的 navigate（应用里有
  // Router，夹具补一个内存路由）。
  root.render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  await sleep(150);

  // 1. 单栏：一格、没有标题栏、没有分隔条。
  check(panes().length === 1, `solo renders one pane (got ${panes().length})`);
  check(paneIds()[0] === "solo", "solo pane carries the solo id");
  check(document.querySelectorAll("[data-split-divider]").length === 0, "solo has no divider");
  check(document.querySelectorAll(".group\\/pane").length === 0, "solo has no pane header");

  // 2. 拖侧栏会话到单栏的右边缘 → 左右分屏。
  const rowB = document.querySelector<HTMLElement>('[data-row="bbb-222"]');
  const center = document.querySelector<HTMLElement>("[data-fixture-center]");
  if (!rowB || !center) throw new Error("sidebar row or center missing");
  const centerBox = center.getBoundingClientRect();
  const rowCenter = centerOf(rowB);
  const probe = document.elementFromPoint(
    centerBox.right - 20,
    centerBox.top + centerBox.height / 2,
  );
  notes.push(
    `probe at the right edge: ${probe?.tagName ?? "none"} pane=${
      probe?.closest("[data-split-pane]") ? "yes" : "no"
    }`,
  );
  pointer(rowB, "pointerdown", rowCenter.x, rowCenter.y);
  pointer(window, "pointermove", centerBox.right - 20, centerBox.top + centerBox.height / 2);
  await sleep(60);
  check(document.querySelector("[data-split-drop-hint]") !== null, "drop hint shows mid-drag");
  pointer(window, "pointerup", centerBox.right - 20, centerBox.top + centerBox.height / 2);
  await sleep(120);

  check(panes().length === 2, `drag to the right edge splits into two panes (got ${panes().length})`);
  check(
    JSON.stringify(sessionIds()) === JSON.stringify(["aaa-111", "bbb-222"]),
    `left pane keeps the active session, right pane gets the dragged one (got ${JSON.stringify(sessionIds())})`,
  );
  const [leftPane, rightPane] = panes();
  if (leftPane && rightPane) {
    const left = leftPane.getBoundingClientRect();
    const right = rightPane.getBoundingClientRect();
    check(
      near(right.left - centerBox.left, centerBox.width / 2, 3),
      `right pane starts at the half-width divider (got ${Math.round(right.left - centerBox.left)} of ${Math.round(centerBox.width / 2)})`,
    );
    check(
      near(left.width, right.width, 3) && left.top === right.top,
      "both panes share the same row height and half width",
    );
    check(
      document.querySelectorAll(".group\\/pane").length === 2,
      "split panes carry headers",
    );
    check(
      document.querySelectorAll("[data-split-divider]").length === 1,
      "one divider between the panes",
    );
  }
  check(localStorage.getItem(SPLIT_LAYOUT_KEY) !== null, "split layout is persisted");

  check(
    headerButton(panes()[1], SPLIT_RIGHT) !== undefined,
    "pane header exposes the split-right action",
  );

  // 3. 「向下分屏」切出空格子。
  const splitDown = headerButton(panes()[1], SPLIT_DOWN);
  if (!splitDown) throw new Error("split-down button missing");
  splitDown.click();
  await sleep(120);
  check(
    JSON.stringify(sessionIds()) === JSON.stringify(["aaa-111", "bbb-222", null]),
    `split down adds an empty pane (got ${JSON.stringify(sessionIds())})`,
  );
  check(
    document.body.textContent?.includes("把一个会话拖到这里") === true,
    "empty pane shows the drag/new-chat hint",
  );

  // 4. 关掉空格子 → 回到两格。
  const closeEmpty = headerButton(panes()[2], CLOSE_PANE);
  if (!closeEmpty) throw new Error("close button missing");
  closeEmpty.click();
  await sleep(120);
  check(
    JSON.stringify(sessionIds()) === JSON.stringify(["aaa-111", "bbb-222"]),
    `closing the empty pane returns to the previous two panes (got ${JSON.stringify(sessionIds())})`,
  );

  // 5. 拖动格子标题栏到另一格中心 → 两格内容互换（Trellis 式窗口拖拽）。
  const headerLeft = panes()[0].querySelector<HTMLElement>(".group\\/pane");
  const headerRight = panes()[1].querySelector<HTMLElement>(".group\\/pane");
  if (!headerLeft || !headerRight) throw new Error("pane headers missing");
  const headerStart = centerOf(headerRight);
  const paneTarget = centerOf(panes()[0]);
  pointer(headerRight, "pointerdown", headerStart.x, headerStart.y);
  pointer(window, "pointermove", paneTarget.x, paneTarget.y);
  await sleep(60);
  pointer(window, "pointerup", paneTarget.x, paneTarget.y);
  await sleep(120);
  check(
    JSON.stringify(sessionIds()) === JSON.stringify(["bbb-222", "aaa-111"]),
    `dragging a pane header onto another pane swaps them (got ${JSON.stringify(sessionIds())})`,
  );

  // 6. 拖动分隔条：先到 40%，再拖过头验证最小格子宽度。
  const divider = document.querySelector<HTMLElement>("[data-split-divider]");
  if (!divider) throw new Error("divider missing");
  const box = center.getBoundingClientRect();
  async function dragDividerTo(fraction: number) {
    const dividerBox = divider!.getBoundingClientRect();
    pointer(
      divider!,
      "pointerdown",
      dividerBox.left + dividerBox.width / 2,
      dividerBox.top + dividerBox.height / 2,
    );
    const x = box.left + box.width * fraction;
    const y = box.top + box.height / 2;
    pointer(window, "pointermove", x, y);
    pointer(window, "pointerup", x, y);
    await sleep(120);
  }
  await dragDividerTo(0.4);
  const stored = JSON.parse(localStorage.getItem(SPLIT_LAYOUT_KEY) ?? "{}");
  check(
    near(stored?.root?.ratio ?? 0, 0.4, 0.03),
    `divider drag stores the pointer ratio (got ${stored?.root?.ratio})`,
  );
  check(
    near(panes()[0].getBoundingClientRect().width, box.width * 0.4, 4),
    `first pane width follows the dragged ratio (got ${Math.round(
      panes()[0].getBoundingClientRect().width,
    )} of ${Math.round(box.width * 0.4)})`,
  );
  await dragDividerTo(0.02);
  const clamped = JSON.parse(localStorage.getItem(SPLIT_LAYOUT_KEY) ?? "{}");
  const expectedMin = 220 / box.width;
  check(
    near(clamped?.root?.ratio ?? 0, expectedMin, 0.02),
    `dragging past the edge clamps to the 220px minimum pane (got ${
      clamped?.root?.ratio
    }, min ${expectedMin.toFixed(3)})`,
  );

  // 7. 关到只剩一格 → 回单栏，并清掉持久化。
  headerButton(panes()[1], CLOSE_PANE)?.click();
  await sleep(120);
  check(panes().length === 1 && paneIds()[0] === "solo", "closing down to one pane returns to solo");
  check(localStorage.getItem(SPLIT_LAYOUT_KEY) === null, "solo view clears the persisted layout");

  // 8. 从页签条把页签向下拖进对话区 → 同样分屏（横向拖动仍是排序）。
  // 拖拽处理器挂在页签的 [role="tab"] 内层（外层只有 data-tab-key 供命中判定）。
  const tabB = document.querySelector<HTMLElement>(
    '[data-tab-key="claude/bbb-222"] [role="tab"]',
  );
  const stripBox = document
    .querySelector<HTMLElement>("[data-tab-strip]")
    ?.getBoundingClientRect();
  if (!tabB || !stripBox) throw new Error("tab strip missing");
  const tabCenter = centerOf(tabB);
  pointer(tabB, "pointerdown", tabCenter.x, tabCenter.y);
  pointer(window, "pointermove", tabCenter.x, stripBox.bottom + 60);
  await sleep(60);
  pointer(window, "pointermove", centerBox.right - 20, centerBox.top + centerBox.height / 2);
  await sleep(60);
  check(
    document.querySelector("[data-split-drop-hint]") !== null,
    "dragging a tab shows the pane drop hint",
  );
  pointer(window, "pointerup", centerBox.right - 20, centerBox.top + centerBox.height / 2);
  await sleep(120);
  check(
    JSON.stringify(sessionIds()) === JSON.stringify(["aaa-111", "bbb-222"]),
    `dragging a tab below the strip splits the conversation area (got ${JSON.stringify(sessionIds())})`,
  );

  const result = document.getElementById("result");
  if (result) {
    result.textContent = `${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}\n\n${notes.join(
      "\n",
    )}${failures.length > 0 ? `\n\nfailed:\n${failures.map((item) => `- ${item}`).join("\n")}` : ""}`;
  }
  (window as unknown as { __splitFixture?: unknown }).__splitFixture = {
    failures,
    notes,
  };
}

main().catch((error: unknown) => {
  const result = document.getElementById("result");
  if (result)
    result.textContent = `THREW\n\n${String(error)}\n\nfailed (${failures.length}):\n${failures.map((item) => `- ${item}`).join("\n")}\n\n${notes.join("\n")}`;
  // eslint-disable-next-line no-console
  console.error(error);
});
