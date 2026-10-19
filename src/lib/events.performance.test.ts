import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "./transport";
import { listenEngineEvents, type EngineEventPayload } from "./events";
import { performanceRecorder } from "./performance-diagnostics";

vi.mock("./transport", () => ({ listen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); performanceRecorder.setEnabled(true); });

describe("engine diagnostic boundary", () => {
  it("bypasses diagnostic event traversal when disabled", async () => {
    let deliver!: (event: { payload: EngineEventPayload[] }) => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => {
      deliver = callback as typeof deliver;
      return () => {};
    });
    performanceRecorder.setEnabled(false);
    const count = vi.spyOn(performanceRecorder, "count");
    const callback = vi.fn();
    await listenEngineEvents(callback);
    deliver({ payload: [] });
    expect(callback).toHaveBeenCalledWith([]);
    expect(count).not.toHaveBeenCalled();
  });
  it("aggregates numeric signals without retaining event contents", async () => {
    let deliver!: (event: { payload: EngineEventPayload[] }) => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => {
      deliver = callback as typeof deliver;
      return () => {};
    });
    const count = vi.spyOn(performanceRecorder, "count");
    const duration = vi.spyOn(performanceRecorder, "duration");
    const handle = vi.fn();
    const events: EngineEventPayload[] = [
      { runId: "private-run", sessionId: "private-session", engine: "claude", seq: 1, kind: "thinking", data: "private-thought" },
      { runId: "private-run", sessionId: "private-session", engine: "claude", seq: 2, kind: "message", data: { role: "tool", text: "private-code", path: "/private-path", args: { token: "credential" } } },
    ];
    await listenEngineEvents(handle);
    deliver({ payload: events });
    expect(handle).toHaveBeenCalledWith(events);
    expect(count).toHaveBeenCalledWith("engineEvents", 2);
    expect(count).toHaveBeenCalledWith("textEvents", 1);
    expect(count).toHaveBeenCalledWith("toolEvents", 1);
    expect(duration).toHaveBeenCalledWith("engineBatch", expect.any(Number));
    expect(JSON.stringify(performanceRecorder.snapshot())).not.toMatch(/private|credential/);
  });

  it("records the interval but preserves existing handler failures", async () => {
    let deliver!: (event: { payload: EngineEventPayload[] }) => void;
    vi.mocked(listen).mockImplementation(async (_name, callback) => {
      deliver = callback as typeof deliver;
      return () => {};
    });
    const duration = vi.spyOn(performanceRecorder, "duration");
    await listenEngineEvents(() => { throw new Error("handler failure"); });
    expect(() => deliver({ payload: [] })).toThrow("handler failure");
    expect(duration).toHaveBeenCalledWith("engineBatch", expect.any(Number));
    expect(JSON.stringify(performanceRecorder.snapshot())).not.toContain("handler failure");
  });
});
