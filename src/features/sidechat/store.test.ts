import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { handleSideRunEvent, migrateSidechatSessionKey, useSidechatStore } from "./store";

vi.mock("@/lib/ipc", () => ({ ipc: {
  sendSideMessage: vi.fn(), interruptSession: vi.fn(), cleanupSideSession: vi.fn(), promoteSideSession: vi.fn(),
} }));

const args = { sessionKey: "claude:parent", engine: "claude", workspacePath: "G:/workspace", parentSessionId: "parent", parentMessages: [] };
const state = () => useSidechatStore.getState();
function event(runId: string, seq: number, kind: string, data: unknown) {
  handleSideRunEvent({ runId, seq, kind, data, engine: "claude", sessionId: null });
}
beforeEach(() => {
  vi.resetAllMocks();
  useSidechatStore.setState({ btwBySession: {}, sidechatBySession: {} });
  vi.mocked(ipc.sendSideMessage).mockResolvedValue({ runId: "unused", sessionId: "side" });
  vi.mocked(ipc.interruptSession).mockResolvedValue(true);
  vi.mocked(ipc.cleanupSideSession).mockResolvedValue(undefined);
  vi.mocked(ipc.promoteSideSession).mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("side run event progress", () => {
  it.each(["sidechat", "btw"] as const)("keeps %s alive across empty-usage response boundaries and approval waits", async (kind) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    if (kind === "btw") await state().askBtw({ ...args, question: "check" });
    else await state().sendSidechatMessage({ ...args, prompt: "check" });
    const current = () => kind === "btw" ? state().btwBySession[args.sessionKey] : state().sidechatBySession[args.sessionKey];
    const run = current().runId!;
    event(run, 1, "delta", "原文😀");
    const content = () => kind === "btw" ? state().btwBySession[args.sessionKey].answer : state().sidechatBySession[args.sessionKey].messages;
    const before = content();
    clock.mockReturnValue(200);
    event(run, 2, "turn_complete", { usage: null });
    expect(current()).toMatchObject({ streaming: true, runId: run, progress: { phase: "waiting", lastEventAt: 200 } });
    expect(content()).toBe(before);
    event(run, 3, "question", { requestId: "approval-1", input: { codexApproval: { kind: "command", canApprove: true, grantScope: "once", details: { command: "echo hello" } } } });
    expect(current().progress?.phase).toBe("waiting_user");
    clock.mockReturnValue(300);
    event(run, 4, "turn_complete", { usage: null });
    expect(current().progress).toEqual({ phase: "waiting_user", lastEventAt: 300 });
    event(run, 5, "question_settled", { requestId: "approval-1" });
    expect(current().progress?.phase).toBe("waiting");
    event(run, 6, "activity", { state: "waiting" });
    clock.mockReturnValue(400);
    event(run, 7, "turn_complete", { usage: null });
    expect(current().progress).toEqual({ phase: "waiting_task", lastEventAt: 400 });
    event(run, 8, "delta", "继续");
    expect(current()).toMatchObject({ streaming: true, runId: run, progress: { phase: "responding" } });
  });

  it.each(["sidechat", "btw"] as const)("tracks %s activity and ignores duplicate, other-run and terminal-late events", async (kind) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    if (kind === "btw") await state().askBtw({ ...args, question: "check" });
    else await state().sendSidechatMessage({ ...args, prompt: "check" });
    const current = () => kind === "btw" ? state().btwBySession[args.sessionKey] : state().sidechatBySession[args.sessionKey];
    const run = current().runId!;
    expect(current().progress).toEqual({ phase: "starting", lastEventAt: null });
    clock.mockReturnValue(200);
    event(run, 1, "session", "side");
    expect(current().progress).toEqual({ phase: "waiting", lastEventAt: 200 });
    clock.mockReturnValue(300);
    event(run, 2, "thinking", "思考😀");
    expect(current().progress).toEqual({ phase: "thinking", lastEventAt: 300 });
    clock.mockReturnValue(400);
    event(run, 1, "delta", "out of order");
    event(run, 2, "delta", "duplicate");
    event("sidechat-other", 99, "delta", "other");
    expect(current().progress?.lastEventAt).toBe(300);
    event(run, 3, "message", { role: "tool", text: "Read" });
    expect(current().progress).toEqual({ phase: "tool", toolName: "Read", lastEventAt: 400 });
    event(run, 4, "message", { role: "tool", text: "Read", patch: true, result: "ok" });
    expect(current().progress?.phase).toBe("waiting");
    event(run, 5, "retry", { attempt: 1, max: 2, message: "retrying" });
    expect(current().progress?.phase).toBe("retrying");
    event(run, 6, "warn", "busy");
    expect(current().progress?.detail).toBe("busy");
    event(run, 7, "compaction", { active: true });
    expect(current().progress?.phase).toBe("compacting");
    event(run, 8, "activity", { state: "waiting" });
    expect(current().progress?.phase).toBe("waiting_task");
    const notify = vi.fn();
    const unsubscribe = useSidechatStore.subscribe(notify);
    event(run, 9, "delta", "回答😀");
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(current().progress?.phase).toBe("responding");
    clock.mockReturnValue(500);
    event(run, 10, "usage", { input_tokens: 12, output_tokens: 4 });
    expect(current().progress).toEqual({ phase: "responding", lastEventAt: 500 });
    event(run, 11, "done", {});
    const finished = current();
    clock.mockReturnValue(600);
    event(run, 12, "thinking", "late");
    expect(current()).toBe(finished);
    if (kind === "btw") await state().askBtw({ ...args, question: "again" });
    else await state().sendSidechatMessage({ ...args, prompt: "again" });
    expect(current().progress).toEqual({ phase: "starting", lastEventAt: null });
    expect(current().runId).not.toBe(run);
    event(run, 13, "warn", "old run");
    expect(current().progress).toEqual({ phase: "starting", lastEventAt: null });
  });

  it.each(["stop", "error"] as const)("does not refresh progress after %s and clears progress on reset", async (end) => {
    await state().sendSidechatMessage({ ...args, prompt: "check" });
    const run = state().sidechatBySession[args.sessionKey].runId!;
    event(run, 1, "delta", "answer");
    if (end === "stop") await state().stopSidechat(args.sessionKey);
    else event(run, 2, "error", "failed");
    const finished = state().sidechatBySession[args.sessionKey];
    event(run, 3, "activity", { state: "running" });
    expect(state().sidechatBySession[args.sessionKey]).toBe(finished);
    await state().resetSidechat(args.sessionKey);
    expect(state().sidechatBySession[args.sessionKey].progress).toBeUndefined();
  });
});

describe("Sidechat isolated lifecycle", () => {
  it("sends image-only attachments and clears only the accepted draft images", async () => {
    await state().openSidechat(args);
    state().updateSidechatImages(args.sessionKey, () => ["/shot.png"]);
    let resolve!: (value: { runId: string; sessionId: string }) => void;
    vi.mocked(ipc.sendSideMessage).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const accepted = vi.fn();
    const sending = state().sendSidechatMessage({ ...args, prompt: "", images: ["/shot.png"], onAccepted: accepted });
    expect(ipc.sendSideMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "", imagePaths: ["/shot.png"], ephemeral: false }));
    state().updateSidechatImages(args.sessionKey, (paths) => [...paths, "/later.png"]);
    expect(accepted).not.toHaveBeenCalled();
    resolve({ runId: "unused", sessionId: "side" }); await sending;
    expect(accepted).toHaveBeenCalledOnce();
    expect(state().sidechatBySession[args.sessionKey].draftImages).toEqual(["/later.png"]);
    expect(state().sidechatBySession[args.sessionKey].messages[0].images).toEqual(["/shot.png"]);
  });

  it("retains a failed screenshot draft and does not acknowledge failed btw sends", async () => {
    vi.mocked(ipc.sendSideMessage).mockRejectedValue(new Error("launch failed"));
    const accepted = vi.fn();
    await state().sendSidechatMessage({ ...args, prompt: "看图 🙂", images: ["/shot.png"], onAccepted: accepted });
    expect(state().sidechatBySession[args.sessionKey]).toMatchObject({ draft: "看图 🙂", draftImages: ["/shot.png"], error: "launch failed" });
    await state().askBtw({ ...args, question: "", images: ["/btw.png"], onAccepted: accepted });
    expect(ipc.sendSideMessage).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "", imagePaths: ["/btw.png"], ephemeral: true }));
    expect(state().btwBySession[args.sessionKey].images).toEqual(["/btw.png"]);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("keeps authoritative snapshots, later assistant blocks and duplicate events ordered", async () => {
    await state().sendSidechatMessage({ ...args, prompt: "explain" });
    const run = state().sidechatBySession[args.sessionKey].runId!;
    event(run, 1, "delta", "partial");
    event(run, 1, "delta", "duplicate");
    event(run, 2, "message", { role: "assistant", text: "partial complete 中文😀" });
    event(run, 3, "message", { role: "tool", text: "Read" });
    event(run, 4, "delta", "second");
    event(run, 5, "message", { role: "assistant", text: "second complete" });
    event(run, 6, "done", {});
    expect(state().sidechatBySession[args.sessionKey].messages.filter(m => m.role === "assistant").map(m => m.text))
      .toEqual(["partial complete 中文😀", "second complete"]);
    expect(state().sidechatBySession[args.sessionKey].streaming).toBe(false);
  });

  it("sends imported btw context to an existing native side branch exactly once", async () => {
    await state().sendSidechatMessage({ ...args, prompt: "first" });
    event(state().sidechatBySession[args.sessionKey].runId!, 1, "done", { sessionId: "side" });
    await state().askBtw({ ...args, question: "btw question" });
    const btwRun = state().btwBySession[args.sessionKey].runId;
    event(btwRun, 1, "message", { role: "assistant", text: "btw answer" });
    event(btwRun, 2, "done", {});
    state().continueBtwInSidechat(args.sessionKey);
    await state().sendSidechatMessage({ ...args, prompt: "follow up" });
    expect(vi.mocked(ipc.sendSideMessage).mock.lastCall?.[0]).toMatchObject({ sideSessionId: "side", fallbackTranscript: null });
    expect(vi.mocked(ipc.sendSideMessage).mock.lastCall?.[0].prompt).toContain("btw answer");
    event(state().sidechatBySession[args.sessionKey].runId!, 1, "done", {});
    await state().sendSidechatMessage({ ...args, prompt: "next" });
    expect(vi.mocked(ipc.sendSideMessage).mock.lastCall?.[0].prompt).toBe("next");
  });

  it("does not duplicate seeded history when the parent requires transcript fallback", async () => {
    await state().askBtw({ ...args, question: "seed question" });
    event(state().btwBySession[args.sessionKey].runId, 1, "done", {});
    state().continueBtwInSidechat(args.sessionKey);
    await state().sendSidechatMessage({ ...args, prompt: "follow up" });
    const sent = vi.mocked(ipc.sendSideMessage).mock.lastCall![0];
    expect(sent.prompt).toContain("seed question");
    expect(sent.fallbackTranscript ?? "").not.toContain("seed question");
  });

  it("keeps the previous btw and its event route when interruption fails", async () => {
    await state().askBtw({ ...args, question: "old" });
    const run = state().btwBySession[args.sessionKey].runId;
    vi.mocked(ipc.interruptSession).mockRejectedValueOnce(new Error("stop failed"));
    await state().askBtw({ ...args, question: "new" });
    event(run, 1, "delta", "still live");
    expect(ipc.sendSideMessage).toHaveBeenCalledTimes(1);
    expect(state().btwBySession[args.sessionKey]).toMatchObject({ question: "old", answer: "still live", error: "stop failed" });
  });

  it("retains the branch and reports reset/promote failures", async () => {
    await state().sendSidechatMessage({ ...args, prompt: "keep this" });
    event(state().sidechatBySession[args.sessionKey].runId!, 1, "done", {});
    vi.mocked(ipc.cleanupSideSession).mockRejectedValueOnce(new Error("file busy"));
    await state().resetSidechat(args.sessionKey);
    expect(state().sidechatBySession[args.sessionKey]).toMatchObject({ sideSessionId: "side", error: "file busy" });
    expect(state().sidechatBySession[args.sessionKey].messages[0].text).toBe("keep this");
    vi.mocked(ipc.promoteSideSession).mockRejectedValueOnce(new Error("promote failed"));
    expect(await state().promoteSidechatToTab(args.sessionKey)).toBeNull();
    expect(state().sidechatBySession[args.sessionKey].error).toBe("promote failed");
    expect(ipc.promoteSideSession).toHaveBeenCalledWith("claude", "side", "G:/workspace", "parent");
  });

  it("does not roll back text arriving while a failed stop is pending", async () => {
    await state().askBtw({ ...args, question: "old" });
    const run = state().btwBySession[args.sessionKey].runId;
    let reject!: (error: Error) => void;
    vi.mocked(ipc.interruptSession).mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    const stopping = state().stopBtw(args.sessionKey);
    event(run, 1, "delta", "arrived during stop 中文😀");
    reject(new Error("transport lost"));
    await stopping;
    expect(state().btwBySession[args.sessionKey]).toMatchObject({ answer: "arrived during stop 中文😀", streaming: true, error: "transport lost" });
  });

  it("settles a launch failure after the parent tab migrates", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(ipc.sendSideMessage).mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    const pending = state().sendSidechatMessage({ ...args, parentSessionId: null, prompt: "new parent" });
    migrateSidechatSessionKey(args.sessionKey, "claude:real", "real");
    reject(new Error("launch failed"));
    await pending;
    expect(state().sidechatBySession["claude:real"]).toMatchObject({ streaming: false, error: "launch failed", parentSessionId: null });
  });

  it("interrupts an in-flight sidechat run and settles parallel same-name tools when sending a follow-up", async () => {
    await state().sendSidechatMessage({ ...args, prompt: "first question" });
    const firstRun = state().sidechatBySession[args.sessionKey].runId!;
    event(firstRun, 1, "message", { role: "tool", text: "view_file", path: "a.rs" });
    event(firstRun, 2, "message", { role: "tool", text: "view_file", path: "b.rs" });
    event(firstRun, 3, "message", { role: "tool", text: "view_file", patch: true, result: "ok-b" });
    event(firstRun, 4, "message", { role: "tool", text: "view_file", patch: true, result: "ok-a" });
    event(firstRun, 5, "delta", "partial reply");
    const tools = state().sidechatBySession[args.sessionKey].messages.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.live)).toEqual([false, false]);

    await state().sendSidechatMessage({ ...args, prompt: "啥情况了？" });
    expect(ipc.interruptSession).toHaveBeenCalledWith(firstRun);
    const secondRun = state().sidechatBySession[args.sessionKey].runId!;
    expect(secondRun).not.toBe(firstRun);
    event(firstRun, 6, "delta", "late from interrupted run");
    const messages = state().sidechatBySession[args.sessionKey].messages;
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["first question", "啥情况了？"]);
    expect(messages.find((m) => m.role === "assistant")?.text).toBe("partial reply");
    expect(messages.find((m) => m.role === "assistant")?.live).toBe(false);
    expect(state().sidechatBySession[args.sessionKey].streaming).toBe(true);
  });
});
