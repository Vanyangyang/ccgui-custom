import { describe, expect, it } from "vitest";
import type { ActiveSession } from "../store/persistence";
import {
  clampRatio,
  dropZoneAt,
  findPane,
  layoutGeometry,
  listPanes,
  makeBranch,
  makePane,
  movePane,
  parsePersistedLayout,
  removePane,
  serializeLayout,
  setBranchRatio,
  solePane,
  splitPaneWith,
  swapPaneSessions,
  updatePaneSession,
  type LayoutNode,
} from "./tree";

function session(id: string): ActiveSession {
  return { engine: "claude", sessionId: id, workspacePath: "/repo" };
}

/** 两个格子的树：A | B（左右切分）。 */
function twoPanes(): { root: LayoutNode; a: string; b: string } {
  const a = makePane(session("a"));
  const b = makePane(session("b"));
  return { root: makeBranch("row", a, b), a: a.id, b: b.id };
}

function sessionsOf(root: LayoutNode | null) {
  return listPanes(root).map((pane) => pane.session?.sessionId ?? null);
}

describe("splitPaneWith", () => {
  it("puts a new pane before/after the target", () => {
    const { root, a, b } = twoPanes();
    const left = makePane(session("c"));
    expect(sessionsOf(splitPaneWith(root, a, "before", "row", left))).toEqual([
      "c",
      "a",
      "b",
    ]);
    const right = makePane(session("d"));
    const after = splitPaneWith(root, b, "after", "col", right) as LayoutNode;
    expect(sessionsOf(after)).toEqual(["a", "b", "d"]);
    // 切分方向落在新分支上：向下切分是 col。
    const branch = (after as { second: { direction: string } }).second;
    expect(branch.direction).toBe("col");
  });

  it("keeps other panes' node identity (no needless remounts)", () => {
    const { root, a } = twoPanes();
    const next = splitPaneWith(root, a, "after", "row", makePane(session("c")));
    expect(listPanes(next)[2].session?.sessionId).toBe("b");
    // b 的节点对象保持同一引用。
    expect(findPane(next, listPanes(root)[1].id)).toBe(listPanes(root)[1]);
  });
});

describe("removePane", () => {
  it("collapses the parent branch and returns the sibling", () => {
    const { root, a, b } = twoPanes();
    const rest = removePane(root, a);
    expect(solePane(rest)?.id).toBe(b);
    expect(solePane(removePane(root, b))?.id).toBe(a);
  });

  it("returns null when the last pane goes away", () => {
    const { root, a } = twoPanes();
    const rest = removePane(root, a);
    const only = solePane(rest);
    expect(only).not.toBeNull();
    expect(removePane(rest!, only!.id)).toBeNull();
  });

  it("keeps the tree untouched for an unknown id", () => {
    const { root } = twoPanes();
    expect(removePane(root, "nope")).toBe(root);
  });
});

describe("movePane", () => {
  it("re-inserts the pane next to its new target", () => {
    const { root, a, b } = twoPanes();
    const moved = movePane(root, a, b, "left");
    expect(sessionsOf(moved)).toEqual(["a", "b"]);
    const swapped = movePane(root, a, b, "bottom");
    expect(sessionsOf(swapped)).toEqual(["b", "a"]);
  });

  it("is a no-op for self drops or unknown panes", () => {
    const { root, a } = twoPanes();
    expect(movePane(root, a, a, "left")).toBe(root);
    expect(movePane(root, a, "nope", "left")).toBe(root);
  });
});

describe("swapPaneSessions / updatePaneSession / setBranchRatio", () => {
  it("swaps pane contents", () => {
    const { root, a, b } = twoPanes();
    expect(sessionsOf(swapPaneSessions(root, a, b))).toEqual(["b", "a"]);
  });

  it("keeps the tree reference when nothing changes", () => {
    const { root, a } = twoPanes();
    const pane = findPane(root, a)!;
    expect(updatePaneSession(root, a, pane.session)).toBe(root);
  });

  it("clamps ratios and ignores unknown branches", () => {
    const { root } = twoPanes();
    const branchId = (root as { id: string }).id;
    expect((setBranchRatio(root, branchId, 4) as { ratio: number }).ratio).toBe(0.88);
    expect((setBranchRatio(root, branchId, -1) as { ratio: number }).ratio).toBe(0.12);
    expect(setBranchRatio(root, "nope", 0.3)).toBe(root);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe("layoutGeometry", () => {
  it("splits the container rect by ratio", () => {
    const { root } = twoPanes();
    const { panes, dividers } = layoutGeometry(
      setBranchRatio(root, (root as { id: string }).id, 0.25),
    );
    expect(panes.map((p) => p.rect)).toEqual([
      { x: 0, y: 0, w: 0.25, h: 1 },
      { x: 0.25, y: 0, w: 0.75, h: 1 },
    ]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].rect).toEqual({ x: 0.25, y: 0, w: 0, h: 1 });
    expect(dividers[0].branchRect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("dropZoneAt", () => {
  const rect = { x: 0, y: 0, w: 800, h: 600 };

  it("maps the center to center", () => {
    expect(dropZoneAt(rect, 400, 300)).toBe("center");
  });

  it("maps edges to their side", () => {
    expect(dropZoneAt(rect, 10, 300)).toBe("left");
    expect(dropZoneAt(rect, 790, 300)).toBe("right");
    expect(dropZoneAt(rect, 400, 5)).toBe("top");
    expect(dropZoneAt(rect, 400, 595)).toBe("bottom");
  });

  it("keeps the edge band usable in a narrow pane", () => {
    const narrow = { x: 0, y: 0, w: 200, h: 400 };
    expect(dropZoneAt(narrow, 30, 200)).toBe("left");
    expect(dropZoneAt(narrow, 100, 200)).toBe("center");
  });
});

describe("parsePersistedLayout", () => {
  it("round-trips a valid layout", () => {
    const { root, a } = twoPanes();
    const parsed = parsePersistedLayout(JSON.parse(serializeLayout(root, a)));
    expect(parsed).not.toBeNull();
    expect(sessionsOf(parsed!.root)).toEqual(["a", "b"]);
    expect(listPanes(parsed!.root).some((pane) => pane.id === parsed!.focusedPaneId)).toBe(true);
  });

  it("rejects a single-pane or malformed layout", () => {
    expect(parsePersistedLayout(null)).toBeNull();
    expect(parsePersistedLayout({ root: { kind: "pane", id: "p", session: null } })).toBeNull();
    expect(parsePersistedLayout({ root: { kind: "split", direction: "row" } })).toBeNull();
    expect(parsePersistedLayout({ root: { kind: "split", direction: "row", ratio: 0.5, first: { kind: "pane", id: "a", session: { engine: 1 } }, second: { kind: "pane", id: "b", session: null } } })).toBeNull();
  });

  it("falls back to the first pane when the focused id is unknown", () => {
    const { root } = twoPanes();
    const parsed = parsePersistedLayout({ root, focusedPaneId: "gone" });
    // 解析会重新生成格子 id，所以基准取自解析后的树。
    expect(parsed!.focusedPaneId).toBe(listPanes(parsed!.root)[0].id);
  });
});
