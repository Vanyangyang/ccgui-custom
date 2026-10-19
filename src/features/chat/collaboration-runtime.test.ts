import { beforeEach, expect, it, vi } from "vitest";
import type { Message, PlanReview } from "@/lib/ipc";

const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  offs: [] as Array<ReturnType<typeof vi.fn>>,
  state: {} as { bySession: Record<string, { messages: Message[] }>; openTabs: Array<{ engine: string; sessionId: string | null }>; refreshWorkspaces: ReturnType<typeof vi.fn>; refreshSessions: ReturnType<typeof vi.fn> },
  list: vi.fn(),
  invalidateSkills: vi.fn(),
  notifyConfig: vi.fn(),
}));
vi.mock("@/features/settings/providers", () => ({ notifyCliConfigChanged: fixture.notifyConfig }));
vi.mock("@/components/application/ai-chat/slash-commands", () => ({ invalidateSlashCommandCatalog: fixture.invalidateSkills }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
  fixture.listeners.set(name, cb);
  const off = vi.fn(() => fixture.listeners.delete(name)); fixture.offs.push(off); return off;
}) }));
vi.mock("@/lib/ipc", () => ({ ipc: { listPlanReviews: fixture.list } }));
vi.mock("./store", () => ({
  sessionKey: (engine: string, id: string) => `${engine}/${id}`,
  useChatStore: {
    getState: () => fixture.state,
    setState: (update: (state: typeof fixture.state) => Partial<typeof fixture.state>) => { Object.assign(fixture.state, update(fixture.state)); },
  },
}));
import { startCollaborationRuntime } from "./collaboration-runtime";

function record(status: PlanReview["status"]): PlanReview {
  return { planId: "plan", engine: "claude", sessionId: "s", workspacePath: "/ws", runId: "r", revision: 1,
    title: "Plan", content: "Do work", contentHash: "hash", complete: true, reviewKind: "native_request",
    nativePlanId: null, execPermission: "manual", status, execution: "not_started", decisionIntentAt: null,
    appliedAt: null, createdAt: 1, updatedAt: 2, supersededBy: null };
}
const fire = (name: string, payload: unknown = null) => fixture.listeners.get(name)?.({ payload });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks(); fixture.listeners.clear(); fixture.offs = [];
  fixture.state = { bySession: { "claude/s": { messages: [{ role: "plan_review", seq: 1, ts: null, text: "Plan", planReview: record("awaiting_review") }] } },
    openTabs: [{ engine: "claude", sessionId: "s" }], refreshWorkspaces: vi.fn(), refreshSessions: vi.fn() };
  fixture.list.mockResolvedValue([record("deferred")]);
});

it("syncs another surface's deferred decision and reconnects host snapshots", async () => {
  const stop = startCollaborationRuntime(); await flush();
  fire("plan-review://changed", { engine: "claude", sessionId: "s" }); await flush();
  expect(fixture.state.bySession["claude/s"].messages[0].planReview?.status).toBe("deferred");
  fire("sessions://changed");
  expect(fixture.state.refreshWorkspaces).toHaveBeenCalledTimes(1);
  fire("transport://connected"); await flush();
  expect(fixture.state.refreshWorkspaces).toHaveBeenCalledTimes(2);
  expect(fixture.state.refreshSessions).toHaveBeenCalledTimes(1);
  expect(fixture.list).toHaveBeenCalledTimes(2);
  fire("skills://changed");
  expect(fixture.invalidateSkills).toHaveBeenCalledTimes(2);
  fire("engine-config://changed", { engine: "pi" });
  expect(fixture.notifyConfig).toHaveBeenCalledTimes(2);
  stop(); expect(fixture.offs.every((off) => off.mock.calls.length === 1)).toBe(true);
});

it("ignores stale responses and results arriving after teardown", async () => {
  let resolveOld!: (records: PlanReview[]) => void;
  fixture.list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const stop = startCollaborationRuntime(); await flush();
  fire("plan-review://changed", { engine: "claude", sessionId: "s" });
  fire("plan-review://changed", { engine: "claude", sessionId: "s" }); await flush();
  resolveOld([record("awaiting_review")]); await flush();
  expect(fixture.state.bySession["claude/s"].messages[0].planReview?.status).toBe("deferred");
  fixture.list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  fire("plan-review://changed", { engine: "claude", sessionId: "s" }); stop();
  resolveOld([record("approved")]); await flush();
  expect(fixture.state.bySession["claude/s"].messages[0].planReview?.status).toBe("deferred");
});

it("cleans subscriptions which resolve after unmount", async () => {
  const stop = startCollaborationRuntime(); stop(); await flush();
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.offs.every((off) => off.mock.calls.length === 1)).toBe(true);
});
