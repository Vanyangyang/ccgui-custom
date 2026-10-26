import { beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import type { ChatStore } from "./store/types";
import { EMPTY_SESSION } from "./store/stream";
import { sessionKey } from "./store/persistence";
import {
  crossSessionCostReview,
  requiresCrossSessionCostApproval,
  requiresQueueDrainCostApproval,
  requiresSessionSendCostApproval,
  useSessionSendCostGuardStore,
} from "./cross-session-cost";
import { writeAgyReferenceWindow } from "./components/agy-context";

const NOW = 1_800_000_000_000;
function fixture(engine = "claude", usage: unknown = null) {
  const meta = { engine, sessionId: "target", workspacePath: "/workspace", model: "model-a",
    // Archive bytes are deliberately unrelated to current occupancy.
    fileSize: 90_000_000, messageCount: 100_000,
    promptCache: { startedAt: NOW - 1000, observedAt: NOW, ttlSeconds: 3600, source: "anthropic-usage" },
  } as SessionMeta;
  const session = { ...EMPTY_SESSION, usage, messages: [] };
  const state = {
    openTabs: [{ engine, sessionId: meta.sessionId, workspacePath: meta.workspacePath, model: meta.model }],
    bySession: { [sessionKey(engine, meta.sessionId, meta.workspacePath)]: session },
    models: { [engine]: "default-model" },
  } as unknown as ChatStore;
  return { meta, state, session, review: () => crossSessionCostReview(meta, state, "idle", NOW) };
}
beforeEach(() => {
  localStorage.clear();
  useSessionSendCostGuardStore.getState().reset();
});

describe("cross-session cost review telemetry", () => {
  it.each([0, 43920, 49999, 50000])("applies the cross-session threshold to current context %i", (used) => {
    const f = fixture("claude", { input_tokens: used });
    for (const cache of [null, { startedAt: NOW - 7200_000, observedAt: NOW - 7100_000, ttlSeconds: 3600, source: "anthropic-usage" as const },
      { startedAt: NOW - 3595_000, observedAt: NOW - 3594_000, ttlSeconds: 3600, source: "anthropic-usage" as const }]) {
      f.meta.promptCache = cache;
      const review = f.review();
      expect(requiresCrossSessionCostApproval({ ...review, context: { ...review.context, used, kind: "current_context" } })).toBe(used >= 50000);
    }
  });
  it.each([
    { used: undefined }, { used: Number.NaN }, { used: -1 }, { used: Infinity },
    { used: 43920, kind: "last_request" as const }, { used: 43920, kind: "unknown" as const },
    { used: 43920, modelMismatch: true },
  ])("does not exempt unreliable or mismatched context %j", (context) => {
    const f = fixture("claude", { input_tokens: 43920 });
    f.meta.promptCache = null;
    const review = f.review();
    expect(requiresCrossSessionCostApproval({ ...review, context: { ...review.context, ...context } })).toBe(true);
  });
  it("uses last Claude occupancy including cache, never file size or message count", () => {
    const f = fixture("claude", { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 90, context_window: 2000 });
    expect(f.review()).toMatchObject({ model: "model-a", cacheHeat: "hot", capturedAt: NOW,
      context: { used: 1000, max: 2000, kind: "current_context", capacityKnown: true } });
    expect(requiresCrossSessionCostApproval(f.review())).toBe(false);
  });
  it("uses Codex last_token_usage instead of cumulative billing", () => {
    const f = fixture("codex", { info: {
      last_token_usage: { input_tokens: 800, cached_input_tokens: 600, output_tokens: 200 },
      total_token_usage: { input_tokens: 900000, output_tokens: 100000 },
      model_context_window: 4000,
    } });
    expect(f.review().context).toMatchObject({ used: 1000, max: 4000, kind: "current_context" });
  });
  it.each(["gpt-6-astra", "gpt-5.4", " GPT-6-SOL "])("does not gate Codex %s on old or missing cache evidence", (model) => {
    const f = fixture("codex", { info: { last_token_usage: { input_tokens: 270274 }, model_context_window: 570000 } });
    f.meta.model = model;
    f.state.openTabs[0].model = model;
    f.meta.updatedAt = NOW - 30 * 24 * 60 * 60_000;
    for (const cache of [null, { startedAt: NOW - 7200_000, observedAt: NOW - 7100_000, ttlSeconds: 1800, source: "openai-policy" as const }]) {
      f.meta.promptCache = cache;
      for (const status of ["idle", "busy", "awaiting_permission"] as const) {
        const review = crossSessionCostReview(f.meta, f.state, status, NOW);
        expect(requiresSessionSendCostApproval(review, f.meta, f.session, NOW)).toBe(false);
        expect(requiresQueueDrainCostApproval(review)).toBe(false);
        expect(requiresCrossSessionCostApproval(review)).toBe(false);
        expect(review.cache).toBeUndefined();
      }
    }
  });
  it("keeps Codex model-change approval independent of cache age", () => {
    const f = fixture("codex", { info: { last_token_usage: { input_tokens: 270274 } } });
    f.meta.model = "gpt-6-astra";
    f.state.openTabs[0].model = "gpt-6-astra";
    f.session.messages = [{ model: "gpt-6-sol", usage: f.session.usage } as never];
    f.meta.promptCache = null;
    expect(requiresSessionSendCostApproval(f.review(), f.meta, f.session, NOW)).toBe(true);
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
  });
  it.each(["other-model", "gpt-", undefined])("keeps unknown cache guards for Codex model %s", (model) => {
    const f = fixture("codex", { info: { last_token_usage: { input_tokens: 270274 } } });
    f.meta.model = model;
    f.state.openTabs[0].model = model;
    f.state.models.codex = model as never;
    f.meta.promptCache = null;
    f.meta.updatedAt = NOW - 7200_000;
    expect(requiresSessionSendCostApproval(f.review(), f.meta, f.session, NOW)).toBe(true);
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
  });
  it("does not turn missing telemetry or the 200k fallback into a known window", () => {
    const f = fixture();
    expect(f.review().context).toMatchObject({ kind: "unknown", capacityKnown: false });
    expect(f.review().context.used).toBeUndefined();
    expect(f.review().context.max).toBeUndefined();
    f.session.usage = { input_tokens: 500 };
    expect(f.review().context).toMatchObject({ used: 500, capacityKnown: false });
  });
  it("does not turn AGY session billing into current occupancy", () => {
    const f = fixture("agy", { input_tokens: 500000, output_tokens: 90000, session_usage: { input_tokens: 500000 } });
    expect(f.review().context.kind).toBe("unknown");
    expect(f.review().context.used).toBeUndefined();
  });
  it("keeps AGY last request distinct even with a user reference window", () => {
    const f = fixture("agy", { context_usage_kind: "last_prompt", context_usage: { input_tokens: 10000, output_tokens: 1000 } });
    writeAgyReferenceWindow(200000);
    expect(f.review().context).toMatchObject({ used: 11000, max: 200000, kind: "last_request", reference: true });
    f.session.usage = { context_usage_kind: "current_context", context_usage: { input_tokens: 10000, model_context_window: 1000000 } };
    expect(f.review().context).toMatchObject({ used: 10000, max: 1000000, kind: "current_context", reference: false });
  });
  it("uses Cursor measured context, and rejects a billed-only aggregate", () => {
    const f = fixture("cursor", { input_tokens: 2000000, context_usage_kind: "current_context", context_usage: { used_tokens: 50000, context_window: 200000 } });
    f.meta.promptCache = { startedAt: NOW - 1000, observedAt: NOW, ttlSeconds: 300, source: "cursor-policy" };
    expect(f.review()).toMatchObject({ cacheHeat: "hot", cache: { ttlSeconds: 300, source: "cursor-policy" }, context: { used: 50000, max: 200000, kind: "current_context" } });
    expect(requiresCrossSessionCostApproval(f.review())).toBe(false);
    f.meta.promptCache = { ...f.meta.promptCache, startedAt: NOW - 301_000, observedAt: NOW - 300_000 };
    expect(f.review().cacheHeat).toBe("cold");
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
    f.meta.promptCache = null;
    expect(f.review().cacheHeat).toBe("unknown");
    f.session.usage = { input_tokens: 2000000, context_window: 200000 };
    expect(f.review().context.kind).toBe("unknown");
  });
  it("marks an old model's sample as historical, without inheriting its window for the new model", () => {
    const f = fixture("claude", { input_tokens: 50000, context_window: 200000 });
    f.state.bySession[sessionKey(f.meta.engine, f.meta.sessionId, f.meta.workspacePath)].messages = [
      { model: "old-model", usage: f.session.usage } as never,
    ];
    expect(f.review().context).toMatchObject({ used: 50000, kind: "last_request", modelMismatch: true, usageModel: "old-model", capacityKnown: false });
    expect(f.review().context.max).toBeUndefined();
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
  });
  it("pairs retained occupancy with its source model when a newer model only has an empty/error report", () => {
    const f = fixture("claude", { input_tokens: 50000, context_window: 200000 });
    f.state.bySession[sessionKey(f.meta.engine, f.meta.sessionId, f.meta.workspacePath)].messages = [
      { model: "old-model", usage: f.session.usage } as never,
      { model: "model-a", usage: { input_tokens: 0, output_tokens: 0, context_window: 1000000 } } as never,
    ];
    expect(f.review().context).toMatchObject({
      used: 50000, kind: "last_request", usageModel: "old-model", modelMismatch: true, capacityKnown: false,
    });
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
  });
  it("allows hot targets outside the startup margin and requires approval for unknown or elapsed cache", () => {
    const f = fixture();
    for (const targetStatus of ["busy", "awaiting_permission"] as const) {
      expect(requiresCrossSessionCostApproval(crossSessionCostReview(f.meta, f.state, targetStatus, NOW))).toBe(false);
    }
    f.meta.promptCache = null;
    expect(requiresCrossSessionCostApproval(f.review())).toBe(true);
    f.meta.promptCache = { startedAt: NOW - 3500000, observedAt: NOW - 3490000, ttlSeconds: 3600, source: "anthropic-usage" };
    expect(f.review().cacheHeat).toBe("hot");
    expect(requiresCrossSessionCostApproval(f.review())).toBe(false);
    expect(requiresCrossSessionCostApproval(crossSessionCostReview(f.meta, f.state, "idle", NOW + 7200000))).toBe(true);
  });
  it.each([
    [300, 10_001, false], [1800, 60_000, false], [1800, 180_000, false], [3600, 180_000, false],
    [1800, 10_000, true], [3600, 10_000, true], [1800, 499, true], [3600, 1, true],
  ] as const)("uses a fixed startup margin for a %i-second cache with %i ms left (approval=%s)", (ttlSeconds, remainingMs, approval) => {
    const f = fixture();
    f.meta.promptCache = { startedAt: NOW - ttlSeconds * 1000 + remainingMs, observedAt: NOW - ttlSeconds * 1000 + remainingMs,
      ttlSeconds, source: "anthropic-usage" };
    const review = f.review();
    expect(review.cacheHeat).toBe("hot");
    expect(requiresCrossSessionCostApproval(review)).toBe(approval);
  });
  it.each([[10_001, false], [10_000, true]] as const)("uses the earliest possible expiry for a reference cache with %i ms left", (remainingMs, approval) => {
    const f = fixture("agy");
    f.meta.promptCache = { startedAt: NOW - 300_000 + remainingMs, observedAt: NOW - 290_000 + remainingMs,
      ttlSeconds: 300, source: "agy-gemini-reference",
      reference: { maxTtlSeconds: 3600, cacheReadTokens: 100, promptTokens: 200 } };
    expect(f.review().cacheHeat).toBe("hot");
    expect(requiresCrossSessionCostApproval(f.review())).toBe(approval);
  });
  it("gates daily session sends and queue drains on cold or model-mismatched context, while letting expiring-soon hot cache send immediately", () => {
    const f = fixture("claude", { input_tokens: 60000, context_window: 200000 });
    expect(requiresSessionSendCostApproval(f.review(), f.meta, f.session, NOW)).toBe(false);
    expect(requiresQueueDrainCostApproval(f.review())).toBe(false);

    // Expiring soon (last 10%) is still hot and should NOT block daily send or queue drain
    f.meta.promptCache = { startedAt: NOW - 3500000, observedAt: NOW - 3490000, ttlSeconds: 3600, source: "anthropic-usage" };
    const expiringReview = crossSessionCostReview(f.meta, f.state, "idle", NOW);
    expect(expiringReview.cacheHeat).toBe("hot");
    expect(requiresSessionSendCostApproval(expiringReview, f.meta, f.session, NOW)).toBe(false);
    expect(requiresQueueDrainCostApproval(expiringReview)).toBe(false);

    // Cold cache >= 50k triggers both daily send and queue drain cost guards
    const coldReview = crossSessionCostReview(f.meta, f.state, "idle", NOW + 7200000);
    expect(coldReview.cacheHeat).toBe("cold");
    expect(requiresSessionSendCostApproval(coldReview, f.meta, f.session, NOW + 7200000)).toBe(true);
    expect(requiresQueueDrainCostApproval(coldReview)).toBe(true);

    // Cold cache < 50k (e.g. 18k tokens) passes through directly without blocking
    f.session.usage = { input_tokens: 18416, context_window: 570000 };
    const smallColdReview = crossSessionCostReview(f.meta, f.state, "idle", NOW + 7200000);
    expect(smallColdReview.cacheHeat).toBe("cold");
    expect(smallColdReview.context.used).toBe(18416);
    expect(requiresSessionSendCostApproval(smallColdReview, f.meta, f.session, NOW + 7200000)).toBe(false);
    expect(requiresQueueDrainCostApproval(smallColdReview)).toBe(false);

    // Approving a specific model + cacheStartedAt signature allows that exact state until changed
    const key = sessionKey(f.meta.engine, f.meta.sessionId, f.meta.workspacePath);
    useSessionSendCostGuardStore.getState().markApproved(key, coldReview);
    expect(useSessionSendCostGuardStore.getState().isApproved(key, coldReview)).toBe(true);
    expect(useSessionSendCostGuardStore.getState().isApproved(key, { ...coldReview, model: "model-b" })).toBe(false);
  });
});
