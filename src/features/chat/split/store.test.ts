import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store";
import { sessionKey, type ActiveSession } from "../store/persistence";
import {
  installSplitSync,
  reconcileLayout,
  SPLIT_LAYOUT_KEY,
  useSplitStore,
} from "./store";
import { listPanes, makeBranch, makePane, solePane } from "./tree";

function session(id: string | null, workspacePath = "/repo", engine = "claude"): ActiveSession {
  return { engine, sessionId: id, workspacePath };
}

function ids(root = useSplitStore.getState().root) {
  return listPanes(root).map((pane) => pane.session?.sessionId ?? null);
}

let focusTab: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useSplitStore.setState({ root: null, focusedPaneId: null });
  focusTab = vi.fn();
  useChatStore.setState({
    active: session("a"),
    openTabs: [session("a"), session("b"), session("c")],
    focusTab: focusTab as never,
  });
});

describe("reconcileLayout", () => {
  const a = makePane(session("a"));
  const b = makePane(session("b"));
  const root = makeBranch("row", a, b);
  const chat = { active: session("a"), openTabs: [session("a"), session("b"), session("c")] };

  it("drops panes whose tab is gone and collapses to single view", () => {
    const next = reconcileLayout(
      { root, focusedPaneId: b.id, lastActiveKey: "claude/a" },
      { active: session("c"), openTabs: [session("a"), session("c")] },
    );
    // b 的页签没了 → 摘掉 b，只剩 a 一格 → 回单栏。
    expect(next.root).toBeNull();
    expect(next.focusedPaneId).toBeNull();
  });

  it("focuses the pane holding the newly activated session", () => {
    const next = reconcileLayout(
      { root, focusedPaneId: a.id, lastActiveKey: "claude/a" },
      chat,
    );
    // active 没变：不动焦点。
    expect(next.focusedPaneId).toBe(a.id);
    const moved = reconcileLayout(
      { root, focusedPaneId: a.id, lastActiveKey: "claude/a" },
      { ...chat, active: session("b") },
    );
    expect(moved.focusedPaneId).toBe(b.id);
  });

  it("drops a session that is not tiled into the focused pane", () => {
    const next = reconcileLayout(
      { root, focusedPaneId: a.id, lastActiveKey: "claude/a" },
      { ...chat, active: session("c") },
    );
    expect(next.focusedPaneId).toBe(a.id);
    expect(listPanes(next.root!)[0].session?.sessionId).toBe("c");
  });

  it("moves a pending draft into its real session without duplicating", () => {
    const draft = makePane(session(null));
    const other = makePane(session("b"));
    const draftRoot = makeBranch("row", draft, other);
    const next = reconcileLayout(
      { root: draftRoot, focusedPaneId: other.id, lastActiveKey: sessionKey("claude", null, "/repo") },
      { active: session("a"), openTabs: [session("a"), session("b")] },
    );
    expect(ids(next.root)).toEqual(["a", "b"]);
    expect(next.focusedPaneId).toBe(listPanes(next.root!)[0].id);
  });

  it("leaves a single-pane tree alone", () => {
    const next = reconcileLayout(
      { root: null, focusedPaneId: null, lastActiveKey: "claude/a" },
      chat,
    );
    expect(next).toEqual({ root: null, focusedPaneId: null, lastActiveKey: "claude/a" });
  });
});

describe("split store actions", () => {
  it("splits the single view into two panes", () => {
    useSplitStore.getState().splitPane("solo", "col");
    expect(ids()).toEqual(["a", null]);    const { root, focusedPaneId } = useSplitStore.getState();
    expect(listPanes(root)[1].id).toBe(focusedPaneId);
    expect(JSON.parse(localStorage.getItem(SPLIT_LAYOUT_KEY) ?? "{}").root).toBeTruthy();
  });

  it("drops a session onto a pane edge by splitting it", () => {
    useSplitStore.setState({ root: null, focusedPaneId: null });
    useSplitStore.getState().dropSession("solo", "right", session("b"));
    expect(ids()).toEqual(["a", "b"]);
    expect(focusTab).toHaveBeenCalledWith("claude", "b", "/repo");
  });

  it("dropping the displayed session onto an edge leaves an empty pane", () => {
    useSplitStore.getState().dropSession("solo", "bottom", session("a"));
    expect(ids()).toEqual(["a", null]);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("moves a tiled session between panes instead of duplicating it", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: left.id,
    });
    useSplitStore.getState().dropSession(left.id, "center", session("b"));
    // b 从右格搬到左格：原格子清空，不是复制两份。
    expect(ids()).toEqual(["b", null]);
    expect(useSplitStore.getState().focusedPaneId).toBe(left.id);
  });

  it("swaps contents when a pane is dropped on another pane's center", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: left.id,
    });
    useSplitStore.getState().dropPane(left.id, right.id, "center");
    expect(ids()).toEqual(["b", "a"]);
  });

  it("closing a pane keeps its tab and returns to single view at the last pane", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: right.id,
    });
    useSplitStore.getState().closePane(left.id);
    expect(useSplitStore.getState().root).toBeNull();
    // 会话仍留在页签里：只动了布局，没有关会话。
    expect(useChatStore.getState().openTabs).toHaveLength(3);
    expect(localStorage.getItem(SPLIT_LAYOUT_KEY)).toBeNull();
  });

  it("focusing an empty pane does not steal the active session", () => {
    const left = makePane(session("a"));
    const empty = makePane(null);
    useSplitStore.setState({
      root: makeBranch("row", left, empty),
      focusedPaneId: left.id,
    });
    useSplitStore.getState().focusPane(empty.id);
    expect(useSplitStore.getState().focusedPaneId).toBe(empty.id);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("focusing a pane activates its session", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: left.id,
    });
    useSplitStore.getState().focusPane(right.id);
    expect(focusTab).toHaveBeenCalledWith("claude", "b", "/repo");
  });

  it("resetLayout returns to single view", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: left.id,
    });
    useSplitStore.getState().resetLayout();
    expect(useSplitStore.getState().root).toBeNull();
    expect(solePane(useSplitStore.getState().root)).toBeNull();
  });
});

describe("installSplitSync", () => {
  it("keeps the layout aligned with tab closes", () => {
    const left = makePane(session("a"));
    const right = makePane(session("b"));
    useSplitStore.setState({
      root: makeBranch("row", left, right),
      focusedPaneId: left.id,
    });
    installSplitSync();
    // 关闭 b 的页签：b 的格子跟着消失，只剩 a → 回单栏。
    useChatStore.setState({
      active: session("a"),
      openTabs: [session("a")],
    });
    expect(useSplitStore.getState().root).toBeNull();
  });
});
