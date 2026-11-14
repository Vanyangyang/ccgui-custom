import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessagingActions } from "./messaging";
import { EMPTY_SESSION, runRouting } from "./stream";
import { sessionKey } from "./persistence";
import type { ChatStore } from "./types";
import type { SessionMeta } from "@/lib/ipc";
import { useSessionSendCostGuardStore } from "../cross-session-cost";

const mocks = vi.hoisted(() => ({
  ipc: { sendMessage: vi.fn(), rememberSessionModel: vi.fn(async () => {}), rememberSessionEffort: vi.fn(async () => {}), rememberSessionProvider: vi.fn(async () => {}),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({ name: "Agent", prompt: "Instructions" })),
  },
  getSelectedAgent: vi.fn(() => null as { source: string; id: string } | null),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks.ipc }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: mocks.getSelectedAgent, clearSelectedAgent: vi.fn(), migrateSelectedAgent: vi.fn() }));
const a = { engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/one" };
const b = { ...a, sessionId: "22222222-2222-2222-2222-222222222222", workspacePath: "G:/two" };
const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
function fixture() {
  let state = {
    initialized: true, archivedSessionKeys: {},
    active: b, openTabs: [a, b], engines: [], permission: "manual", models: { claude: "different-default" }, efforts: { claude: "low" }, providers: { claude: "different-default" },
    streamingByKey: {}, retryingByKey: {}, bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "session-model", activeEffort: "high", activeProvider: "session-provider" } },
    refreshSessionUsage: vi.fn(async () => {}),
  } as unknown as ChatStore;
  const actions = createMessagingActions({ get: () => state, set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    subscribe: () => () => {}, loadHistoryPage: vi.fn(),
  });
  return { actions, get: () => state };
}
beforeEach(() => { runRouting.clear(); vi.clearAllMocks(); mocks.getSelectedAgent.mockReturnValue(null); mocks.ipc.sendMessage.mockImplementation(async (request: { runId: string; sessionId: string }) => ({ runId: request.runId, sessionId: request.sessionId })); });

describe("original messaging host correlation seam", () => {
  it.each([49_999, 50_000])("guards queue draining through Windows aliases at %i tokens", used => {
    useSessionSendCostGuardStore.getState().reset();
    const f = fixture(); const now = Date.now();
    f.get().openTabs[0] = { ...a, workspacePath: "G:\\one" };
    f.get().sessions = [{ ...a, promptCache: { startedAt: now - 7_200_000, observedAt: now - 7_200_000,
      ttlSeconds: 300, source: "anthropic-usage" } } as SessionMeta];
    Object.assign(f.get().bySession[key], { usage: { input_tokens: used },
      queue: [{ id: "q", text: "continue", images: [], queuedAt: now - 3_600_000 }] });
    f.actions.drainQueue(key);
    expect(!!useSessionSendCostGuardStore.getState().bySessionKey[key]).toBe(used >= 50_000);
    expect(f.get().bySession[key].queue[0]?.manualOnly ?? false).toBe(used >= 50_000);
  });
  it("records the selected model when manually approving legacy queued metadata", async () => {
    useSessionSendCostGuardStore.getState().reset();
    const f = fixture();
    f.get().openTabs[0] = { ...a, workspacePath: "G:\\one", model: "chosen-model" };
    f.get().sessions = [{ ...a, workspacePath: "" } as SessionMeta];
    f.get().bySession[key].queue = [{ id: "q", text: "continue", images: [], queuedAt: Date.now() }];
    await f.actions.sendQueuedNow("q", key);
    expect(useSessionSendCostGuardStore.getState().approvedByKey[key]?.model).toBe("chosen-model");
    expect(f.get().sessions[0].workspacePath).toBe("");
  });
  it("appends user row to exact background timeline and preserves model, effort, provider and permission", async () => {
    const f = fixture(); const started = vi.fn();
    await f.actions.send("Canvas instruction", [], { requestedRunId: "run-frozen", onRunStarted: started }, a);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-frozen", sessionId: a.sessionId, workspacePath: a.workspacePath,
      model: "session-model", effort: "high", providerId: "session-provider", permission: "manual" }));
    expect(f.get().bySession[key].messages).toMatchObject([{ role: "user", text: "Canvas instruction" }]);
    expect(f.get().active).toEqual(b); expect(runRouting.get("run-frozen")).toBe(key);
    expect(started).toHaveBeenCalledWith({ runId: "run-frozen", sessionId: a.sessionId });
  });
  it("passes Claude null-session ACK unchanged while preserving requested run routing and original session send", async () => {
    const f = fixture(); const started = vi.fn();
    mocks.ipc.sendMessage.mockResolvedValueOnce({ runId: "run-frozen", sessionId: null });
    await f.actions.send("Canvas", [], { requestedRunId: "run-frozen", onRunStarted: started }, a);
    expect(started).toHaveBeenCalledWith({ runId: "run-frozen", sessionId: null });
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-frozen", sessionId: a.sessionId,
      workspacePath: a.workspacePath, model: "session-model", effort: "high", providerId: "session-provider", permission: "manual" }));
    expect(runRouting.get("run-frozen")).toBe(key); expect(f.get().active).toEqual(b);
  });
  it("rejects host busy sends before appending a user row or sending IPC", async () => {
    const f = fixture(); f.get().bySession[key].streaming = true;
    await expect(f.actions.send("never", [], { requestedRunId: "run-frozen" }, a)).rejects.toThrow(/busy/);
    expect(f.get().bySession[key].messages).toEqual([]); expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["closed", "busy"])("revalidates a %s target after asynchronous built-in agent resolution", async (condition) => {
    const f = fixture(); mocks.getSelectedAgent.mockReturnValue({ source: "builtIn", id: "agent" });
    let resolve!: (v: { name: string; prompt: string }) => void;
    mocks.ipc.resolveEnabledBuiltInAgent.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = f.actions.send("Canvas", [], { requestedRunId: "run-frozen" }, a);
    if (condition === "closed") f.get().openTabs = [b]; else f.get().bySession[key].streaming = true;
    resolve({ name: "Agent", prompt: "Instructions" });
    await expect(pending).rejects.toThrow(condition === "closed" ? /reachable/ : /busy/);
    expect(f.get().bySession[key].messages).toEqual([]); expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });
  it("preserves original GUI failure state while returning ambiguous spawn errors to the bridge", async () => {
    const f = fixture(); mocks.ipc.sendMessage.mockRejectedValueOnce(new Error("spawn failure"));
    await expect(f.actions.send("Canvas", [], { requestedRunId: "run-frozen" }, a)).rejects.toThrow(/spawn failure/);
    expect(f.get().bySession[key]).toMatchObject({ streaming: false, error: "Error: spawn failure" });
    expect(runRouting.has("run-frozen")).toBe(false);
  });
});
