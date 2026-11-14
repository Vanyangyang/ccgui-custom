import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { formatHandoffError } from "./handoff-error";

const language = i18n.language;
afterEach(async () => { await i18n.changeLanguage(language); });
const legacy = "codex handoff summary timed out [stage=completion; http_status=200; diagnostic_id=diag-123]";

describe("handoff timeout feedback", () => {
  it("explains old errors without inventing duration or remote cancellation", async () => {
    await i18n.changeLanguage("en");
    const message = formatHandoffError(new Error(legacy));
    expect(message).toContain("No complete handoff summary");
    expect(message).toContain("original draft and task are preserved");
    expect(message).toContain("may have incurred charges");
    expect(message).toContain("not guaranteed to have stopped");
    expect(message).toContain("explicitly retry with lower effort or a different model");
    expect(message).not.toContain("waited");
    expect(message.endsWith(legacy)).toBe(true);
  });

  it("localizes an explicit measurement and preserves the entire partial-map diagnostic", async () => {
    await i18n.changeLanguage("zh");
    const raw = `Full handoff segment 1/2: ${legacy.slice(0, -1)}; elapsed_ms=600127; timeout_ms=600000]`;
    const message = formatHandoffError(raw);
    expect(message).toContain("已等待 600.1 秒");
    expect(message).toContain("本次摘要不可用");
    expect(message.endsWith(raw)).toBe(true);
    expect(formatHandoffError(message)).toBe(message);
    await i18n.changeLanguage("en");
    expect(formatHandoffError(message)).toBe(message);
  });

  it.each(["timeout_ms=600000", "elapsed_ms=-1", "elapsed_ms=NaN", "elapsed_ms=Infinity", "elapsed_ms=9007199254740992", "elapsed_ms=1; elapsed_ms=2"])("does not infer elapsed time from %s", async field => {
    await i18n.changeLanguage("en");
    expect(formatHandoffError(`${legacy.slice(0, -1)}; ${field}]`)).not.toContain("waited");
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatHandoffError(new Error("HTTP 503 unavailable"))).toBe("HTTP 503 unavailable");
    expect(formatHandoffError("other task timed out")).toBe("other task timed out");
  });
  it("explains the old intermediate rejection without discarding its diagnostic", async () => {
    await i18n.changeLanguage("zh");
    const raw = "full handoff intermediate summary exceeds 4000 UTF-16 units";
    const result = formatHandoffError(raw);
    expect(result).toContain("中间摘要超过旧版长度限制");
    expect(result).toContain("原始历史、任务和草稿已保留");
    expect(result.endsWith(raw)).toBe(true);
    expect(formatHandoffError(result)).toBe(result);
  });
  it.each(["full handoff reduction did not converge (UTF-16 units 8002; fragments 3; remaining budget 8000)",
    "full handoff model call budget exceeded (1024)", "full handoff intermediate summaries exceed 8 MiB",
    "full handoff merge depth exceeded (8; remaining UTF-16 budget 8000)"])("explains bounded reduction failure: %s", async raw => {
    await i18n.changeLanguage("en");
    const result = formatHandoffError(raw);
    expect(result).toContain("further reduction stopped");
    expect(result).toContain("nothing was handed off or sent");
    expect(result.endsWith(raw)).toBe(true);
    expect(formatHandoffError(result)).toBe(result);
  });
  it("distinguishes preflight anchor capacity from a model call failure", async () => {
    await i18n.changeLanguage("zh");
    const raw = "full handoff summary budget unavailable (remaining UTF-16 budget 1; minimum 12)";
    const result = formatHandoffError(raw);
    expect(result).toContain("本次未调用压缩模型");
    expect(result.endsWith(raw)).toBe(true);
  });
  it.each(["full handoff visible history exceeds 8 MiB (8389123 bytes)", "full handoff visible text exceeds 8 MiB"])("explains input size rejection before any model call: %s", async raw => {
    await i18n.changeLanguage("zh");
    const chinese = formatHandoffError(new Error(raw));
    expect(chinese).toContain("可读文本超过 8 MiB");
    expect(chinese).toContain("本次未调用压缩模型");
    expect(chinese).toContain("原会话、任务和草稿已保留");
    expect(chinese.endsWith(raw)).toBe(true);
    expect(formatHandoffError(chinese)).toBe(chinese);
    await i18n.changeLanguage("en");
    expect(formatHandoffError(chinese)).toBe(chinese);
    const english = formatHandoffError(raw);
    expect(english).toContain("readable text exceeds 8 MiB");
    expect(english).toContain("No compression model was called");
    expect(english.endsWith(raw)).toBe(true);
  });
});
