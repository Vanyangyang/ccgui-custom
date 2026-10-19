import { beforeEach, describe, expect, it } from "vitest";
import { rememberContextWindow } from "@/features/chat/context-window-memory";
import { LEADER_HIGH_CONTEXT_PERCENT, leaderContextInfo, leaderDeadlineInfo, leaderRenewSeconds } from "./branch-health";
import type { LeaderBranch } from "./types";

const child: LeaderBranch = {
  id: "child", parentEngine: "claude", parentSessionId: "root", workspacePath: "/workspace", engine: "codex", sessionId: "child",
  title: "task", task: "assignment", model: "model", effort: null, runId: null, state: "completed", createdAt: 1,
  updatedAt: 2, lastActivityAt: 2, deadlineAt: 100, expired: true, result: "", resultTruncated: false, error: null,
};
const sample = (total: number, window?: number) => ({ usage: { input_tokens: total, model_context_window: window }, fetchedAt: 123 });
beforeEach(() => localStorage.clear());

describe("Leader TTL and context guidance", () => {
  it("keeps AGY billing and last-prompt tokens separate from current occupancy", () => {
    const agy = { ...child, engine: "agy" };
    for (const usage of [
      { input_tokens: 900_000, model_context_window: 1_000_000 },
      { context_usage_kind: "last_prompt", context_usage: { input_tokens: 900_000 }, model_context_window: 1_000_000 },
    ]) {
      const context = leaderContextInfo({ branch: agy, cachedUsage: usage });
      expect(context.tokens).toBeUndefined(); expect(context.percent).toBeUndefined();
      expect(context.max).toBe(1_000_000); expect(context.suggestCompact).toBe(false);
    }
    const context = leaderContextInfo({ branch: agy, cachedUsage: {
      context_usage_kind: "current_context", context_usage: { input_tokens: 750_000 }, model_context_window: 1_000_000,
    } });
    expect(context.tokens).toBe(750_000); expect(context.percent).toBe(75);
    expect(context.suggestCompact).toBe(false);
  });
  it.each([
    [false, 10_000, 80, false],
    [true, 100, 49, false],
    [true, 100, 49.99, false],
    [true, 100, 50, true],
    [true, 100, 99, true],
  ])("requires expiry (%s) and exact usage %s/%s to suggest compaction", (expired, deadlineAt, percent, expected) => {
    expect(LEADER_HIGH_CONTEXT_PERCENT).toBe(50);
    const context = leaderContextInfo({ branch: { ...child, expired, deadlineAt }, sample: sample(percent * 100, 10_000), now: 1000 });
    expect(context.suggestCompact).toBe(expected);
  });
  it("may display rounded 50% while keeping 49.99% below the suggestion threshold", () => {
    const context = leaderContextInfo({ branch: child, sample: sample(4999, 10_000) });
    expect(context.percent).toBe(50); expect(context.suggestCompact).toBe(false);
  });
  it("keeps a recently elapsed deadline available even before the native checkpoint flag updates", () => {
    expect(leaderDeadlineInfo({ ...child, expired: false }, 100)).toEqual({ known: true, expired: true });
    expect(leaderDeadlineInfo({ ...child, deadlineAt: Number.NaN, expired: false })).toEqual({ known: false, expired: false });
  });
  it("immediately removes expiry and guidance after renewal", () => {
    const context = leaderContextInfo({ branch: { ...child, expired: false, deadlineAt: 2000 }, sample: sample(8000, 10_000), now: 1000 });
    expect(context.suggestCompact).toBe(false);
  });
  it("does not use the assumed 200K window when no capacity was reported", () => {
    const context = leaderContextInfo({ branch: child, sample: sample(190_000) });
    expect(context.max).toBeUndefined(); expect(context.percent).toBeUndefined(); expect(context.suggestCompact).toBe(false);
  });
  it("does not use live billed tokens when a reliable historical numerator is unavailable", () => {
    const context = leaderContextInfo({ branch: child, cachedUsage: { input_tokens: 900_000, model_context_window: 1_000_000 } });
    expect(context.tokens).toBeUndefined(); expect(context.max).toBe(1_000_000); expect(context.suggestCompact).toBe(false);
  });
  it("ignores Codex cumulative billing when a latest-request report exists", () => {
    const context = leaderContextInfo({ branch: child, sample: { usage: { info: { model_context_window: 1_000_000,
      total_token_usage: { input_tokens: 9_000_000 }, last_token_usage: { input_tokens: 20_000, output_tokens: 1000 } } }, fetchedAt: 123 } });
    expect(context.tokens).toBe(21_000); expect(context.percent).toBe(2); expect(context.suggestCompact).toBe(false);
  });
  it("does not replace a latest unknown Codex snapshot with older cached high billing", () => {
    const context = leaderContextInfo({ branch: child, sample: { usage: { info: { model_context_window: 1_000_000, total_token_usage: { input_tokens: 9_000_000 } } }, fetchedAt: 123 },
      cachedUsage: { input_tokens: 800_000, model_context_window: 1_000_000 } });
    expect(context.tokens).toBeUndefined(); expect(context.source).toBe("history"); expect(context.suggestCompact).toBe(false);
  });
  it("uses Claude's latest individual request, including cache occupancy, instead of its turn bill", () => {
    const context = leaderContextInfo({ branch: { ...child, engine: "claude" }, sample: { usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 3500 }, fetchedAt: 123 },
      cachedUsage: { input_tokens: 900_000, model_context_window: 1_000_000 }, claudeConfigKnown: true, claudeWindow: 750_000 });
    expect(context.tokens).toBe(25_000); expect(context.percent).toBe(3); expect(context.suggestCompact).toBe(false);
    expect(context.source).toBe("history"); expect(context.fetchedAt).toBe(123);
  });
  it.each([[1_000_000, 750_000, 375_000], [200_000, 200_000, 100_000]])("applies Claude reported window %s and 750K preference consistently", (reported, effective, tokens) => {
    const context = leaderContextInfo({ branch: { ...child, engine: "claude" }, sample: sample(tokens, reported), claudeConfigKnown: true, claudeWindow: 750_000 });
    expect(context.max).toBe(effective); expect(context.percent).toBe(50); expect(context.suggestCompact).toBe(true);
  });
  it("uses an explicit Claude 750K setting instead of limiting it by the unverified 200K assumption", () => {
    const context = leaderContextInfo({ branch: { ...child, engine: "claude" }, sample: sample(375_000), claudeConfigKnown: true, claudeWindow: 750_000 });
    expect(context.max).toBe(750_000); expect(context.suggestCompact).toBe(true);
  });
  it("shows unknown effective capacity if Claude configuration cannot be read", () => {
    const context = leaderContextInfo({ branch: { ...child, engine: "claude" }, sample: sample(900_000, 1_000_000), claudeConfigKnown: false });
    expect(context.max).toBeUndefined(); expect(context.suggestCompact).toBe(false);
  });
  it("reuses a reported window only for the matching engine and model", () => {
    rememberContextWindow("codex", "model", 1_000_000);
    expect(leaderContextInfo({ branch: child, sample: sample(600_000) }).suggestCompact).toBe(true);
    expect(leaderContextInfo({ branch: { ...child, model: "other" }, sample: sample(600_000) }).max).toBeUndefined();
    expect(leaderContextInfo({ branch: { ...child, engine: "claude" }, sample: sample(600_000), claudeConfigKnown: true }).max).toBeUndefined();
  });
  it("rejects malformed negative and infinite token counts", () => {
    for (const tokens of [-50, Number.POSITIVE_INFINITY]) {
      const context = leaderContextInfo({ branch: child, sample: sample(tokens, 100) });
      expect(context.tokens).toBeUndefined(); expect(context.suggestCompact).toBe(false);
    }
  });
  it.each([["", undefined], [" ", undefined], ["60", 3600], ["30", 1800], ["45", 2700], ["0", null], ["1441", null], ["1.5", null], ["invalid", null]] as const)("validates renewal override %s", (value, expected) => {
    expect(leaderRenewSeconds(value)).toBe(expected);
  });
});
