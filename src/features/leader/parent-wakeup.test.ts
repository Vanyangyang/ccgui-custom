import { describe, expect, it, vi } from "vitest";
import { TaskPreSpawnError, type HostTaskFacade, type TaskSessionRef } from "@/features/plugins/runtime/task-facade";
import { createParentWakeupRuntime, type ParentWakeup } from "./parent-wakeup";

const parent: TaskSessionRef = { engine: "codex", sessionId: "parent", workspacePath: "/parent" };
function fixture() {
  const notice: ParentWakeup = { id: "wake-1", branchId: "successor", parent, requestId: "assignment", childRunId: "child-run", state: "pending" };
  const control = { paused: false, blocked: false as false | "held" | "stopped", status: "idle" as "idle" | "busy" | "awaiting_permission" | null,
    beforeAck: undefined as (() => void) | undefined, beforeNative: undefined as (() => void) | undefined, live: false };
  const engineSend = vi.fn();
  const continuation: NonNullable<HostTaskFacade["continueMessage"]> = async (_ref, _prompt, _images, runId, beforeDelivery, _launch, _row, beforeSpawn) => {
    const actualRun = control.live ? "persistent-claude-run" : runId;
    const delivery = control.live ? "live" as const : "turn" as const;
    await beforeDelivery(delivery, actualRun);
    control.beforeNative?.();
    await _row?.({ runId: actualRun, seq: 1, ts: null, text: _prompt });
    await beforeSpawn?.();
    engineSend();
    control.beforeAck?.();
    return { delivery, runId: actualRun };
  };
  const host = { ready: vi.fn(async () => {}), known: vi.fn(() => true), inspect: vi.fn(() => control.status),
    wasInterrupted: vi.fn(() => false), openBackground: vi.fn(async () => { control.status = "idle"; }), continueMessage: vi.fn(continuation) };
  const deps = {
    host: async () => host,
    list: vi.fn(async () => [{ ...notice }]),
    claim: vi.fn(async (_id: string, runId: string) => {
      if (notice.state === "starting") return notice.runId === runId;
      if (notice.state !== "pending") return false;
      notice.state = "starting"; notice.runId = runId; return true;
    }),
    resolve: vi.fn(async (_id: string, _runId: string, outcome: "delivered" | "retry" | "unknown" | "cancelled") => {
      notice.state = outcome === "retry" ? "pending" : outcome; return true;
    }),
    blocked: () => control.blocked, paused: () => control.paused, runId: () => "new-parent-run",
    prompt: (value: ParentWakeup) => `task_wait ${value.branchId} ${value.requestId}`, error: vi.fn(),
  };
  return { notice, control, host, deps, engineSend, runtime: createParentWakeupRuntime(deps) };
}

describe("durable managed child completion delivery", () => {
  it("delivers once, reading the saved assignment instead of redispatching it", async () => {
    const f = fixture();
    await f.runtime.refresh(); await f.runtime.refresh();
    f.runtime.wake();
    expect(f.engineSend).toHaveBeenCalledTimes(1);
    expect(f.host.continueMessage).toHaveBeenCalledWith(parent, "task_wait successor assignment", [], "new-parent-run", expect.any(Function), undefined, expect.any(Function), expect.any(Function));
    expect(f.notice.state).toBe("delivered");
  });
  it.each(["busy", "awaiting_permission"] as const)("waits while the parent is %s and resumes on its next state change", async status => {
    const f = fixture(); f.control.status = status;
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled();
    f.control.status = "idle"; f.runtime.wake();
    await vi.waitFor(() => expect(f.notice.state).toBe("delivered"));
    expect(f.engineSend).toHaveBeenCalledTimes(1);
  });
  it("retains the completion while an existing cost approval is held", async () => {
    const f = fixture(); f.control.blocked = "held";
    await f.runtime.refresh(); expect(f.deps.claim).not.toHaveBeenCalled();
    f.control.blocked = false; f.runtime.wake();
    await vi.waitFor(() => expect(f.engineSend).toHaveBeenCalledTimes(1));
  });
  it("cancels an unstarted wake after explicit Stop", async () => {
    const f = fixture(); f.control.blocked = "stopped";
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled(); expect(f.notice.state).toBe("cancelled");
    f.control.blocked = false; await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled();
  });
  it("loads the exact saved parent in the background", async () => {
    const f = fixture(); f.control.status = null;
    await f.runtime.refresh();
    expect(f.host.openBackground).toHaveBeenCalledWith(parent);
    expect(f.notice.state).toBe("delivered");
  });
  it("does not wake an unavailable or archived parent", async () => {
    const f = fixture(); f.host.known.mockReturnValue(false);
    await f.runtime.refresh();
    expect(f.host.openBackground).not.toHaveBeenCalled(); expect(f.engineSend).not.toHaveBeenCalled();
  });
  it("drops a completion consumed by task_wait during preparation", async () => {
    const f = fixture(); f.deps.claim.mockImplementation(async () => { f.notice.state = "consumed"; return false; });
    await f.runtime.refresh(); await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled(); expect(f.deps.resolve).not.toHaveBeenCalled();
  });
  it("retries a proven pre-spawn race only after a parent state change", async () => {
    const f = fixture();
    const send = f.host.continueMessage.getMockImplementation()!;
    f.host.continueMessage.mockImplementationOnce(async (...args) => {
      await args[4]("turn", args[3]); throw new TaskPreSpawnError("Parent became busy");
    }).mockImplementation(send);
    await f.runtime.refresh(); await f.runtime.refresh();
    expect(f.notice.state).toBe("pending"); expect(f.deps.claim).toHaveBeenCalledTimes(1);
    f.runtime.wake();
    await vi.waitFor(() => expect(f.notice.state).toBe("delivered"));
    expect(f.engineSend).toHaveBeenCalledTimes(1);
  });
  it("never replays a lost native ACK, including after runtime recreation", async () => {
    const f = fixture(); f.control.beforeAck = () => { throw new Error("ACK transport lost"); };
    await f.runtime.refresh(); expect(f.notice.state).toBe("unknown");
    f.runtime.dispose();
    const restarted = createParentWakeupRuntime(f.deps);
    await restarted.refresh(); restarted.wake();
    expect(f.engineSend).toHaveBeenCalledTimes(1); expect(f.deps.error).toHaveBeenCalledTimes(2);
    restarted.dispose();
  });
  it("rechecks Stop during the durable native claim", async () => {
    const f = fixture(); const claim = f.deps.claim.getMockImplementation()!;
    f.deps.claim.mockImplementation(async (...args) => { const result = await claim(...args); f.control.blocked = "stopped"; return result; });
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled();
    await f.runtime.refresh(); expect(f.notice.state).toBe("cancelled");
  });
  it("holds native submissions across the runtime checkpoint barrier", async () => {
    const f = fixture(); f.control.paused = true;
    await f.runtime.refresh(); expect(f.deps.list).not.toHaveBeenCalled();
    f.control.paused = false; await f.runtime.refresh();
    expect(f.notice.state).toBe("delivered");
  });
  it("does not lose a parent wake that arrives while releasing a pre-spawn claim", async () => {
    const f = fixture(); const send = f.host.continueMessage.getMockImplementation()!;
    f.host.continueMessage.mockImplementationOnce(async (...args) => {
      await args[4]("turn", args[3]); throw new TaskPreSpawnError("busy race");
    }).mockImplementation(send);
    const resolve = f.deps.resolve.getMockImplementation()!;
    f.deps.resolve.mockImplementation(async (...args) => {
      const result = await resolve(...args);
      if (args[2] === "retry") f.runtime.wake();
      return result;
    });
    await f.runtime.refresh();
    expect(f.notice.state).toBe("delivered"); expect(f.engineSend).toHaveBeenCalledTimes(1);
  });
  it("uses a distinct delivery reservation while verifying a persistent CLI's real ACK", async () => {
    const f = fixture(); f.control.live = true;
    await f.runtime.refresh();
    expect(f.deps.claim).toHaveBeenCalledWith("wake-1", "new-parent-run");
    expect(f.deps.resolve).toHaveBeenCalledWith("wake-1", "new-parent-run", "delivered");
  });
  it("fences simultaneous runtime owners even when both reuse the same persistent CLI", async () => {
    const f = fixture(); f.control.live = true;
    let attempt = 0; f.deps.runId = () => `attempt-${++attempt}`;
    const replacement = createParentWakeupRuntime(f.deps);
    await Promise.all([f.runtime.refresh(), replacement.refresh()]);
    expect(f.engineSend).toHaveBeenCalledTimes(1);
    expect(f.notice.state).toBe("delivered");
    replacement.dispose();
  });
  it("rechecks a permission card that arrives after the durable claim", async () => {
    const f = fixture(); f.control.beforeNative = () => { f.control.status = "awaiting_permission"; };
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled(); expect(f.notice.state).toBe("pending");
  });
  it("can resume a retry held by a checkpoint that began during its claim", async () => {
    const f = fixture(); const claim = f.deps.claim.getMockImplementation()!;
    f.deps.claim.mockImplementationOnce(async (...args) => { const result = await claim(...args); f.control.paused = true; return result; }).mockImplementation(claim);
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled(); expect(f.notice.state).toBe("pending");
    f.control.paused = false; f.runtime.wake(); await f.runtime.refresh();
    expect(f.engineSend).toHaveBeenCalledTimes(1);
  });
  it("releases a pre-spawn claim when its old runtime owner is disposed", async () => {
    const f = fixture(); const claim = f.deps.claim.getMockImplementation()!;
    f.deps.claim.mockImplementation(async (...args) => { const result = await claim(...args); f.runtime.dispose(); return result; });
    await f.runtime.refresh();
    expect(f.engineSend).not.toHaveBeenCalled(); expect(f.notice.state).toBe("pending");
    expect(f.runtime.readiness()).toEqual([]);
  });
});
