import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ native: true, invoke: vi.fn(), channels: [] as Array<{ onmessage: (data: unknown) => void }> }));
vi.mock("./transport", () => ({ invoke: f.invoke }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => f.native, Channel: class {
  onmessage: (data: unknown) => void;
  constructor(callback: (data: unknown) => void) { this.onmessage = callback; f.channels.push(this); }
} }));
beforeEach(() => { vi.resetModules(); f.native = true; f.invoke.mockReset().mockResolvedValue(true); f.channels = []; });
it("accepts legacy and timing metadata but rejects malformed counters and content", async () => {
  const { isNativeHandoffProgress } = await import("./handoff-progress");
  const timing = { elapsedMs: 10, readingMs: 1, segmentsMs: 9, mergingMs: 0, verifyingMs: 0,
    modelCalls: 2, completedModelCalls: 1, activeModelCalls: 1, modelElapsedMs: 7, lastModelCallMs: 7, longestModelCallMs: 7 };
  const progress = { phase: "segments", completed: 1, total: 3 };
  expect(isNativeHandoffProgress(progress)).toBe(true);
  expect(isNativeHandoffProgress({ ...progress, timing })).toBe(true);
  for (const bad of [{ ...timing, elapsedMs: -1 }, { ...timing, readingMs: 0.5 }, { ...timing, elapsedMs: Infinity },
    { ...timing, modelCalls: 1025, activeModelCalls: 1024 }, { ...timing, activeModelCalls: 0 }, { ...timing, prompt: "private" },
    { ...timing, verifyingMs: undefined }, { ...timing, completedModelCalls: 0, activeModelCalls: 2 }, { ...timing, lastModelCallMs: NaN }]) {
    expect(isNativeHandoffProgress({ ...progress, timing: bad })).toBe(false);
  }
});
it("forwards only valid metadata and detaches callbacks when the native operation ends", async () => {
  const { withHandoffProgress } = await import("./handoff-progress"), events = vi.fn();
  const result = await withHandoffProgress(async channel => {
    expect(channel).toBeDefined();
    f.channels[0].onmessage({ phase: "segments", completed: 0, total: 2 });
    f.channels[0].onmessage({ phase: "segments", completed: 3, total: 2 });
    f.channels[0].onmessage({ phase: "reading", text: "never expose body" });
    f.channels[0].onmessage({ phase: "merging", round: 1, completed: 0, total: 1 });
    return "summary";
  }, events);
  expect(result).toBe("summary"); expect(events).toHaveBeenCalledTimes(2);
  f.channels[0].onmessage({ phase: "verifying" }); expect(events).toHaveBeenCalledTimes(2);
});
it.each([false, "unavailable"])("does not allocate an unowned channel on an old host: %s", async support => {
  if (support === "unavailable") f.invoke.mockRejectedValue(new Error("unknown command")); else f.invoke.mockResolvedValue(false);
  const { withHandoffProgress } = await import("./handoff-progress");
  const run = vi.fn(async progress => { expect(progress).toBeUndefined(); return "legacy"; });
  expect(await withHandoffProgress(run, vi.fn())).toBe("legacy"); expect(f.channels).toHaveLength(0);
});
it("keeps web and callers without a listener unchanged", async () => {
  const { withHandoffProgress } = await import("./handoff-progress");
  expect(await withHandoffProgress(async () => "plain")).toBe("plain");
  f.native = false; expect(await withHandoffProgress(async () => "web", vi.fn())).toBe("web");
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.channels).toHaveLength(0);
});
it("cleans up after failure and prevents an observer error from failing the model call", async () => {
  const { withHandoffProgress } = await import("./handoff-progress");
  const listener = vi.fn(() => { throw Error("display failure"); });
  await expect(withHandoffProgress(async () => {
    f.channels[0].onmessage({ phase: "reading" }); throw Error("native failure");
  }, listener)).rejects.toThrow("native failure");
  f.channels[0].onmessage({ phase: "verifying" }); expect(listener).toHaveBeenCalledTimes(1);
});
