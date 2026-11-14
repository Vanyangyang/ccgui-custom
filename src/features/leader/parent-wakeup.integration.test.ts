import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { useSessionSendCostGuardStore } from "@/features/chat/cross-session-cost";
import { invoke } from "@/lib/transport";
import { startLeaderRuntime } from "./runtime";
import { useLeaderStore } from "./store";

const host = vi.hoisted(() => ({
  ready: vi.fn(async () => {}), known: vi.fn(() => true), inspect: vi.fn(() => "idle"),
  openBackground: vi.fn(async () => {}), wasInterrupted: vi.fn(() => false),
  idleForContinuation: vi.fn(() => true),
  subscribe: vi.fn(() => () => {}), continueMessage: vi.fn(),
}));
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/plugins/runtime/task-facade", async (original) => ({
  ...await original<typeof import("@/features/plugins/runtime/task-facade")>(), desktopTaskFacade: async () => host,
}));

const parent = { engine: "codex", sessionId: "parent", workspacePath: "/parent-project" };
const key = sessionKey(parent.engine, parent.sessionId, parent.workspacePath);
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  host.inspect.mockReturnValue("idle"); host.idleForContinuation.mockReturnValue(true);
  host.continueMessage.mockImplementation(async (_ref, text, _images, runId, beforeDelivery, _launch, onUserRow, beforeSpawn) => {
    await beforeDelivery("turn", runId);
    await onUserRow?.({ runId, seq: 1, ts: null, text });
    await beforeSpawn?.();
    return { delivery: "turn", runId };
  });
  useChatStore.setState({ initialized: true, sessions: [], archivedSessionKeys: {},
    openTabs: [parent], active: { engine: "agy", sessionId: "other", workspacePath: "/other" },
    bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [] } }, drafts: { [key]: "unsent human draft" } });
  useCrossSessionActivityStore.getState().reset();
  useSessionSendCostGuardStore.getState().reset();
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, error: null });
});

it("wakes when a streaming Claude parent changes only from running to waiting", async () => {
  const claude = { ...parent, engine: "claude" }, claudeKey = sessionKey(claude.engine, claude.sessionId, claude.workspacePath);
  const streamingByKey = { [claudeKey]: true as const };
  useChatStore.setState({ openTabs: [claude], streamingByKey, bySession: {
    [claudeKey]: { ...EMPTY_SESSION, messages: [], queue: [], streaming: true, nativeActivity: "running" },
  } });
  host.inspect.mockReturnValue("busy");
  host.idleForContinuation.mockImplementation(() => useChatStore.getState().bySession[claudeKey].nativeActivity === "waiting");
  let state = "pending";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_parent_wakeups") return state === "pending" ? [{ id: "waiting-wake", branchId: "child", parent: claude, requestId: "assignment", childRunId: "child-run", state }] : [];
    if (command === "task_claim_parent_wakeup") { state = "starting"; return true; }
    if (command === "task_resolve_parent_wakeup") { state = (args as { outcome: string }).outcome; return true; }
    return { leaders: [], branches: [] };
  });
  stop = startLeaderRuntime();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("task_parent_wakeups", {}));
  expect(host.continueMessage).not.toHaveBeenCalled();
  useChatStore.setState(state => ({ bySession: { ...state.bySession, [claudeKey]: { ...state.bySession[claudeKey], nativeActivity: "waiting" } } }));
  await vi.waitFor(() => expect(state).toBe("delivered"));
  expect(useChatStore.getState().streamingByKey).toBe(streamingByKey);
  expect(host.continueMessage).toHaveBeenCalledTimes(1);
});
afterEach(() => { stop?.(); stop = undefined; });

it("wakes an ended parent for a durably completed Handoff successor without focusing or resending the child", async () => {
  const notice = { id: "completion-id", branchId: "handoff-successor", parent, requestId: "handoff-request",
    childRunId: "child-run", state: "pending" };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_parent_wakeups") return notice.state === "pending" ? [{ ...notice }] : [];
    if (command === "task_claim_parent_wakeup") { notice.state = "starting"; return true; }
    if (command === "task_resolve_parent_wakeup") { notice.state = (args as { outcome: string }).outcome; return true; }
    return { leaders: [], branches: [] };
  });
  host.continueMessage.mockImplementation(async (_ref, _text, _images, runId, beforeDelivery, _launch, onUserRow, beforeSpawn) => {
    await beforeDelivery("turn", runId);
    await onUserRow?.({ runId, seq: 1, ts: null, text: _text });
    await beforeSpawn?.();
    return { delivery: "turn", runId };
  });
  stop = startLeaderRuntime();
  await vi.waitFor(() => expect(host.continueMessage).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(notice.state).toBe("delivered"));
  const [ref, prompt, images] = host.continueMessage.mock.calls[0];
  expect(ref).toEqual(parent);
  expect(prompt).toContain("handoff-successor");
  expect(prompt).toContain("task_wait");
  expect(images).toEqual([]);
  expect(useChatStore.getState().active?.sessionId).toBe("other");
  expect(useChatStore.getState().drafts[key]).toBe("unsent human draft");
  expect(invoke).not.toHaveBeenCalledWith("task_send", expect.anything());
});

it("reuses the parent's existing Windows path spelling", async () => {
  const visible = { ...parent, workspacePath: "G:\\project" };
  useChatStore.setState({ openTabs: [visible] });
  let state = "pending";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_parent_wakeups") return state === "pending" ? [{ id: "alias-wake", branchId: "child", parent: { ...parent, workspacePath: "g:/project" }, requestId: "assignment", childRunId: "child-run", state }] : [];
    if (command === "task_claim_parent_wakeup") { state = "starting"; return true; }
    if (command === "task_resolve_parent_wakeup") { state = (args as { outcome: string }).outcome; return true; }
    return { leaders: [], branches: [] };
  });
  stop = startLeaderRuntime();
  await vi.waitFor(() => expect(state).toBe("delivered"));
  expect(host.continueMessage.mock.calls[0][0]).toEqual(visible);
  expect(host.openBackground).not.toHaveBeenCalled();
  expect(useChatStore.getState().openTabs).toEqual([visible]);
});
