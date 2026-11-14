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
    expect(restored.getComposerPrediction("codex/a")).toBe("验证重启恢复🙂");
    expect(restored.getComposerPrediction("agy/b")).toBe("继续检查另一个会话");
    expect(restored.getComposerPrediction("claude/a")).toBeNull();
    expect(predictNextPrompt).toHaveBeenCalledTimes(2);
  });

  it.each(["accepted/dismissed", "new turn", "empty suggestion", "disabled", "clear all"])(
    "does not resurrect a suggestion after %s and restart",
    async (action) => {
      const first = await restart();
      first.setComposerPrediction("codex/a", "继续验证🙂");
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
    first.setComposerPrediction("codex/a", "保留这个会话");
    const second = await restart();
    second.setComposerPrediction("agy/b", "保存另一个会话");
    second.clearComposerPrediction("codex/a");
    const third = await restart();
    expect(third.getComposerPrediction("codex/a")).toBeNull();
    expect(third.getComposerPrediction("agy/b")).toBe("保存另一个会话");
  });

  it("persists draft identity migration and preserves an existing target suggestion", async () => {
    const current = await restart();
    current.setComposerPrediction("new:codex:G:/repo", "从草稿迁移🙂");
    const restored = await restart();
    restored.migrateComposerPredictionSessionKey("new:codex:G:/repo", "codex/a");
    restored.setComposerPrediction("new:codex:G:/other", "不能覆盖目标");
    restored.migrateComposerPredictionSessionKey("new:codex:G:/other", "codex/a");
    const next = await restart();
    expect(next.getComposerPrediction("new:codex:G:/repo")).toBeNull();
    expect(next.getComposerPrediction("new:codex:G:/other")).toBeNull();
    expect(next.getComposerPrediction("codex/a")).toBe("从草稿迁移🙂");
  });

  it("bounds retained suggestions and keeps the most recently generated ones", async () => {
    const current = await restart();
    for (let i = 0; i <= 200; i++) current.setComposerPrediction(`codex/${i}`, `检查会话 ${i}`);
    const restored = await restart();
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      ["codex/a", "保留正常预测🙂"],
      ["agy/empty", "  "],
      ["agy/multiline", "第一行\n第二行"],
      ["agy/long", "x".repeat(241)],
      ["agy/bad", { text: "不是字符串" }],
      null,
    ]));
    const restored = await restart();
    expect(restored.getComposerPrediction("codex/a")).toBe("保留正常预测🙂");
    for (const key of ["agy/empty", "agy/multiline", "agy/long", "agy/bad"]) {
      expect(restored.getComposerPrediction(key)).toBeNull();
    }
  });

  it.each(["{broken", '{"unsupported":true}', '[["codex/a",123]]'])(
    "ignores invalid stored data: %s",
    async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);
      const current = await restart();
      expect(current.getComposerPrediction("codex/a")).toBeNull();
      current.setComposerPrediction("codex/b", "恢复正常保存");
      const restored = await restart();
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
});
