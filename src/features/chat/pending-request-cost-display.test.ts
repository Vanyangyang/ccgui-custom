import { describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { pendingRequestCostLines } from "./pending-request-cost-display";
import type { HostTaskRequestCostEstimate } from "@ccgui/plugin-sdk";

const estimate = (): HostTaskRequestCostEstimate => ({ method: "utf8-quarter-to-byte-v1",
  textCharacters: 6, textUtf8Bytes: 12, textTokens: { lower: 3, upper: 12 }, imageCount: 0,
  contextBasis: "last_request", contextTokens: 326963, inputTokens: { lower: 326966, upper: 326975 },
  pricing: { basis: "api_standard_reference", model: "gemini-4-argon", sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing#gemini-4-argon",
    checkedAt: "2026-10-28", effectiveFrom: Date.UTC(2026, 9, 28), effectiveUntil: Date.UTC(2026, 11, 1),
    inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 10 },
  inputUsd: { lower: 0.0327023, upper: 0.65395 } });

describe("pending request cost evidence display", () => {
  it("separates the exact pending text and conditional history from the bill", () => {
    const text = pendingRequestCostLines(estimate(), i18n.getFixedT("zh")).join("\n");
    expect(text).toContain("6 字符"); expect(text).toContain("3–12 tokens");
    expect(text).toContain("326,966–326,975"); expect(text).toContain("假设上次请求的上下文未压缩或增加");
    expect(text).toContain("$0.0327–$0.6540"); expect(text).toContain("API 标价参考");
    expect(text).toContain("不是账单或总费用上限"); expect(text).toContain("输出及思考长度未知");
    expect(text).toContain("2026-10-28"); expect(text).toContain("ai.google.dev");
  });
  it("does not turn missing price, context or attachments into zero", () => {
    const value = estimate(); delete value.pricing; delete value.inputUsd; delete value.imageCount;
    delete value.inputTokens; delete value.contextTokens; value.contextBasis = "unknown"; value.unavailableReason = "model_price_unverified";
    const text = pendingRequestCostLines(value, i18n.getFixedT("zh")).join("\n");
    expect(text).toContain("缺少当前上下文"); expect(text).toContain("附件数量未知");
    expect(text).toContain("缺少此模型已核实的单价"); expect(text).not.toContain("$0");
    expect(text).toContain("Handoff");
  });
  it("labels current context separately and does not imply cache-hit certainty", () => {
    const value = estimate(); value.contextBasis = "current_context";
    const text = pendingRequestCostLines(value, i18n.getFixedT("en")).join("\n");
    expect(text).toContain("reported current context"); expect(text).toContain("Cache reuse is unconfirmed");
    expect(text).not.toContain("unchanged since the last request");
  });
});
