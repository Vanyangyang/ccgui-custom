import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceRecorder } from "./performance-diagnostics";

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(15000));
afterEach(() => vi.restoreAllMocks());

describe("PerformanceRecorder", () => {
  it("keeps only a bounded recent window and flushes interval totals", () => {
    const recorder = new PerformanceRecorder(2, 1000);
    recorder.count("engineEvents", 120);
    recorder.duration("engineBatch", 32);
    recorder.duration("engineBatch", 8);
    recorder.sample(5000, false, { sessions: 1, messages: 120, streaming: 1 });
    expect(recorder.snapshot().samples[0]).toMatchObject({
      at: 5000,
      counters: { engineEvents: 120 },
      durations: { engineBatch: { count: 2, totalMs: 40, maxMs: 32 } },
    });
    recorder.sample(10000, false);
    recorder.sample(15000, false);
    const samples = recorder.snapshot().samples;
    expect(samples).toHaveLength(2);
    expect(samples.map((sample) => sample.at)).toEqual([10000, 15000]);
    expect(samples[1].counters).toEqual({});
    expect(samples[1].durations).toEqual({});
  });

  it("records visible stalls but does not mislabel background throttling", () => {
    const recorder = new PerformanceRecorder();
    recorder.heartbeat(0, false);
    recorder.heartbeat(1250, false);
    recorder.heartbeat(21250, true);
    recorder.heartbeat(41250, false);
    recorder.heartbeat(42250, false);
    recorder.sample(43000, false);
    expect(recorder.snapshot().samples[0].durations.eventLoopLag).toEqual({
      count: 2, totalMs: 250, maxMs: 250,
    });
  });

  it("whitelists numeric metrics and copies snapshots without arbitrary content", () => {
    const recorder = new PerformanceRecorder();
    recorder.count("engineEvents", Number.NaN);
    recorder.duration("engineBatch", -1);
    recorder.duration("engineBatch", Infinity);
    recorder.count("secret prompt" as "engineEvents", 5);
    recorder.duration("private path" as "engineBatch", 8);
    recorder.count("engineEvents", 3);
    recorder.sample(5000, false, { sessions: 1, messages: 2, streaming: 0, prompt: "secret" } as never);
    const snapshot = recorder.snapshot();
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|prompt|NaN|Infinity/);
    expect(snapshot.samples[0].durations).toEqual({});
    snapshot.samples[0].counters.engineEvents = 999;
    expect(recorder.snapshot().samples[0].counters.engineEvents).toBe(3);
  });

  it("includes pending data in export without consuming the interval", () => {
    const recorder = new PerformanceRecorder();
    recorder.count("toolEvents", 7);
    expect(recorder.snapshot().pending.counters.toolEvents).toBe(7);
    expect(recorder.snapshot().pending.counters.toolEvents).toBe(7);
    recorder.sample(5000, false);
    expect(recorder.snapshot().samples[0].counters.toolEvents).toBe(7);
    expect(recorder.snapshot().pending.counters).toEqual({});
  });

  it("expires history by time even when a hidden window stops sampling", () => {
    const recorder = new PerformanceRecorder();
    recorder.sample(1000, false);
    vi.mocked(Date.now).mockReturnValue(301001);
    expect(recorder.snapshot().samples).toEqual([]);
    recorder.sample(301001, false);
    expect(recorder.snapshot().samples).toHaveLength(1);
  });

  it("defaults to sixty samples and stops all recording when disabled", () => {
    const recorder = new PerformanceRecorder();
    expect(recorder.snapshot()).toMatchObject({ capacity: 60, retentionMs: 300000 });
    recorder.count("engineEvents", 4);
    recorder.sample(1000, false);
    recorder.setEnabled(false);
    recorder.count("engineEvents", 20);
    recorder.duration("engineBatch", 30);
    recorder.sample(2000, false);
    expect(recorder.snapshot()).toMatchObject({ enabled: false, samples: [], pending: { counters: {}, durations: {} } });
    recorder.setEnabled(true);
    recorder.count("engineEvents", 1);
    expect(recorder.snapshot().pending.counters.engineEvents).toBe(1);
  });

  it("marks unavailable context rather than presenting empty counts as measured", () => {
    const recorder = new PerformanceRecorder();
    recorder.sample(5000, false);
    expect(recorder.snapshot().samples[0]).toMatchObject({ contextAvailable: false });
  });
});
