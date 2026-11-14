import { beforeEach, describe, expect, it, vi } from "vitest";

const { predictNextPrompt } = vi.hoisted(() => ({ predictNextPrompt: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { predictNextPrompt } }));

const STORAGE_KEY = "ccgui-next.composerPredictions:v1";
const messages = [
  { seq: 1, ts: null, role: "user", text: "检查输入框恢复" },
  { seq: 2, ts: null, role: "assistant", text: "已完成，需要验证重启吗？" },
];

// A new module instance models the loss of process memory while keeping the
// same WebView localStorage, without adding a test-only production reset API.
async function restart() {
  vi.resetModules();
  return import("./composer-prediction");
}

describe("composer prediction persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    predictNextPrompt.mockReset();
  });

  it("restores generated Chinese/emoji suggestions per session without another model call", async () => {
    const current = await restart();
    predictNextPrompt.mockResolvedValueOnce("验证重启恢复🙂").mockResolvedValueOnce("继续检查另一个会话");
    current.requestComposerPrediction("codex/a", messages);
    current.requestComposerPrediction("agy/b", messages);
    await Promise.resolve();
    const restored = await restart();
    expect(restored.getComposerPrediction("codex/a")).toBeNull();
    restored.reconcileComposerPrediction("codex/a", messages);
    restored.reconcileComposerPrediction("agy/b", messages);
    expect(restored.getComposerPrediction("codex/a")).toBe("验证重启恢复🙂");
    expect(restored.getComposerPrediction("agy/b")).toBe("继续检查另一个会话");
    expect(restored.getComposerPrediction("claude/a")).toBeNull();
    expect(predictNextPrompt).toHaveBeenCalledTimes(2);
  });

  it.each(["accepted/dismissed", "new turn", "empty suggestion", "disabled", "clear all"])(
    "does not resurrect a suggestion after %s and restart",
    async (action) => {
      const first = await restart();
      first.setComposerPrediction("codex/a", "继续验证🙂", messages);
      // The first operation after boot may be a clear, before any UI getter.
      const current = await restart();
      if (action === "accepted/dismissed") current.clearComposerPrediction("codex/a");
      if (action === "new turn") current.clearComposerPrediction("codex/a", { resetTurn: true });
      if (action === "empty suggestion") current.setComposerPrediction("codex/a", null);
      if (action === "disabled") current.setComposerPredictionEnabled(false);
      if (action === "clear all") current.clearAllComposerPredictions();
      const restored = await restart();
      restored.setComposerPredictionEnabled(true);
      expect(restored.getComposerPrediction("codex/a")).toBeNull();
    },
  );

  it("loads existing entries before saving or clearing a different session", async () => {
    const first = await restart();
    first.setComposerPrediction("codex/a", "保留这个会话", messages);
    const second = await restart();
    second.setComposerPrediction("agy/b", "保存另一个会话", messages);
    second.clearComposerPrediction("codex/a");
    const third = await restart();
    third.reconcileComposerPrediction("agy/b", messages);
    expect(third.getComposerPrediction("codex/a")).toBeNull();
    expect(third.getComposerPrediction("agy/b")).toBe("保存另一个会话");
  });

  it("persists draft identity migration and preserves an existing target suggestion", async () => {
    const current = await restart();
    current.setComposerPrediction("new:codex:G:/repo", "从草稿迁移🙂", messages);
    const restored = await restart();
    restored.migrateComposerPredictionSessionKey("new:codex:G:/repo", "codex/a");
    restored.setComposerPrediction("new:codex:G:/other", "不能覆盖目标", messages);
    restored.migrateComposerPredictionSessionKey("new:codex:G:/other", "codex/a");
    const next = await restart();
    next.reconcileComposerPrediction("codex/a", messages);
    expect(next.getComposerPrediction("new:codex:G:/repo")).toBeNull();
    expect(next.getComposerPrediction("new:codex:G:/other")).toBeNull();
    expect(next.getComposerPrediction("codex/a")).toBe("从草稿迁移🙂");
  });

  it("bounds retained suggestions and keeps the most recently generated ones", async () => {
    const current = await restart();
    for (let i = 0; i <= 200; i++) current.setComposerPrediction(`codex/${i}`, `检查会话 ${i}`, messages);
    const restored = await restart();
    restored.reconcileComposerPrediction("codex/1", messages);
    restored.reconcileComposerPrediction("codex/200", messages);
    expect(restored.getComposerPrediction("codex/0")).toBeNull();
    expect(restored.getComposerPrediction("codex/1")).toBe("检查会话 1");
    expect(restored.getComposerPrediction("codex/200")).toBe("检查会话 200");
  });

  it("does not restore pending requests or launch a prediction when reading a saved session", async () => {
    const current = await restart();
    predictNextPrompt.mockReturnValueOnce(new Promise(() => {}));
    current.requestComposerPrediction("codex/a", messages);
    const restored = await restart();
    expect(restored.getComposerPrediction("codex/a")).toBeNull();
    expect(predictNextPrompt).toHaveBeenCalledTimes(1);
  });

  it("filters malformed entries without losing valid suggestions", async () => {
    const current = await restart();
    current.setComposerPrediction("codex/a", "保留正常预测🙂", messages);
    const valid = JSON.parse(localStorage.getItem(STORAGE_KEY)!)[0];
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      valid,
      ["agy/empty", "  ", valid[2]],
      ["agy/multiline", "第一行\n第二行", valid[2]],
      ["agy/long", "x".repeat(241), valid[2]],
      ["agy/bad", { text: "不是字符串" }, valid[2]],
      ["agy/bad-binding", "损坏的回合来源", "not-a-binding"],
      null,
    ]));
    const restored = await restart();
    restored.reconcileComposerPrediction("codex/a", messages);
    expect(restored.getComposerPrediction("codex/a")).toBe("保留正常预测🙂");
    for (const key of ["agy/empty", "agy/multiline", "agy/long", "agy/bad", "agy/bad-binding"]) {
      expect(restored.getComposerPrediction(key)).toBeNull();
    }
  });

  it.each(["{broken", '{"unsupported":true}', '[["codex/a",123]]'])(
    "ignores invalid stored data: %s",
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const current = await restart();
      expect(current.getComposerPrediction("codex/a")).toBeNull();
      current.setComposerPrediction("codex/b", "恢复正常保存", messages);
      const restored = await restart();
      restored.reconcileComposerPrediction("codex/b", messages);
      expect(restored.getComposerPrediction("codex/b")).toBe("恢复正常保存");
    },
  );

  it("keeps prediction available in memory if storage is full", async () => {
    const current = await restart();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    predictNextPrompt.mockResolvedValueOnce("仍可接受当前预测");
    current.requestComposerPrediction("codex/a", messages);
    await Promise.resolve();
    expect(setItem).toHaveBeenCalled();
    expect(current.getComposerPrediction("codex/a")).toBe("仍可接受当前预测");
  });

  it("rejects a saved suggestion when history advanced during the restart", async () => {
    const current = await restart();
    current.setComposerPrediction("agy/a", "之前的建议", messages);
    const restored = await restart();
    restored.reconcileComposerPrediction("agy/a", [...messages,
      { seq: 3, ts: null, role: "user", text: "已经进行了下一轮" },
      { seq: 4, ts: null, role: "assistant", text: "这是新的结果🙂" },
    ]);
    expect(restored.getComposerPrediction("agy/a")).toBeNull();
    predictNextPrompt.mockResolvedValueOnce("检查新的结果");
    const nextMessages = [{ seq: 30, ts: null, role: "user", text: "已经进行了下一轮" },
      { seq: 40, ts: null, role: "assistant", text: "这是新的结果🙂" }];
    restored.requestComposerPrediction("agy/a", nextMessages);
    await Promise.resolve();
    expect(restored.getComposerPrediction("agy/a")).toBe("检查新的结果");
    const next = await restart();
    next.reconcileComposerPrediction("agy/a", nextMessages);
    expect(next.getComposerPrediction("agy/a")).toBe("检查新的结果");
  });

  it("matches the final turn across pagination and timestamp/seq changes without persisting conversation text", async () => {
    const current = await restart();
    predictNextPrompt.mockResolvedValueOnce("下一步验证🙂");
    current.requestComposerPrediction("codex/a", [
      { seq: -3, ts: null, role: "user", text: "更早的问题" },
      { seq: -2, ts: null, role: "assistant", text: "更早的回答" }, ...messages,
    ]);
    await Promise.resolve();
    const raw = localStorage.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain(messages[0].text);
    expect(raw).not.toContain(messages[1].text);
    const restored = await restart();
    restored.reconcileComposerPrediction("codex/a", []);
    expect(restored.getComposerPrediction("codex/a")).toBeNull();
    restored.reconcileComposerPrediction("codex/a", messages.map((row) => ({ ...row, seq: row.seq + 100, ts: "other-time" })));
    expect(restored.getComposerPrediction("codex/a")).toBe("下一步验证🙂");
    restored.requestComposerPrediction("codex/a", messages);
    expect(predictNextPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not restore legacy records that lack their originating turn", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([["agy/a", "无法核对的旧建议"]]));
    const restored = await restart();
    restored.reconcileComposerPrediction("agy/a", messages);
    expect(restored.getComposerPrediction("agy/a")).toBeNull();
    expect(predictNextPrompt).not.toHaveBeenCalled();
  });

  it("revokes a late response when a history refresh replaces its turn", async () => {
    const current = await restart();
    const pending = Promise.withResolvers<string | null>();
    predictNextPrompt.mockReturnValueOnce(pending.promise);
    current.requestComposerPrediction("agy/a", messages);
    current.reconcileComposerPrediction("agy/a", [{ ...messages[0], text: "新的提问" }, { ...messages[1], text: "新的回答" }]);
    pending.resolve("旧轮次的晚到建议");
    await Promise.resolve();
    expect(current.getComposerPrediction("agy/a")).toBeNull();
  });
});
