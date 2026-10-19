import { describe, expect, it } from "vitest";
import { paginateThreads } from "./repo-pagination";
import type { AiChatThread } from "./sidebar-types";

function threads(count: number): AiChatThread[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `codex/${index}`,
    label: `t${index}`,
    time: "1m",
  }));
}

describe("paginateThreads", () => {
  it("page 0 只露出 threadLimit 条,不因选中较旧会话而拉长", () => {
    const result = paginateThreads(threads(12), 5, 0);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      "codex/0",
      "codex/1",
      "codex/2",
      "codex/3",
      "codex/4",
    ]);
    expect(result.hiddenCount).toBe(7);
  });

  it("page 1 追加一页,page 2 展示全部", () => {
    expect(paginateThreads(threads(12), 5, 1).visibleThreads).toHaveLength(12);
    expect(paginateThreads(threads(80), 5, 1).visibleThreads).toHaveLength(55);
    expect(paginateThreads(threads(80), 5, 2).hiddenCount).toBe(0);
  });
});
