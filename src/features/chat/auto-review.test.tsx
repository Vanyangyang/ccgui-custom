import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type CodexApproval } from "@/lib/ipc";
import { PermissionMenu } from "@/components/application/ai-chat/permission-menu";
import { useChatStore } from "./store";
import { handleEngineEvents, settleOrphanedRuns, type EngineEventDeps, type ChatEngineEvent } from "./store/engine-events";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { type AutoReview, readAutoReview } from "./store/auto-review";
import { AutoReviewCard } from "./components/AutoReviewCard";
import { QuestionDock } from "./components/QuestionDock";
import { SessionScope } from "./split/session-scope";
import { localizeRunError } from "./run-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/ipc", () => ({ ipc: {
  answerQuestion: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}), rescanSessions: vi.fn(async () => {}),
} }));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn(async () => () => {}), listenSessionsChanged: vi.fn(async () => () => {}), listenComputerUseEscape: vi.fn(async () => () => {}) }));

const KEY = "codex/review-thread";
let run = 0;
let runId: string;
let host: HTMLDivElement;
let root: Root;
const deps = (): EngineEventDeps => ({ set: useChatStore.setState, get: useChatStore.getState, drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn() });
const rows = () => useChatStore.getState().bySession[KEY]!.messages;
const review = (status: AutoReview["review"]["status"] = "inProgress"): AutoReview => ({ threadId: "review-thread", turnId: "turn", reviewId: "review", targetItemId: "item", startedAtMs: 10, ...(status === "inProgress" ? {} : { completedAtMs: 20 }), review: { status, riskLevel: "high", userAuthorization: "low", rationale: "Writes outside workspace" }, action: { type: "command", source: "agent", command: "touch /outside/file", cwd: "/workspace" } });
const event = (kind: ChatEngineEvent["kind"], data: unknown): ChatEngineEvent => ({ runId, sessionId: "review-thread", engine: "codex", seq: 1, kind, data });
const approval = (extra: Partial<CodexApproval> = {}) => ({ kind: "command" as const, canApprove: true, grantScope: "once" as const, reason: "Need access", details: { command: "touch /outside/file" }, ...extra });
function ask(extra: Partial<CodexApproval> = {}) {
  handleEngineEvents([event("question", { requestId: "request", input: { codexApproval: approval(extra), questions: [{ question: "Approval", header: "Approval", options: [] }] } })], deps());
}
const answer = () => rows().find((m) => m.question)!.question!;
const respond = (decision: string) => useChatStore.getState().respondToQuestion(KEY, rows().find((m) => m.question)!.seq, { decision });
async function mountDock() {
  await act(async () => root.render(<SessionScope session={{ engine: "codex", sessionId: "review-thread", workspacePath: "/workspace" }}><QuestionDock /></SessionScope>));
}
function button(text: string) { return [...host.querySelectorAll("button")].find((b) => b.textContent === text)!; }

beforeEach(async () => {
  runId = `auto-review-test-${++run}`;
  vi.clearAllMocks();
  vi.mocked(ipc.answerQuestion).mockResolvedValue(undefined);
  localStorage.clear(); runRouting.clear(); runRouting.set(runId, KEY);
  useChatStore.setState({ active: { engine: "codex", sessionId: "other", workspacePath: "/other" }, openTabs: [], unseen: {}, retryingByKey: {}, streamingByKey: { [KEY]: true }, bySession: { [KEY]: { ...EMPTY_SESSION, streaming: true, messages: [] } } });
  await i18n.changeLanguage("en");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("automatic review lifecycle", () => {
  it("ignores malformed review text without exposing an invalid render value", () => {
    handleEngineEvents([event("auto_review", { ...review(), review: { ...review().review, rationale: { invalid: true } } })], deps());
    expect(rows()).toHaveLength(0);
  });
  it("upserts duplicates and never regresses a completion even when it arrives first", () => {
    handleEngineEvents([event("auto_review", review("denied")), event("auto_review", review()), event("auto_review", review("approved"))], deps());
    expect(rows()).toHaveLength(1); expect(readAutoReview(rows()[0].args)?.review.status).toBe("denied");
  });
  it("updates a started review in place and preserves unrelated references", () => {
    handleEngineEvents([event("auto_review", review())], deps());
    const first = rows()[0];
    handleEngineEvents([event("auto_review", review())], deps()); expect(rows()[0]).toBe(first);
    handleEngineEvents([event("auto_review", review("approved"))], deps());
    expect(rows()[0].seq).toBe(first.seq); expect(readAutoReview(rows()[0].args)?.review.status).toBe("approved");
  });
  it.each(["done", "error"] as const)("aborts unfinished records on %s and ignores late starts", (kind) => {
    handleEngineEvents([event("auto_review", review()), event(kind, kind === "error" ? "failed" : {})], deps());
    handleEngineEvents([event("auto_review", { ...review(), reviewId: "late" })], deps());
    expect(rows().filter((m) => m.role === "auto_review")).toHaveLength(1);
    expect(readAutoReview(rows()[0].args)?.review.status).toBe("aborted");
    expect(useChatStore.getState().bySession[KEY]?.streaming).toBe(false);
  });
  it("aborts on orphan recovery and ignores events while interrupted", () => {
    handleEngineEvents([event("auto_review", review())], deps()); settleOrphanedRuns(useChatStore.setState, [[runId, KEY]]);
    expect(readAutoReview(rows()[0].args)?.review.status).toBe("aborted");
    handleEngineEvents([event("auto_review", { ...review(), reviewId: "orphan-late" })], deps()); expect(rows()).toHaveLength(1);
    useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY]!, interrupted: true } } }));
    handleEngineEvents([event("auto_review", { ...review(), reviewId: "late" })], deps()); expect(rows()).toHaveLength(1);
  });
  it("rejects a mismatched thread and does not write into the active session", () => {
    handleEngineEvents([event("auto_review", { ...review(), threadId: "other" })], deps()); expect(rows()).toHaveLength(0);
    handleEngineEvents([event("auto_review", review())], deps()); expect(rows()).toHaveLength(1);
    expect(useChatStore.getState().bySession["codex/other"]).toBeUndefined();
  });
  it("renders stored role/args without live state and never offers an override", async () => {
    const { threadId: _threadId, ...history } = review("denied");
    await act(async () => root.render(<AutoReviewCard message={{ role: "auto_review", args: history, seq: 1, text: "", ts: null }} />));
    expect(host.textContent).toContain("Denied"); expect(host.textContent).toContain("touch /outside/file"); expect(host.querySelector("button")).toBeNull();
  });
  it("requires explicit thread identity on a live review event", () => {
    const { threadId: _threadId, ...history } = review();
    handleEngineEvents([event("auto_review", history)], deps());
    expect(rows()).toHaveLength(0);
  });
});

describe("permission fallback through the shared question pipe", () => {
  it.each(["allow_once", "decline"])("submits %s against the scoped session", async (decision) => {
    ask(); await mountDock();
    await act(async () => button(decision === "allow_once" ? "Allow once" : "Deny").click());
    expect(ipc.answerQuestion).toHaveBeenCalledWith(runId, "request", { decision });
    expect(answer()).toMatchObject({ status: "answered", answers: { decision } });
    expect(host.querySelector("textarea")).toBeNull();
  });
  it("prevents duplicate writes and keeps failure pending with visible retry feedback", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(ipc.answerQuestion).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    ask(); await mountDock();
    let pending!: Promise<void>;
    await act(async () => { pending = respond("allow_once"); void respond("allow_once"); });
    expect(ipc.answerQuestion).toHaveBeenCalledTimes(1); expect(button("Allow once").disabled).toBe(true);
    await act(async () => { reject(new Error("pipe unavailable")); await pending; });
    expect(answer().status).toBe("pending"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("pipe unavailable");
    expect(button("Allow once").disabled).toBe(false);
  });
  it("disables unavailable approval and explains turn-scoped permissions", async () => {
    ask({ kind: "permissions", grantScope: "turn", canApprove: false }); await mountDock();
    expect(button("Allow for this turn").disabled).toBe(true); expect(host.textContent).toContain("expire when this turn ends");
    await respond("allow_once"); expect(ipc.answerQuestion).not.toHaveBeenCalled();
  });
  it.each(["allow_once", "decline"])("shares the confirmed %s decision with an observing Web client", (decision) => {
    ask(); handleEngineEvents([event("question_settled", { requestId: "request", answers: { decision } })], deps());
    expect(answer()).toMatchObject({ status: "answered", answers: { decision } }); expect(ipc.answerQuestion).not.toHaveBeenCalled();
  });
  it("does not let an IPC receipt resurrect a cancelled request", async () => {
    let resolve!: () => void; vi.mocked(ipc.answerQuestion).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    ask(); const pending = respond("allow_once");
    handleEngineEvents([event("question_settled", { requestId: "request" })], deps()); resolve(); await pending;
    expect(answer().status).toBe("cancelled");
  });
  it.each([true, false])("preserves a confirmed result when native resolution arrives first=%s", async (first) => {
    let resolve!: () => void; vi.mocked(ipc.answerQuestion).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    ask(); const pending = respond("allow_once");
    if (first) handleEngineEvents([event("question_settled", { requestId: "request", answers: { decision: "allow_once" } })], deps());
    resolve(); await pending;
    if (!first) handleEngineEvents([event("question_settled", { requestId: "request", answers: { decision: "allow_once" } })], deps());
    expect(answer()).toMatchObject({ status: "answered", answers: { decision: "allow_once" }, submitting: false });
  });
});

describe.each([true, false])("request identity across runs (approval=%s)", (isApproval) => {
  function frame() {
    return event("question", { requestId: "0", input: {
      ...(isApproval ? { codexApproval: approval() } : {}),
      questions: [{ question: "Pick", header: "Pick", options: [{ label: "A" }] }],
    } });
  }
  const choices = (): Record<string, string> => isApproval ? { decision: "allow_once" } : { Pick: "A" };
  const questions = () => rows().filter(m => m.question);
  function nextRun() {
    handleEngineEvents([event("done", {})], deps());
    runId += "-next";
    handleEngineEvents([frame()], deps());
  }

  it("creates an answerable second card when a new process reuses an answered RPC id", async () => {
    handleEngineEvents([frame()], deps());
    await useChatStore.getState().respondToQuestion(KEY, questions()[0].seq, choices());
    const oldRun = runId;
    nextRun();
    expect(questions()).toHaveLength(2);
    const old = questions()[0];
    const current = questions()[1];
    expect(current.question).toMatchObject({ runId, requestId: "0", status: "pending" });
    handleEngineEvents([{ ...event("question_settled", { requestId: "0" }), runId: oldRun }], deps());
    expect(questions()[1]).toBe(current);
    await useChatStore.getState().respondToQuestion(KEY, current.seq, choices());
    expect(ipc.answerQuestion).toHaveBeenLastCalledWith(runId, "0", choices());
    expect(questions()[1].question?.status).toBe("answered");
    expect(questions()[0].question).toEqual(old.question);
  });

  it.each(["success", "failure"])("a late old-run IPC %s cannot patch the next card or its feedback", async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    vi.mocked(ipc.answerQuestion).mockImplementationOnce(() => new Promise((ok, fail) => { resolve = ok; reject = fail; }));
    handleEngineEvents([frame()], deps());
    const oldRun = runId;
    const pending = useChatStore.getState().respondToQuestion(KEY, questions()[0].seq, choices());
    handleEngineEvents([event("question_settled", { requestId: "0" })], deps());
    nextRun();
    const current = questions()[1];
    expect(current).toBeDefined();
    handleEngineEvents([{ ...event("question_settled", { requestId: "0" }), runId: oldRun }], deps());
    if (outcome === "success") resolve(); else reject(new Error("old run pipe failed"));
    await pending;
    expect(questions()[0].question?.status).toBe("cancelled");
    expect(questions()[1]).toBe(current);
    expect(questions()[1].question).toMatchObject({ status: "pending", runId });
    expect(useChatStore.getState().bySession[KEY]?.error).toBeNull();
    await useChatStore.getState().respondToQuestion(KEY, current.seq, choices());
    expect(ipc.answerQuestion).toHaveBeenLastCalledWith(runId, "0", choices());
    expect(questions()[1].question?.status).toBe("answered");
  });
});

describe("capability-driven labels", () => {
  it.each([true, false])("uses the advertised capability %s", async (supportsAutoReview) => {
    await act(async () => root.render(<PermissionMenu supportsAutoReview={supportsAutoReview} />));
    expect(host.textContent).toContain(supportsAutoReview ? "Auto-review" : "Auto");
    if (!supportsAutoReview) expect(host.textContent).not.toContain("Auto-review");
  });
  it("localizes unavailable configuration and preserves diagnostics", () => {
    expect(localizeRunError("CODEX_AUTO_REVIEW_UNAVAILABLE: reviewer not active", i18n.t.bind(i18n))).toContain("reviewer not active");
    expect(localizeRunError("CODEX_AUTO_REVIEW_UNAVAILABLE: reviewer not active", i18n.t.bind(i18n))).toContain("Check the CLI version");
  });
  it.each(["en", "zh"])("localizes unsupported approvals in %s and preserves diagnostics", async (language) => {
    await i18n.changeLanguage(language);
    const text = localizeRunError("CODEX_APPROVAL_UNSUPPORTED: verification code schema", i18n.t.bind(i18n));
    expect(text).toContain(i18n.t("chat.codexApproval.unsupported"));
    expect(text).toContain("verification code schema");
    expect(text).not.toContain("CODEX_APPROVAL_UNSUPPORTED:");
    expect(text).toContain(language === "zh" ? "已拒绝" : "was denied");
  });
});
