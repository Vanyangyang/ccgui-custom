import { describe, expect, it, vi } from "vitest";
import type { MemoryReviewBatch, MemoryReviewRecord, MemoryReviewRequest } from "@ccgui/plugin-sdk";
import { createMemoryReviewBridge, validateMemoryReviewRequest, validateMemoryReviewResponse } from "./memory-review-bridge";

const record = (id: string): MemoryReviewRecord => ({ id, revision: 1, kind: "decision", title: id, text: "保留原有条件，轮回使用历史断片。", conditions: ["游戏内"], authority: "assistant_recorded", source: { kind: "manual_note", role: "user", complete: true, text: "原始记录" } });
const request = (): MemoryReviewRequest => ({ requestId: "request", projectId: "project", batchId: "batch", root: record("new"), candidates: [record("old")] });
const batch = (r = request()): MemoryReviewBatch => ({ version: 1, requestId: r.requestId, projectId: r.projectId, batchId: r.batchId, model: "gemini-4-argon", records: [r.root, ...r.candidates].map(({ id, revision }) => ({ id, revision })), judgments: [r.root, ...r.candidates].map(r => ({ targetId: r.id, targetRevision: r.revision, outcome: "needs_review", reason: "source_provenance_unavailable", successorId: null, scope: "unknown", evidence: [], dependsOn: [], preserve: [] })) });
const completed = () => ({ status: "completed" as const, batch: batch() });
function hold<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>): Promise<unknown> => completed());
  const paused = vi.fn(() => false);
  return { invoke, paused, api: createMemoryReviewBridge("owner", { invoke, paused }) };
}

describe("memory review contract and lifecycle", () => {
  it("passes bounded receipt-only requests and explicit native automation capability", async () => {
    const f = fixture(); f.invoke.mockResolvedValueOnce({ available: true, busy: false, retryAfterMs: 0, automationVersion: 1 });
    await expect(f.api.status()).resolves.toMatchObject({ automationVersion: 1 });
    const r = { ...request(), reconcileOnly: true };
    await expect(f.api.review(r)).resolves.toEqual(completed());
    expect(f.invoke).toHaveBeenLastCalledWith("plugin_memory_review", { pluginId: "owner", request: r });
    expect(() => validateMemoryReviewRequest({ ...r, reconcileOnly: "yes" })).toThrow(/flag/);
  });
  it("binds all input identities and exact revisions, including root as a target", async () => {
    const f = fixture(); await expect(f.api.review(request())).resolves.toEqual(completed());
    expect(f.invoke).toHaveBeenCalledWith("plugin_memory_review", { pluginId: "owner", request: request() });
    const b = batch(); b.judgments[0].outcome = "keep"; b.judgments[0].reason = "Native evidence still applies";
    expect(validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toMatchObject({ batch: { judgments: [{ targetId: "new", outcome: "keep" }, { targetId: "old" }] } });
  });
  it("rejects unknown fields, duplicate IDs, excessive candidates and Unicode/byte overflow without truncating", () => {
    for (const mutate of [
      (r: any) => { r.prompt = "escape"; }, (r: any) => { r.root.createdAt = "2099"; },
      (r: any) => { r.candidates[0].id = "new"; }, (r: any) => { r.root.text = "😀".repeat(1601); },
      (r: any) => { r.root.conditions = Array(5).fill("c"); }, (r: any) => { r.root.conditions = ["界".repeat(301)]; },
      (r: any) => { r.root.source.text = "x".repeat(8193); }, (r: any) => { r.root.source.engine = null; },
      (r: any) => { r.candidates = Array.from({ length: 7 }, (_, i) => record(String(i))); },
      (r: any) => { r.root.source.text = "界".repeat(8000); r.candidates[0].source.text = "界".repeat(8000); },
    ]) { const r = request(); mutate(r); expect(() => validateMemoryReviewRequest(r)).toThrow(); }
    const r = request(); r.root.text = "😀".repeat(1600); expect(() => validateMemoryReviewRequest(r)).not.toThrow();
  });
  it("rejects provider shape drift, omitted root, revisions, duplicate targets and unknown outcome", () => {
    for (const mutate of [
      (b: any) => { b.model = "other"; }, (b: any) => { b.requestId = "other"; }, (b: any) => { b.batchId = "other"; },
      (b: any) => { b.records[0].revision = 2; }, (b: any) => { b.records[1] = b.records[0]; },
      (b: any) => { b.judgments.pop(); }, (b: any) => { b.judgments[1] = b.judgments[0]; },
      (b: any) => { b.judgments[0].outcome = "unknown"; }, (b: any) => { b.judgments[0].extra = true; },
      (b: any) => { delete b.judgments[0].successorId; }, (b: any) => { b.extra = true; },
    ]) { const b = batch(); mutate(b); expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toThrow(); }
  });
  it("accepts bounded partial preservation only verbatim, same title and conditions", () => {
    const b = batch(), j = b.judgments[1];
    Object.assign(j, { outcome: "superseded", reason: "Explicit later native decision", successorId: "new", scope: "overlap", evidence: [{ recordId: "old", quote: "旧决定" }, { recordId: "new", quote: "新决定" }], preserve: [{ title: "old", text: "保留原有条件", conditions: ["游戏内"] }] });
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).not.toThrow();
    for (const change of [{ title: "新的结论" }, { text: "新造结论" }, { conditions: [] }]) {
      const bad = structuredClone(b); Object.assign(bad.judgments[1].preserve[0], change);
      expect(() => validateMemoryReviewResponse({ status: "completed", batch: bad }, request())).toThrow();
    }
    j.scope = "disjoint"; expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toThrow();
  });
  it("permits explicit condition refinement with complete condition citations, never inferred disjoint replacement", () => {
    const r = request(); r.root.conditions = ["仅历史断片挑战点"]; r.candidates[0].conditions = ["游戏内全部轮回环节"];
    const b = batch(r), j = b.judgments[1];
    Object.assign(j, { outcome: "superseded", successorId: "new", scope: "same", reason: "Native-verified explicit refinement",
      evidence: [{ recordId: "old", quote: r.candidates[0].text }, { recordId: "new", quote: r.root.text }] });
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, r)).toThrow();
    j.evidence.push({ recordId: "old", quote: r.candidates[0].conditions[0] }, { recordId: "new", quote: r.root.conditions[0] });
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, r)).not.toThrow();
    j.scope = "disjoint";
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, r)).toThrow();
  });
  it("rejects related-as-dependency, self replacement and cycles even with valid individual edges", () => {
    const b = batch(); b.judgments[0].dependsOn = ["old"];
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toThrow();
    for (const j of b.judgments) {
      const other = j.targetId === "new" ? "old" : "new";
      j.dependsOn = [other]; j.reason = `Depends on ${other} because this premise is required`;
      j.evidence = [{ recordId: "new", quote: "new premise" }, { recordId: "old", quote: "old premise" }];
    }
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toThrow(/Cyclic/);
    b.judgments[0].dependsOn = []; Object.assign(b.judgments[0], { outcome: "superseded", successorId: "new", scope: "same" });
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, request())).toThrow();
  });
  it("freezes request input and clears pending after success and rejection", async () => {
    const f = fixture(), h = hold<unknown>(), r = request(); f.invoke.mockReturnValueOnce(h.promise);
    const work = f.api.review(r); r.root.text = "mutated";
    await expect(f.api.review(request())).rejects.toThrow(/pending/);
    expect((f.invoke.mock.calls[0][1].request as MemoryReviewRequest).root.text).not.toBe("mutated");
    h.resolve(completed()); await work;
    f.invoke.mockRejectedValueOnce(new Error("synthetic transport error")); await expect(f.api.review(request())).resolves.toMatchObject({ reason: "request_outcome_unknown" });
    await expect(f.api.review(request())).resolves.toMatchObject({ status: "completed" });
  });
  it("cancels by owner/request and ignores late answers on cancel and dispose", async () => {
    for (const dispose of [false, true]) {
      const f = fixture(), h = hold<unknown>(); f.invoke.mockReturnValueOnce(h.promise);
      const work = f.api.review(request());
      if (dispose) f.api.dispose(); else await f.api.cancel("request");
      expect(f.invoke).toHaveBeenLastCalledWith("plugin_memory_cancel", { pluginId: "owner", requestId: "request" });
      h.resolve(completed()); await expect(work).resolves.toMatchObject({ status: "deferred", reason: "request_outcome_unknown" });
      if (dispose) await expect(f.api.status()).rejects.toThrow(/disposed/);
    }
  });
  it("maintenance suppresses calls and discards a late result", async () => {
    const f = fixture(); f.paused.mockReturnValue(true);
    await expect(f.api.review(request())).resolves.toMatchObject({ reason: "maintenance" }); expect(f.invoke).not.toHaveBeenCalled();
    f.paused.mockReturnValue(false); const h = hold<unknown>(); f.invoke.mockReturnValueOnce(h.promise);
    const work = f.api.review(request()); f.paused.mockReturnValue(true); h.resolve(completed());
    await expect(work).resolves.toMatchObject({ reason: "request_outcome_unknown" });
  });
  it("strictly validates status and unavailable dispositions without provider content", async () => {
    const f = fixture(); f.invoke.mockResolvedValueOnce({ available: false, busy: false, retryAfterMs: 60000, reason: "vertex_unavailable" });
    await expect(f.api.status()).resolves.toMatchObject({ available: false });
    f.invoke.mockResolvedValueOnce({ status: "unavailable", reason: "vertex_unavailable", retryAfterMs: 60000 });
    await expect(f.api.review(request())).resolves.toMatchObject({ status: "unavailable" });
    expect(() => validateMemoryReviewResponse({ status: "deferred", reason: "x", retryAfterMs: 1, rawProvider: "secret" }, request())).toThrow();
  });
  it("preserves post-send unknown across cancel/dispose/maintenance and does not issue a second request", async () => {
    for (const action of ["cancel", "dispose", "maintenance", "none"]) {
      const f = fixture(), h = hold<unknown>(); f.invoke.mockReturnValueOnce(h.promise);
      const work = f.api.review(request());
      if (action === "cancel") await f.api.cancel("request");
      if (action === "dispose") f.api.dispose();
      if (action === "maintenance") f.paused.mockReturnValue(true);
      h.resolve({ status: "deferred", reason: "request_outcome_unknown", retryAfterMs: 60000 });
      await expect(work).resolves.toEqual({ status: "deferred", reason: "request_outcome_unknown", retryAfterMs: 60000 });
      expect(f.invoke.mock.calls.filter(([command]) => command === "plugin_memory_review")).toHaveLength(1);
    }
  });
  it("keeps confirmed pre-send preemption and explicit HTTP rejection retriable", async () => {
    const f = fixture();
    for (const reason of ["preempted", "foreground_or_cooldown", "vertex_retry"]) {
      f.invoke.mockResolvedValueOnce({ status: "deferred", reason, retryAfterMs: 120000 });
      await expect(f.api.review(request())).resolves.toMatchObject({ reason, retryAfterMs: 120000 });
    }
    f.invoke.mockResolvedValueOnce({ status: "completed", batch: { ...batch(), model: "unknown" } });
    await expect(f.api.review(request())).resolves.toMatchObject({ reason: "request_outcome_unknown" });
  });
  it("accepts optional active/withdrawn state, passes it unchanged and rejects invalid state", async () => {
    const f = fixture(), r = request(); r.candidates[0].state = "withdrawn"; r.root.state = "active";
    await expect(f.api.review(r)).resolves.toMatchObject({ status: "completed" });
    expect((f.invoke.mock.calls[0][1].request as MemoryReviewRequest).candidates[0].state).toBe("withdrawn");
    for (const state of [null, "deleted", false]) {
      expect(() => validateMemoryReviewRequest({ ...request(), root: { ...request().root, state } })).toThrow();
    }
  });
  it("rejects withdrawn successors and withdrawn premises supporting keep", () => {
    const r = request(), b = batch(); r.root.state = "withdrawn";
    Object.assign(b.judgments[1], { outcome: "superseded", successorId: "new", scope: "same", evidence: [{ recordId: "old", quote: "old" }, { recordId: "new", quote: "new" }] });
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, r)).toThrow(/Withdrawn/);
    b.judgments[1].outcome = "keep"; b.judgments[1].successorId = null;
    b.judgments[1].dependsOn = ["new"]; b.judgments[1].reason = "Requires new as its premise";
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: b }, r)).toThrow(/Withdrawn/);
    const own = batch(); own.judgments[0].outcome = "keep";
    expect(() => validateMemoryReviewResponse({ status: "completed", batch: own }, r)).toThrow(/Withdrawn/);
  });
});
