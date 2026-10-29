import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostChatTarget } from "@ccgui/plugin-sdk";
import type { ChatStore, SendOptions } from "./store/types";
import { HostChatBusyError } from "./store/types";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { sessionKey } from "./store/persistence";
import type { LeaderBranch, LeaderSnapshot } from "@/features/leader/types";
import { TaskPreSpawnError } from "@/features/plugins/runtime/task-facade";
import { createManagedParentDelivery } from "./managed-parent-delivery";
vi.mock("./store", async () => ({ useChatStore: {}, sessionKey: (await import("./store/persistence")).sessionKey }));

const parent = { branchId: "branch-1", engine: "codex", sessionId: "parent", workspacePath: "G:/parent" };
const child = { engine: "agy", sessionId: "child", workspacePath: "G:/child" };
const target: HostChatTarget = { client: "ccgui", engine: parent.engine, nativeSessionId: parent.sessionId,
  guiSessionId: parent.sessionId, workspacePath: parent.workspacePath, clientInstanceId: "test", windowId: "main" };
function fixture(engine = "codex", streaming = true) {
  const tab = { engine, sessionId: "parent", workspacePath: "G:/parent" };
  const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
  const session = { ...EMPTY_SESSION, streaming, queue: [{ id: "user", text: "queued user text", images: [], queuedAt: 1 }], messages: [],
    codexRunId: engine === "codex" && streaming ? "live-run" : undefined,
    nativeTaskRunId: engine === "claude" && streaming ? "live-run" : undefined, nativeActivity: "waiting" as "waiting" | "running",
    liveLaunch: { model: "m", effort: "high", provider: null, permission: "manual" },
  };
  if (streaming) runRouting.set("live-run", key);
  const state = { initialized: true, archivedSessionKeys: {}, openTabs: [tab], sessions: [], bySession: { [key]: session },
    models: { [engine]: "m" }, efforts: { [engine]: "high" }, providers: {}, engines: [], permission: "manual",
    sendWhileBusy: vi.fn(async (_prompt: string, _images: string[], options?: SendOptions) => {
      const delivery = !streaming ? "turn" : engine === "codex" ? "steer" : "live";
      const runId = streaming ? "live-run" : options!.requestedRunId!;
      await options!.hostContinuation!.beforeDelivery(delivery, runId);
      options!.hostContinuation!.onReceived(delivery, runId);
    }),
  } as unknown as ChatStore;
  const branch = { id: parent.branchId, engine: child.engine, sessionId: child.sessionId, workspacePath: child.workspacePath,
    parentEngine: engine, parentSessionId: "parent", parentWorkspacePath: "G:/parent", state: "running" } as LeaderBranch;
  const snapshot = vi.fn(async (): Promise<LeaderSnapshot> => ({ leaders: [], branches: [branch] }));
  const beforeIdleSend = vi.fn(async () => {});
  const adapter = createManagedParentDelivery(beforeIdleSend, { store: { getState: () => state }, snapshot });
  return { state, session, snapshot, branch, adapter, beforeIdleSend, target: { ...target, engine }, parent: { ...parent, engine } };
}
beforeEach(() => runRouting.clear());
describe("trusted managed parent delivery adapter", () => {
  it.each(["codex", "claude"])("uses the native %s continuation while preserving user queue and frozen selection", async engine => {
    const f = fixture(engine), before = vi.fn(async () => {});
    expect(f.adapter.inspect(f.target)?.canDeliver).toBe(true);
    expect(await f.adapter.validate(f.target, f.parent, child)).toBe(true);
    expect(await f.adapter.deliver(f.target, "child question", "question-run", before)).toEqual({ delivery: engine === "codex" ? "steer" : "live", runId: "live-run" });
    expect(before).toHaveBeenCalledWith(engine === "codex" ? "steer" : "live", "live-run");
    expect(f.state.sendWhileBusy).toHaveBeenCalledWith("child question", [], expect.objectContaining({ hostLaunch: expect.objectContaining({ model: "m", effort: "high" }), hostContinuation: expect.objectContaining({ priority: true }) }), f.state.openTabs[0]);
    expect(f.session.queue[0].text).toBe("queued user text");
    expect(f.beforeIdleSend).not.toHaveBeenCalled();
  });
  it("starts an idle parent directly and keeps uncertain input distinct from a pre-spawn refusal", async () => {
    const f = fixture("codex", false);
    expect(await f.adapter.deliver(f.target, "question", "fresh-turn", async () => {})).toEqual({ delivery: "turn", runId: "fresh-turn" });
    expect(f.beforeIdleSend).toHaveBeenCalledWith(f.target);
    vi.mocked(f.state.sendWhileBusy).mockRejectedValueOnce(new Error("lost ACK"));
    await expect(f.adapter.deliver(f.target, "question", "next", async () => {})).rejects.toThrow("lost ACK");
    vi.mocked(f.state.sendWhileBusy).mockRejectedValueOnce(new HostChatBusyError());
    await expect(f.adapter.deliver(f.target, "question", "next", async () => {})).rejects.toBeInstanceOf(TaskPreSpawnError);
  });
  it("rechecks permission, Stop, and model changes during the durable fence", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.session.queueParked = true; },
      (f: ReturnType<typeof fixture>) => { f.state.openTabs[0].model = "changed"; },
      (f: ReturnType<typeof fixture>) => { f.session.messages.push({ role: "assistant", text: "permission", seq: 1, ts: null, question: { status: "pending" } } as never); },
    ]) {
      const f = fixture();
      await expect(f.adapter.deliver(f.target, "question", "next", async () => mutate(f))).rejects.toBeInstanceOf(TaskPreSpawnError);
    }
  });
  it("waits for native Claude retirement before claiming an idle input", async () => {
    const f = fixture("claude", false), claim = vi.fn(async () => {});
    f.beforeIdleSend.mockRejectedValueOnce(new HostChatBusyError("previous native process is still alive"));
    await expect(f.adapter.deliver(f.target, "question", "next", claim)).rejects.toBeInstanceOf(TaskPreSpawnError);
    expect(claim).not.toHaveBeenCalled();
    expect(f.session.queue).toHaveLength(1);
  });
  it("holds unsupported running input without interrupting or inventing a queued native send", () => {
    const f = fixture("claude"); f.session.nativeActivity = "running";
    expect(f.adapter.inspect(f.target)?.canDeliver).toBe(false);
  });
  it("rejects sibling, ambiguous, retired, or archived relationships from a fresh native snapshot", async () => {
    const f = fixture();
    expect(await f.adapter.validate(f.target, f.parent, { ...child, sessionId: "sibling" })).toBe(false);
    f.snapshot.mockResolvedValueOnce({ leaders: [], branches: [f.branch, { ...f.branch, id: "duplicate" }] });
    expect(await f.adapter.validate(f.target, f.parent, child)).toBe(false);
    f.snapshot.mockResolvedValueOnce({ leaders: [], branches: [f.branch, { ...f.branch, id: "retired-duplicate", state: "reclaimed" }] });
    expect(await f.adapter.validate(f.target, f.parent, child)).toBe(false);
    for (const state of ["reclaimed", "handed_off"] as const) {
      Object.assign(f.branch, { state });
      expect(await f.adapter.validate(f.target, f.parent, child)).toBe(false);
    }
    f.branch.state = "running";
    f.snapshot.mockResolvedValueOnce({ leaders: [], branches: [f.branch], archivedGroups: [{ branchIds: [f.branch.id], members: [] } as never] });
    expect(await f.adapter.validate(f.target, f.parent, child)).toBe(false);
    f.snapshot.mockRejectedValueOnce(new Error("offline"));
    await expect(f.adapter.validate(f.target, f.parent, child)).rejects.toBeInstanceOf(TaskPreSpawnError);
  });
});
