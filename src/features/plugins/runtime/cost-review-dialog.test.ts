import { describe, expect, it } from "vitest";
import type { HostTaskCostApproval } from "@ccgui/plugin-sdk";
import i18n from "@/lib/i18n";
import { costReviewDialogTelemetry } from "./cost-review-dialog";

const approval = (): HostTaskCostApproval => ({
  id: "held", requestId: "held-request", sender: { engine: "codex", sessionId: "coordinator", workspacePath: "G:/game" },
  target: { engine: "agy", sessionId: "child", workspacePath: "G:/game" }, message: "resume", truncated: false,
  model: "gemini", cacheHeat: "unknown", usageKind: "unknown", capturedAt: 1, canHandoff: true,
});

describe("cost review confirmation evidence", () => {
  it("shows a zero cache-read reference without claiming the current request's expense", () => {
    const card = approval();
    card.cacheReference = { promptTokens: 353093, cacheReadTokens: 0, observedAt: 1, ttlSeconds: 900, maxTtlSeconds: 1200 };
    const text = costReviewDialogTelemetry(card, i18n.getFixedT("zh"));
    expect(text).toContain("353,093"); expect(text).toContain("读取 0 tokens");
    expect(text).toContain("不代表本次用量"); expect(text).toContain("不是本次费用估算");
  });
  it("does not present historical or model-mismatched usage as current occupancy", () => {
    const card = approval();
    Object.assign(card, { used: 50000, max: 100000, usageKind: "last_request", modelMismatch: true, usageModel: "other-model" });
    const text = costReviewDialogTelemetry(card, i18n.getFixedT("zh"));
    expect(text).toContain("最近一次请求：50,000"); expect(text).toContain("other-model");
    expect(text).not.toContain("50%");
  });
  it("does not mistake disabled cache expiry for an expired cache", () => {
    const card = approval(); Object.assign(card, { cacheExpiryDisabled: true, cacheHeat: "cold" });
    const text = costReviewDialogTelemetry(card, i18n.getFixedT("zh"));
    expect(text).toContain("不按时间判断缓存过期");
    expect(text).not.toContain("已超出预计缓存保留窗口");
  });
});
