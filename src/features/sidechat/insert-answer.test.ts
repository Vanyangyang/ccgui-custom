import { describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  state: {
    drafts: { "codex/parent": "尚未发送的草稿🙂" } as Record<string, string>,
    openTabs: [{ engine: "codex", sessionId: "parent", workspacePath: "/workspace" }],
    setDraft: vi.fn(), send: vi.fn(),
  },
}));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => fixture.state } }));
import { insertSideAnswer } from "./insert-answer";

describe("explicit sidechat insertion", () => {
  it("appends to the current draft without sending or rewriting the answer", () => {
    const text = "回答🙂\n\n```ts\nconst a = 1;\n```";
    insertSideAnswer("codex/parent", text);
    expect(fixture.state.setDraft).toHaveBeenCalledWith("codex/parent", `尚未发送的草稿🙂\n\n${text}`);
    expect(fixture.state.send).not.toHaveBeenCalled();
  });
  it("leaves the draft alone for an empty answer", () => {
    fixture.state.setDraft.mockClear();
    insertSideAnswer("codex/parent", "   ");
    expect(fixture.state.setDraft).not.toHaveBeenCalled();
  });
});
