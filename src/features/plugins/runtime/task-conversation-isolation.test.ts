import { afterEach, describe, expect, it } from "vitest";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import type { HostTaskFacade } from "./task-facade";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function fixture() {
  const refs = new Map(["a", "b"].map(id => [id, { engine: "codex", sessionId: `session-${id}`, workspacePath: `G:/fixture/${id}` }]));
  const states = new Map<string, NonNullable<ReturnType<NonNullable<HostTaskFacade["conversationState"]>>>>([...refs].map(([id]) => [id, { messages: [], runId: null, status: "idle", canDeliver: true }]));
  const saved = new Map<string, unknown>(), lost = new Set<string>(), held = new Map<string, boolean>();
  const branches: Awaited<ReturnType<HostTaskFacade["leaderBranches"]>> = [];
  const deliveries: string[] = [], stops: string[] = [];
  const storage = {
    get: async (_plugin: string, key: string) => structuredClone(saved.get(key) ?? null),
    set: async (_plugin: string, key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    delete: async () => {},
  };
  const facade: Pick<HostTaskFacade, "ready" | "subscribe" | "leaderBranches" | "openBackground" | "conversationState" | "liveRun" | "settledRun" | "continueMessage" | "stopChild"> = {
    ready: async () => {}, subscribe: () => () => {}, leaderBranches: async () => branches, openBackground: async () => {},
    conversationState: ref => states.get(ref.sessionId.slice(-1)) ?? null, liveRun: () => null, settledRun: () => null,
    continueMessage: async (ref, _prompt, _images, runId, fence) => { await fence("turn", runId); deliveries.push(ref.sessionId); return { runId, delivery: "turn" }; },
    stopChild: async (_parent, id) => { stops.push(id); },
  };
  const create = () => {
    const bridge = createTaskConversationBridge({ pluginId: "scope-fixture", storage,
      owned: async id => {
        if (lost.has(id)) throw new Error("Fixture immutable identity no longer proven");
        const ref = refs.get(id)!;
        return { proven: true, receipt: { requestId: id, taskId: id, executionId: `execution-${id}`, projectId: id, slotKey: id, workspacePath: ref.workspacePath,
          status: "completed", runId: `initial-${id}`, session: ref, sessionDecision: "new", acceptedAt: 1, updatedAt: 2 } };
      }, facade: async () => facade as HostTaskFacade, resolveImages: async ids => ids, hold: (id, value) => { held.set(id, value); },
    });
    disposers.push(() => bridge.dispose());
    return bridge;
  };
  return { create, refs, states, saved, lost, held, branches, deliveries, stops };
}

describe("continuous coordinator scope isolation", () => {
  it("a settled stop unlocks an explicit model change without dropping the late-child stop fence", async () => {
    const f = fixture(), bridge = f.create();
    await bridge.conversation("a");
    const settled = await bridge.stopConversation("a");
    expect(settled.status).toBe("cancelled");
    expect(settled.stopRequested).toBe(true);
    expect(settled.canSend).toBe(true);
    expect(settled.canChangeSelection).toBe(true);
    expect(f.held.get("a")).toBe(false);
    const ref = f.refs.get("a")!;
    f.branches.push({ id: "late-owned", parentEngine: ref.engine, parentSessionId: ref.sessionId, parentWorkspacePath: ref.workspacePath,
      workspacePath: ref.workspacePath, engine: "codex", sessionId: "late-child", state: "running", title: "Late owned child" });
    await bridge.drain();
    expect(f.stops).toEqual(["late-owned"]);
    const active = await bridge.conversation("a");
    expect(active.status).toBe("stopping");
    expect(active.canChangeSelection).toBe(false);
    expect(f.held.get("a")).toBe(true);
  });

  it("lost ownership fences only that coordinator and survives recovery without replaying its input", async () => {
    const f = fixture(), bridge = f.create();
    const snapshots: Array<{ requestId: string; status: string }> = [];
    bridge.onConversationEvent(view => { snapshots.push(view); });
    await bridge.conversation("a"); await bridge.conversation("b");
    f.states.get("a")!.canDeliver = false;
    await bridge.sendMessage({ conversationRequestId: "a", requestId: "message-a", expectedInputRevision: 0, prompt: "Do not replay A" });
    await bridge.drain();
    f.lost.add("a");
    await bridge.sendMessage({ conversationRequestId: "b", requestId: "message-b", expectedInputRevision: 0, prompt: "Continue workspace B" });
    await bridge.drain();
    expect(f.deliveries).toEqual(["session-b"]);
    expect(snapshots.some(view => view.requestId === "a" && view.status === "unknown")).toBe(true);
    expect((await bridge.conversation("b")).status).not.toBe("unknown");
    expect(f.held.get("a")).toBe(true);
    bridge.dispose();
    f.lost.clear(); f.states.get("a")!.canDeliver = true;
    const restored = f.create();
    await restored.drain();
    expect((await restored.conversation("a")).status).toBe("unknown");
    expect((await restored.messageReceipt("a", "message-a"))?.status).toBe("unknown");
    expect(f.deliveries).toEqual(["session-b"]);
  });
});
