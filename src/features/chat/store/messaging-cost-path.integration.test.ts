import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@/lib/ipc";
import { useSessionSendCostGuardStore } from "../cross-session-cost";
import { createMessagingActions } from "./messaging";
import { sessionKey } from "./persistence";
import { EMPTY_SESSION, runRouting } from "./stream";
import type { ChatStore } from "./types";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  rememberSessionModel: vi.fn(async () => {}),
  rememberSessionEffort: vi.fn(async () => {}),
  rememberSessionProvider: vi.fn(async () => {}),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/features/agents/selected-agent", () => ({
  getSelectedAgent: vi.fn(() => null),
  clearSelectedAgent: vi.fn(),
  migrateSelectedAgent: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const coldCache = {
  startedAt: NOW - 7_200_000,
  observedAt: NOW - 7_100_000,
  ttlSeconds: 3600,
  source: "anthropic-usage" as const,
};

function fixture({ engine = "claude", used = 50_000, queuedAt = NOW - 7_200_000,
  metadataPath = "G:/project", cache = coldCache as SessionMeta["promptCache"] } = {}) {
  const tab = { engine, sessionId: "cost-path-session", workspacePath: "G:\\project",
    model: engine === "codex" ? "gpt-6-astra" : "claude-sonnet-4-6" };
  const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
  const head = { id: "queued-message", text: "Continue the queued task", images: [], queuedAt };
  const meta = { engine, sessionId: tab.sessionId, workspacePath: metadataPath,
    model: "metadata-model", updatedAt: NOW - 7_200_000, promptCache: cache } as SessionMeta;
  let state = {
    initialized: true, archivedSessionKeys: {}, active: tab, openTabs: [tab], sessions: [meta],
    engines: [], permission: "manual", models: { [engine]: "default-model" }, efforts: {}, providers: {},
    drafts: {}, streamingByKey: {}, retryingByKey: {},
    bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [head], usage: { input_tokens: used } } },
    refreshSessionUsage: vi.fn(async () => {}),
  } as unknown as ChatStore;
  const actions = createMessagingActions({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    subscribe: () => () => {}, loadHistoryPage: vi.fn(),
  });
  return { actions, key, tab, head, get: () => state };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  runRouting.clear();
  useSessionSendCostGuardStore.getState().reset();
  mocks.sendMessage.mockImplementation(async (request: { runId: string; sessionId: string }) => ({
    runId: request.runId, sessionId: request.sessionId,
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  runRouting.clear();
  useSessionSendCostGuardStore.getState().reset();
});

async function expectSent(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());
  expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    engine: f.tab.engine, sessionId: f.tab.sessionId, workspacePath: f.tab.workspacePath, model: f.tab.model,
  }));
  expect(f.get().bySession[f.key].queue).toEqual([]);
  expect(useSessionSendCostGuardStore.getState().bySessionKey).toEqual({});
}

describe("ordinary queue drain cost review across Windows path aliases", () => {
  it("holds measured 50k Claude context with cold cache for queue_drain review", () => {
    const f = fixture();
    f.actions.drainQueue(f.key);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].queue).toEqual([{ ...f.head, manualOnly: true }]);
    expect(useSessionSendCostGuardStore.getState().bySessionKey[f.key]).toMatchObject({
      sessionKey: f.key, engine: "claude", sessionId: f.tab.sessionId, workspacePath: f.tab.workspacePath,
      mode: "queue_drain", queuedItemId: f.head.id, prompt: f.head.text,
      review: { model: f.tab.model, cacheHeat: "cold", context: { used: 50_000 } },
    });
    // A later drain cannot bypass the held head or submit it twice.
    f.actions.drainQueue(f.key);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].queue).toHaveLength(1);
  });

  it("sends 49,999 measured Claude tokens despite cold cache", async () => {
    const f = fixture({ used: 49_999 });
    f.actions.drainQueue(f.key);
    await expectSent(f);
  });

  it.each(["unknown", "expired"])("sends Codex GPT with %s cache without cost review", async status => {
    const f = fixture({ engine: "codex", used: 270_274,
      cache: status === "unknown" ? null : { ...coldCache, source: "openai-policy" } });
    f.actions.drainQueue(f.key);
    await expectSent(f);
  });

  it("does not use a previous turn's cold cache sample to pause a recently queued follow-up", async () => {
    const f = fixture({ queuedAt: NOW - 1000 });
    f.actions.drainQueue(f.key);
    await expectSent(f);
  });

  it("stops exempting a previous turn's cache sample once the queued message has waited a TTL", () => {
    const f = fixture({ queuedAt: NOW - 3_600_000 });
    f.actions.drainQueue(f.key);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].queue[0].manualOnly).toBe(true);
    expect(useSessionSendCostGuardStore.getState().bySessionKey[f.key]?.mode).toBe("queue_drain");
  });

  it("does not borrow cold cache metadata from the same session ID in another workspace", async () => {
    const f = fixture({ metadataPath: "G:/other-project" });
    f.actions.drainQueue(f.key);
    await expectSent(f);
  });
});
