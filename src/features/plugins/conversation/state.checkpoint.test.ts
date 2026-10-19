import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => vi.restoreAllMocks());

describe("plugin conversation mode checkpoint", () => {
  it("restores unlocked selections, exit locks and stable draft identities before first use without storage I/O", async () => {
    const source = await import("@/lib/runtime-checkpoint");
    source.initializeRuntimeCheckpoint(undefined, { requiredParticipants: ["plugin-conversation-modes"] });
    const old = (await import("./state")).getConversationModeState();
    const draft = old.identity("new:claude:G:/fixture", "G:/fixture", true);
    const session = old.identity("codex/session", "G:/fixture", false);
    old.select(draft, "plugin:unlocked", false, 0);
    old.setExitBlocked(session, "plugin:working", true);
    const checkpoint = await source.prepareRuntimeCheckpoint();
    const plain = JSON.parse(JSON.stringify(checkpoint));
    vi.resetModules();
    const next = await import("@/lib/runtime-checkpoint");
    next.initializeRuntimeCheckpoint(plain, { requiredParticipants: ["plugin-conversation-modes"] });
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const restored = (await import("./state")).getConversationModeState();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(restored.identity("new:claude:G:/fixture", "G:/fixture", true)).toBe(draft);
    expect(restored.selected(draft)).toBe("plugin:unlocked");
    expect(restored.selected(session)).toBe("plugin:working");
    expect(restored.isTabCloseBlocked("codex/session", "G:/fixture")).toBe(true);
    expect(restored.select(session, "plugin:other", false, 0)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await next.awaitRuntimeCheckpointReady();
    expect(next.isRuntimeSubmissionPaused()).toBe(true);
  });

  it("validates atomically and never calls persistence during restore", async () => {
    const { ConversationModeState } = await import("./state");
    const persist = vi.fn(), persistLocks = vi.fn();
    const state = new ConversationModeState({ session: "identity" }, persist, {}, persistLocks);
    state.select("identity", "plugin:one", false, 0);
    const original = state.captureCheckpoint();
    expect(() => state.restoreCheckpoint({ ...original, blocked: { identity: 123 } })).toThrow(/checkpoint/);
    expect(state.captureCheckpoint()).toEqual(original);
    state.restoreCheckpoint({ ...original, selections: { identity: "plugin:two" }, blocked: { identity: "plugin:three" } });
    expect(state.selected("identity")).toBe("plugin:three");
    expect(persist).not.toHaveBeenCalled();
    expect(persistLocks).not.toHaveBeenCalled();
  });
});
