import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createHandoffCompressionRuntime } from "./handoff-compression-runtime";
import type { HostHandoffRequest, HostHandoffSelection } from "@ccgui/plugin-sdk";
import type { HandoffProgressCallback } from "@/lib/handoff-progress";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const input = { handoffId: "child-1", requestId: "request-1", expectedRevision: 0, text: "独立存储中的原文🙂" };
function fixture() {
  const records = new Map<string, unknown>();
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const native = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const submit = vi.fn(async (_input: HostHandoffRequest, _selection: HostHandoffSelection, _onProgress?: HandoffProgressCallback) => native);
  const save = vi.fn(async (id: string, value: unknown) => { records.set(id, structuredClone(value)); });
  const registerBlocker = vi.fn((_scope: string, _read: () => readonly string[]) => () => {});
  const deps = {
    scope: "host-child-handoff:test",
    load: vi.fn(async (id: string) => structuredClone(records.get(id))), save, submit,
    preferences: () => ({ enabled: false, selection: { engine: "cursor" as const, model: "mock-model" } }),
    checkpoint: { assertAllowed: vi.fn(), registerBlocker },
  };
  const api = createHandoffCompressionRuntime(deps);
  const blocker = () => registerBlocker.mock.calls[0][1]();
  const settled = async (status: string) => vi.waitFor(async () => {
    expect((await api.inspect(input.handoffId))?.status).toBe(status);
    expect(blocker()).toEqual([]);
  });
  return { api, deps, records, submit, save, resolve, reject, blocker, settled };
}

describe("shared handoff compression runtime", () => {
  it.each(["completed", "failed"])("persists final timing after %s and rejects same-phase reversed timing", async status => {
    const f = fixture(); const started = await f.api.summarize(input);
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const progress = f.submit.mock.calls[0][2]!;
    const timing = { elapsedMs: 10, readingMs: 1, segmentsMs: 9, mergingMs: 0, verifyingMs: 0,
      modelCalls: 2, completedModelCalls: 0, activeModelCalls: 2, modelElapsedMs: 0 };
    progress({ phase: "segments", completed: 0, total: 2, timing });
    const next = { ...timing, elapsedMs: 20, segmentsMs: 19, completedModelCalls: 1, activeModelCalls: 1, modelElapsedMs: 15, lastModelCallMs: 15, longestModelCallMs: 15 };
    progress({ phase: "segments", completed: 0, total: 2, timing: next });
    progress({ phase: "segments", completed: 0, total: 2, timing });
    expect(await f.api.inspect(input.handoffId)).toMatchObject({ revision: started.revision, progress: { timing: next } });
    const final = { ...next, elapsedMs: 30, segmentsMs: 29, completedModelCalls: 2, activeModelCalls: 0, modelElapsedMs: 40, lastModelCallMs: 25, longestModelCallMs: 25 };
    progress({ phase: "segments", completed: 1, total: 2, timing: final });
    if (status === "completed") f.resolve("summary"); else f.reject(Error("call failed"));
    await f.settled(status);
    const cold = createHandoffCompressionRuntime(f.deps);
    expect(await cold.inspect(input.handoffId)).toMatchObject({ status, progress: { timing: final } });
    const saved = f.records.get(input.handoffId) as { snapshot: { progress: { timing: typeof final } } };
    saved.snapshot.progress.timing.modelCalls = 1025;
    await expect(createHandoffCompressionRuntime(f.deps).inspect(input.handoffId)).rejects.toThrow("Invalid persisted handoff progress");
  });
  it("publishes real ordered progress without persisting each tick, changing revisions or replaying", async () => {
    const f = fixture(), updates = vi.fn(); f.api.onEvent(updates);
    const started = await f.api.summarize(input);
    expect(started.startedAt).toBeGreaterThan(0); expect(started.progress).toBeUndefined();
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
    const progress = f.submit.mock.calls[0][2]!;
    progress({ phase: "reading" });
    progress({ phase: "segments", completed: 0, total: 3 });
    progress({ phase: "segments", completed: 1, total: 3 });
    const count = updates.mock.calls.length;
    progress({ phase: "segments", completed: 0, total: 3 });
    progress({ phase: "reading" });
    progress({ phase: "segments", completed: 7, total: 3 });
    expect(updates).toHaveBeenCalledTimes(count);
    expect(await f.api.inspect(input.handoffId)).toMatchObject({ revision: started.revision, startedAt: started.startedAt,
      progress: { phase: "segments", completed: 1, total: 3, updatedAt: expect.any(Number) } });
    expect(f.save).toHaveBeenCalledTimes(1);
    progress({ phase: "merging", round: 1, completed: 0, total: 1 });
    progress({ phase: "verifying" });
    await f.api.summarize(input); expect(f.submit).toHaveBeenCalledTimes(1);
    await f.api.discard(input.handoffId, input.requestId);
    const discarded = updates.mock.calls.length; progress({ phase: "verifying" });
    expect(updates).toHaveBeenCalledTimes(discarded);
    f.resolve("Late result is not adopted"); await f.settled("discarded");
  });
  it("restores accepted elapsed-time metadata without pretending a cold request is still running", async () => {
    const f = fixture(), started = await f.api.summarize(input);
    const cold = createHandoffCompressionRuntime(f.deps);
    expect(await cold.inspect(input.handoffId)).toMatchObject({ status: "unknown", startedAt: started.startedAt });
    expect(f.submit).toHaveBeenCalledTimes(1);
    await cold.discard(input.handoffId, input.requestId); f.resolve("Late original result"); await f.settled("discarded");
  });
  it("deduplicates coordinator sources and restores an interrupted source without resubmission", async () => {
    const f = fixture();
    const request = { handoffId: input.handoffId, requestId: input.requestId, expectedRevision: 0,
      source: { kind: "coordinator" as const, conversationRequestId: "root", expectedRevision: 3 } };
    await Promise.all([f.api.summarize(request), f.api.summarize(request)]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    await expect(f.api.summarize({ ...request, source: { ...request.source, expectedRevision: 4 } })).rejects.toThrow("different input");
    const cold = createHandoffCompressionRuntime(f.deps);
    expect(await cold.summarize(request)).toMatchObject({ status: "unknown" });
    expect(f.submit).toHaveBeenCalledTimes(1);
    await cold.discard(input.handoffId, input.requestId);
    expect(f.blocker()).toEqual(["handoff-native-submission"]);
    f.resolve("late coordinator summary"); await f.settled("discarded");
    expect(await f.api.inspect(input.handoffId)).not.toHaveProperty("summary");
  });
  it.each([
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1, sessionId: "raw" } },
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1, approvalId: "child" } },
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1, sourceStamp: "a".repeat(64) } },
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 0 } },
    { source: { kind: "coordinator", conversationRequestId: "", expectedRevision: 1 } },
    { source: { kind: "other", conversationRequestId: "root", expectedRevision: 1 } },
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1 }, text: "fallback" },
    { source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1 }, childContext: "fallback" },
    { source: { kind: "managedChild", conversationRequestId: "root", expectedRevision: 1, approvalId: "a", approvalRequestId: "b", sourceStamp: "a".repeat(64), sessionId: "raw" } },
  ])("rejects invalid or mixed source fields before persistence: %j", async fields => {
    const f = fixture();
    await expect(f.api.summarize({ handoffId: input.handoffId, requestId: input.requestId, expectedRevision: 0, ...fields } as never)).rejects.toThrow("Invalid handoff");
    expect(f.save).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("returns a complete over-target summary without reintroducing an intermediate limit or replaying", async () => {
    const f = fixture();
    const summary = "😀".repeat(2_001);
    await f.api.summarize(input);
    f.resolve(summary); await f.settled("completed");
    expect(await f.api.inspect(input.handoffId)).toMatchObject({ status: "completed", summary });
    await f.api.summarize(input);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it("freezes an explicit compressor and includes it in duplicate-request identity", async () => {
    const f = fixture();
    const chosen = { engine: "codex" as const, model: "chosen-model", effort: "high" };
    const request = { ...input, selection: chosen };
    const first = await f.api.summarize(request);
    chosen.model = "changed-after-acceptance";
    expect(first.selection.model).toBe("chosen-model");
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ selection: { engine: "codex", model: "chosen-model", effort: "high" } }), first.selection, expect.any(Function));
    await expect(f.api.summarize(request)).rejects.toThrow("different input");
    f.resolve("selected compressor summary"); await f.settled("completed");
  });

  it("accepts an owned managed-child source instead of a clipped excerpt and fingerprints its complete identity", async () => {
    const f = fixture();
    const source = { kind: "managedChild" as const, conversationRequestId: "parent", expectedRevision: 2, approvalId: "leader:child", approvalRequestId: "held", sourceStamp: "a".repeat(64) };
    const request = { handoffId: input.handoffId, requestId: input.requestId, expectedRevision: 0, source };
    await f.api.summarize(request);
    expect(f.submit).toHaveBeenCalledWith(request, { engine: "cursor", model: "mock-model" }, expect.any(Function));
    await expect(f.api.summarize({ ...request, source: { ...source, sourceStamp: "b".repeat(64) } })).rejects.toThrow("different input");
    await expect(f.api.summarize({ ...request, text: "clipped fallback" })).rejects.toThrow("Invalid handoff");
    f.resolve("full saved history summary"); await f.settled("completed");
  });
  it("persists identity before submission and deduplicates concurrent and restored retries", async () => {
    const f = fixture();
    f.submit.mockImplementation(async () => {
      expect(f.records.has(input.handoffId)).toBe(true);
      expect(JSON.stringify([...f.records.values()])).not.toContain(input.text);
      return "mock summary";
    });
    const [first, duplicate] = await Promise.all([f.api.summarize(input), f.api.summarize(input)]);
    expect(first.requestId).toBe(duplicate.requestId);
    await f.settled("completed");
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledWith(input, { engine: "cursor", model: "mock-model" }, expect.any(Function));
    const restored = createHandoffCompressionRuntime(f.deps);
    expect(await restored.summarize(input)).toMatchObject({ status: "completed", summary: "mock summary" });
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.deps.checkpoint.registerBlocker.mock.calls[0][0]).toBe(f.deps.scope);
  });

  it("never submits after identity save failure and bounds native failure diagnostics", async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(Error("isolated storage unavailable"));
    await expect(f.api.summarize(input)).rejects.toThrow("isolated storage unavailable");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.blocker()).toEqual([]);
    await f.api.summarize(input);
    f.reject(Error("x".repeat(2500)));
    await f.settled("failed");
    expect((await f.api.inspect(input.handoffId))?.error).toHaveLength(2000);
    expect(await f.api.summarize(input)).toMatchObject({ status: "failed" });
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("discards results without releasing native ownership or allowing late output", async () => {
    const f = fixture();
    await f.api.summarize(input);
    const discarded = await f.api.discard(input.handoffId, input.requestId);
    expect(f.blocker()).toEqual(["handoff-native-submission"]);
    await expect(f.api.summarize({ ...input, requestId: "next", expectedRevision: discarded!.revision })).rejects.toThrow("still running");
    f.resolve("late mock summary");
    await f.settled("discarded");
    expect(await f.api.inspect(input.handoffId)).toEqual(discarded);
    expect(JSON.stringify([...f.records.values()])).not.toContain("late mock summary");
  });

  it("exposes readable timeout failure without a summary or automatic replay", async () => {
    const f = fixture();
    const selection = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "max" };
    const request = { ...input, selection };
    await f.api.summarize(request);
    const raw = "Full handoff segment 1/2: codex handoff summary timed out [stage=completion; http_status=200; diagnostic_id=diag-123; elapsed_ms=600001; timeout_ms=600000]";
    f.reject(Error(raw));
    await f.settled("failed");
    const failed = await f.api.inspect(input.handoffId);
    expect(failed).toMatchObject({ status: "failed", selection });
    expect(failed?.summary).toBeUndefined();
    expect(failed?.error).toContain("[handoff-timeout]");
    expect(failed?.error?.endsWith(raw)).toBe(true);
    expect(await f.api.summarize(request)).toEqual(failed);
    const restored = createHandoffCompressionRuntime(f.deps);
    expect(await restored.summarize(request)).toEqual(failed);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("recovers an interrupted identity as unknown without replay", async () => {
    const f = fixture();
    await f.api.summarize(input);
    const cold = createHandoffCompressionRuntime(f.deps);
    expect(await cold.summarize(input)).toMatchObject({ status: "unknown", revision: 2 });
    expect(f.submit).toHaveBeenCalledTimes(1);
    await f.api.discard(input.handoffId, input.requestId);
    f.resolve("late mock summary");
    await f.settled("discarded");
  });
});
