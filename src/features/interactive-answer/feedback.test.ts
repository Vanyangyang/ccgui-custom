import { describe, expect, it } from "vitest";
import { answerOriginMatches, parameterFeedback } from "./feedback";
const identity = (key: string) => JSON.stringify([JSON.stringify([key, 42]), 100]);
describe("parameter feedback provenance", () => {
  it("matches exact originating pane, never a different focused/active conversation", () => {
    expect(answerOriginMatches(identity("codex/origin"), "codex/origin")).toBe(true);
    expect(answerOriginMatches(identity("codex/origin"), "codex/other-active")).toBe(false);
  });
  it.each([undefined, "bad", "[]", '["bad",0]', JSON.stringify([JSON.stringify(["codex/origin", -1]), 0]), identity("new:codex:path")])("rejects missing or malformed origin %s", value => {
    expect(answerOriginMatches(value, "codex/origin")).toBe(false);
  });
  it("bounds attributed parameters and refuses unsupported values", () => {
    const text = parameterFeedback(identity("codex/origin"), "a".repeat(64), { $n: 0, $b: false, $s: "中🙂" }, "Continue");
    expect(text).toContain('"sourceSha256"');
    expect(text).toContain('"$n":0');
    expect(text).toContain("codex/origin");
    expect(parameterFeedback("id", "bad", {}, "Continue")).toBeNull();
    expect(parameterFeedback("id", "a".repeat(64), { $n: NaN }, "Continue")).toBeNull();
    expect(parameterFeedback("id", "a".repeat(64), { $s: "x".repeat(257) }, "Continue")).toBeNull();
  });
});
