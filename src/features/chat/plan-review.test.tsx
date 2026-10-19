import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationModeRegistry } from "@ccgui/plugin-sdk";
import i18n from "@/lib/i18n";
import {
  ipc,
  type Message,
  type PlanRespondOutcome,
  type PlanReview,
} from "@/lib/ipc";
import { PlanReviewCard } from "./components/PlanReviewCard";
import { PlanReviewDock, usePlanReviewGateActive } from "./components/PlanReviewDock";
import { ChatConversation } from "./components/ChatConversation";
import { ComposerToolbar } from "@/components/application/ai-chat/composer-toolbar";
import { useChatStore } from "./store";
import {
  handleEngineEvents,
  settledRuns,
  type ChatEngineEvent,
  type EngineEventDeps,
} from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";
import { runRouting } from "./store/stream";
import { getConversationModeState } from "@/features/plugins/conversation/state";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    respondPlanReview: vi.fn(async (): Promise<PlanRespondOutcome> => ({
      outcome: "applied",
      review: recordOf({ status: "approved", execution: "starting" }),
    })),
    listPlanReviews: vi.fn(async () => []),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));
// ChatConversation's composer stack, same seam the plugin conversation-mode
// test uses — the mutex case only needs the mode picker entry.
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/features/plugins/runtime/loader", () => ({
  notePluginRenderOk: vi.fn(),
  reportPluginCrash: vi.fn(),
}));
vi.mock("@/components/application/ai-chat/cli-menu", () => ({ CliMenu: () => null }));
vi.mock("@/components/application/ai-chat/add-menu", () => ({ AddMenu: () => null }));
vi.mock("@/components/application/ai-chat/permission-menu", () => ({ PermissionMenu: () => null }));
vi.mock("@/features/chat/components/use-branch-switcher", () => ({ useBranchSwitcher: () => ({}) }));
vi.mock("@/features/chat/components/use-engine-models", () => ({
  useEngineModels: () => ({
    catalogs: {}, modelsByEngine: {}, channelsByEngine: {}, pendingEngines: {}, refresh: vi.fn(),
  }),
}));
vi.mock("@/features/chat/components/MessageTimeline", () => ({
  MessageTimeline: () => <div data-testid="timeline" />,
}));
vi.mock("@/features/chat/components/ConversationFooter", () => ({
  ConversationFooter: ({ cliMenu, streaming }: { cliMenu?: unknown; streaming?: boolean }) => (
    <div data-testid="footer" data-streaming={String(Boolean(streaming))}>{cliMenu as never}</div>
  ),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ACTIVE = { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws" };

function recordOf(over: Partial<PlanReview> = {}): PlanReview {
  return {
    planId: "p-1",
    engine: "claude",
    sessionId: "s-1",
    workspacePath: "/tmp/ws",
    runId: "run-1",
    revision: 1,
    title: "重构方案",
    content: "# 计划\n\n第一步做 A，第二步做 B。",
    contentHash: "hash-1",
    complete: true,
    reviewKind: "native_request",
    nativePlanId: null,
    execPermission: "manual",
    status: "awaiting_review",
    execution: "not_started",
    decisionIntentAt: null,
    appliedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    supersededBy: null,
    ...over,
  };
}

function planMessage(record: PlanReview): Message {
  return {
    seq: 2,
    role: "plan_review",
    text: record.title,
    ts: null,
    planReview: record,
  };
}

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function draftEvent(text: string, replace = false, planId = "p-1"): ChatEngineEvent {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 1,
    kind: "plan_draft",
    data: { planId, text, replace },
  };
}

function reviewEvent(over: Partial<PlanReview> = {}): ChatEngineEvent {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 2,
    kind: "plan_review",
    data: recordOf(over),
  };
}

function settledEvent(
  planId = "p-1",
  revision = 1,
  status = "approved",
): ChatEngineEvent {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 3,
    kind: "plan_review_settled",
    data: { planId, revision, status },
  };
}

function doneEvent(): ChatEngineEvent {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 4,
    kind: "done",
    data: { usage: null },
  };
}

function planRows() {
  return (useChatStore.getState().bySession[KEY]?.messages ?? []).filter(
    (m) => m.planReview,
  );
}

describe("plan review events → store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    settledRuns.clear();
    runRouting.clear();
    void i18n.changeLanguage("zh");
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "帮我做", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("a draft event creates a preview card; increments append, replace swaps", () => {
    handleEngineEvents([draftEvent("# 第一段")], deps());
    let rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.status).toBe("draft");
    expect(rows[0].planReview?.complete).toBe(false);

    handleEngineEvents([draftEvent("，第二段")], deps());
    rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.content).toBe("# 第一段，第二段");

    handleEngineEvents([draftEvent("# 全新", true)], deps());
    rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.content).toBe("# 全新");
  });

  it("a plan_review upgrades the draft row in place into an actionable card", () => {
    handleEngineEvents([draftEvent("……"), reviewEvent()], deps());
    const rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.status).toBe("awaiting_review");
    expect(rows[0].planReview?.revision).toBe(1);
    expect(rows[0].planReview?.complete).toBe(true);
    expect(rows[0].planReview?.execPermission).toBe("manual");
  });

  it("a newer revision supersedes the still-open older one", () => {
    handleEngineEvents(
      [reviewEvent(), reviewEvent({ revision: 2, contentHash: "h2", content: "v2" })],
      deps(),
    );
    const rows = planRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].planReview?.status).toBe("superseded");
    expect(rows[0].planReview?.supersededBy).toBe(2);
    expect(rows[1].planReview?.status).toBe("awaiting_review");
  });

  it("settled updates the matching row; unknown identities are ignored", () => {
    handleEngineEvents(
      [reviewEvent(), settledEvent("p-1", 1, "expired"), settledEvent("nope", 9, "expired")],
      deps(),
    );
    const rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.status).toBe("expired");
  });

  it("a late duplicate plan_review never resurrects a terminal record", () => {
    handleEngineEvents([reviewEvent(), settledEvent("p-1", 1, "approved")], deps());
    handleEngineEvents([reviewEvent()], deps());
    const rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.status).toBe("approved");
  });

  it("a settled event trailing the run's done still lands (expire path)", () => {
    handleEngineEvents([reviewEvent(), doneEvent(), settledEvent("p-1", 1, "expired")], deps());
    expect(planRows()[0].planReview?.status).toBe("expired");
  });

  it("unknown kinds and malformed records are ignored", () => {
    handleEngineEvents(
      [
        {
          runId: "run-1",
          sessionId: "s-1",
          engine: "claude",
          seq: 5,
          kind: "bogus_kind",
          data: {},
        } as never,
        {
          runId: "run-1",
          sessionId: "s-1",
          engine: "claude",
          seq: 6,
          kind: "plan_review",
          data: { planId: "", revision: "x" },
        } as never,
      ],
      deps(),
    );
    expect(planRows()).toHaveLength(0);
  });
});

describe("PlanReviewDock actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  const buttonByText = (needle: string) =>
    [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(needle),
    );

  function seed(record: PlanReview, streaming = true) {
    useChatStore.setState({
      openTabs: [ACTIVE],
      active: ACTIVE,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming,
          messages: [
            { seq: 1, role: "user", text: "帮我做", ts: null },
            planMessage(record),
          ],
        },
      },
      streamingByKey: streaming ? { [KEY]: true } : {},
    });
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    settledRuns.clear();
    runRouting.clear();
    void i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seed(recordOf());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ active: null, openTabs: [], bySession: {}, streamingByKey: {} });
  });

  it("approve is enabled on a complete awaiting record and submits the CAS triple", async () => {
    vi.mocked(ipc.respondPlanReview).mockResolvedValue({
      outcome: "applied",
      review: recordOf({ status: "approved", execution: "starting" }),
    });
    act(() => root.render(<PlanReviewDock />));
    const approve = buttonByText("批准并执行") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    // The dock shows the execution permission the approval will reuse.
    expect(container.textContent).toContain("沿用执行权限");
    // Default focus must not sit on the dangerous action.
    expect(document.activeElement).not.toBe(approve);
    await act(async () => {
      approve.click();
    });
    expect(vi.mocked(ipc.respondPlanReview)).toHaveBeenCalledWith(
      "p-1",
      1,
      "approve",
      undefined,
    );
    expect(planRows()[0].planReview?.status).toBe("approved");
  });

  it("approve stays disabled on an incomplete record and on a settled one", () => {
    seed(recordOf({ complete: false }));
    act(() => root.render(<PlanReviewDock />));
    expect((buttonByText("批准并执行") as HTMLButtonElement).disabled).toBe(true);
    act(() => root.unmount());

    seed(recordOf({ status: "approved" }));
    root = createRoot(container);
    act(() => root.render(<PlanReviewDock />));
    // A settled revision offers view/copy in the timeline only — no dock.
    expect(buttonByText("批准并执行")).toBeFalsy();
    expect(container.textContent).not.toContain("提出修改");
  });

  it("defer submits without feedback and closes the dock", async () => {
    vi.mocked(ipc.respondPlanReview).mockResolvedValue({
      outcome: "applied",
      review: recordOf({ status: "deferred" }),
    });
    act(() => root.render(<PlanReviewDock />));
    await act(async () => {
      buttonByText("暂不执行")!.click();
    });
    expect(vi.mocked(ipc.respondPlanReview)).toHaveBeenCalledWith(
      "p-1",
      1,
      "defer",
      undefined,
    );
    expect(planRows()[0].planReview?.status).toBe("deferred");
    // The click must have a visible effect: defer settles this approval
    // round, so the dock collapses (the plan stays resumable from its card).
    expect(buttonByText("批准并执行")).toBeFalsy();
    expect(buttonByText("暂不执行")).toBeFalsy();
  });

  it("a deferred card's 继续审批 reopens the dock; a landed decision closes it", async () => {
    const deferred = recordOf({ status: "deferred" });
    seed(deferred);
    act(() =>
      root.render(
        <>
          <PlanReviewCard message={planMessage(deferred)} />
          <PlanReviewDock />
        </>,
      ),
    );
    // Deferred alone does not mount the dock — the round was settled.
    expect(buttonByText("批准并执行")).toBeFalsy();
    expect(container.textContent).toContain("已暂不执行");
    const resume = buttonByText("继续审批") as HTMLButtonElement;
    expect(resume).toBeTruthy();
    await act(async () => {
      resume.click();
    });
    expect(useChatStore.getState().bySession[KEY].planReviewResume).toBe("p-1:1");
    // The dock is back with the full decision set.
    expect(buttonByText("批准并执行")).toBeTruthy();
    expect(buttonByText("提出修改")).toBeTruthy();

    vi.mocked(ipc.respondPlanReview).mockResolvedValue({
      outcome: "applied",
      review: recordOf({ status: "approved", execution: "starting" }),
    });
    await act(async () => {
      buttonByText("批准并执行")!.click();
    });
    expect(planRows()[0].planReview?.status).toBe("approved");
    expect(useChatStore.getState().bySession[KEY].planReviewResume).toBeNull();
    expect(buttonByText("批准并执行")).toBeFalsy();
  });

  it("request-changes requires non-empty feedback; Enter never submits", async () => {
    vi.mocked(ipc.respondPlanReview).mockResolvedValue({
      outcome: "applied",
      review: recordOf({ status: "changes_requested" }),
    });
    act(() => root.render(<PlanReviewDock />));
    await act(async () => {
      buttonByText("提出修改")!.click();
    });
    const submit = buttonByText("提交修改意见") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const textarea = container.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(textarea, "第二步改成先做 C");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(vi.mocked(ipc.respondPlanReview)).not.toHaveBeenCalled();
    await act(async () => {
      submit.click();
    });
    expect(vi.mocked(ipc.respondPlanReview)).toHaveBeenCalledWith(
      "p-1",
      1,
      "request_changes",
      "第二步改成先做 C",
    );
    expect(planRows()[0].planReview?.status).toBe("changes_requested");
  });

  it("a conflict outcome shows the supersession notice and refreshes the record", async () => {
    vi.mocked(ipc.respondPlanReview).mockResolvedValue({
      outcome: "conflict",
      review: recordOf({ status: "expired" }),
    });
    act(() => root.render(<PlanReviewDock />));
    await act(async () => {
      buttonByText("批准并执行")!.click();
    });
    expect(container.textContent).toContain("已被另一窗口或新版本取代");
    expect(planRows()[0].planReview?.status).toBe("expired");
    // The held panel is read-only: no decision affordance survives.
    expect(buttonByText("批准并执行")).toBeFalsy();
    expect(container.textContent).toContain("已失效");
  });

  it("an IPC error keeps the revision open and never fakes approval", async () => {
    vi.mocked(ipc.respondPlanReview).mockRejectedValue(new Error("管道已断开"));
    act(() => root.render(<PlanReviewDock />));
    await act(async () => {
      buttonByText("批准并执行")!.click();
    });
    expect(container.textContent).toContain("提交失败");
    const record = planRows()[0].planReview;
    expect(record?.status).toBe("awaiting_review");
    // The card is actionable again for a retry.
    expect((buttonByText("批准并执行") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a double click submits once", async () => {
    let resolve: ((v: PlanRespondOutcome) => void) | undefined;
    vi.mocked(ipc.respondPlanReview).mockImplementation(
      () => new Promise<PlanRespondOutcome>((r) => { resolve = r; }),
    );
    act(() => root.render(<PlanReviewDock />));
    const approve = buttonByText("批准并执行") as HTMLButtonElement;
    await act(async () => {
      approve.click();
    });
    await act(async () => {
      (buttonByText("批准并执行") as HTMLButtonElement).click();
    });
    expect(vi.mocked(ipc.respondPlanReview)).toHaveBeenCalledTimes(1);
    expect(planRows()[0].planReview?.status).toBe("submitting");
    await act(async () => {
      resolve?.({ outcome: "applied", review: recordOf({ status: "approved" }) });
    });
    expect(planRows()[0].planReview?.status).toBe("approved");
  });
});

describe("PlanReviewCard timeline card & preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  const buttonByText = (needle: string) =>
    [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(needle),
    );

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    void i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders accessible status text for every lifecycle state", () => {
    const cases: Array<[PlanReview["status"], string]> = [
      ["draft", "规划中"],
      ["awaiting_review", "待审批"],
      ["submitting", "提交中"],
      ["approved", "已批准"],
      ["changes_requested", "已请求修改"],
      ["deferred", "暂不执行"],
      ["cancelled", "已取消"],
      ["expired", "已失效"],
      ["superseded", "已被新版本取代"],
    ];
    for (const [status, text] of cases) {
      act(() => root.render(<PlanReviewCard message={planMessage(recordOf({ status }))} />));
      expect(container.textContent).toContain(text);
      expect(container.textContent).toContain("重构方案");
      expect(container.textContent).toContain("claude");
      expect(container.textContent).toContain("版本 1");
    }
  });

  it("a settled revision offers view and copy but no approval affordance", () => {
    act(() =>
      root.render(<PlanReviewCard message={planMessage(recordOf({ status: "approved" }))} />),
    );
    expect(buttonByText("查看完整计划")).toBeTruthy();
    expect(buttonByText("复制原文")).toBeTruthy();
    expect(container.textContent).not.toContain("批准并执行");
    expect(container.textContent).not.toContain("提出修改");
  });

  it("copy writes the raw markdown to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    act(() => root.render(<PlanReviewCard message={planMessage(recordOf())} />));
    await act(async () => {
      buttonByText("复制原文")!.click();
    });
    expect(writeText).toHaveBeenCalledWith(recordOf().content);
  });

  it("the full preview renders markdown; Esc and close never call the IPC", async () => {
    act(() => root.render(<PlanReviewCard message={planMessage(recordOf())} />));
    await act(async () => {
      buttonByText("查看完整计划")!.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain("第一步做 A");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(vi.mocked(ipc.respondPlanReview)).not.toHaveBeenCalled();
    // Re-open and close via the button: still no IPC.
    await act(async () => {
      buttonByText("查看完整计划")!.click();
    });
    await act(async () => {
      (document.querySelector('[aria-label="关闭预览"]') as HTMLButtonElement).click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(vi.mocked(ipc.respondPlanReview)).not.toHaveBeenCalled();
  });
});

describe("plan review history restore (first-page load)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    void i18n.changeLanguage("zh");
    useChatStore.setState({
      openTabs: [],
      active: null,
      sessions: [],
      bySession: {},
      streamingByKey: {},
    });
  });

  it("calls listPlanReviews and merges records after the page applies", async () => {
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({
      messages: [{ seq: 1, role: "user", text: "旧需求", ts: null }],
      nextBefore: null,
      subagentHistory: [],
    });
    // Deliberately newest-first: the merge must sort by revision regardless
    // of backend list ordering.
    vi.mocked(ipc.listPlanReviews).mockResolvedValue([
      recordOf({ revision: 2, status: "awaiting_review", contentHash: "h2" }),
      recordOf({ revision: 1, status: "superseded", supersededBy: 2 }),
    ]);
    await act(async () => {
      await useChatStore.getState().selectSession("claude", "s-1", "/tmp/ws");
    });
    expect(vi.mocked(ipc.listPlanReviews)).toHaveBeenCalledWith("claude", "s-1");
    const messages = useChatStore.getState().bySession[KEY].messages;
    expect(messages.some((m) => m.role === "user")).toBe(true);
    const rows = planRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].planReview?.revision).toBe(1);
    expect(rows[0].planReview?.status).toBe("superseded");
    expect(rows[1].planReview?.revision).toBe(2);
    expect(rows[1].planReview?.status).toBe("awaiting_review");
  });

  it("late live events update the restored row instead of duplicating it", async () => {
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({
      messages: [{ seq: 1, role: "user", text: "旧需求", ts: null }],
      nextBefore: null,
      subagentHistory: [],
    });
    vi.mocked(ipc.listPlanReviews).mockResolvedValue([recordOf()]);
    await act(async () => {
      await useChatStore.getState().selectSession("claude", "s-1", "/tmp/ws");
    });
    handleEngineEvents(
      [reviewEvent({ content: "# 计划 v1.1", contentHash: "h1b" }), settledEvent("p-1", 1, "approved")],
      deps(),
    );
    const rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].planReview?.content).toBe("# 计划 v1.1");
    expect(rows[0].planReview?.status).toBe("approved");
  });

  it("a listPlanReviews failure never blocks the session load", async () => {
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({
      messages: [{ seq: 1, role: "user", text: "旧需求", ts: null }],
      nextBefore: null,
      subagentHistory: [],
    });
    vi.mocked(ipc.listPlanReviews).mockRejectedValue(new Error("db gone"));
    await act(async () => {
      await useChatStore.getState().selectSession("claude", "s-1", "/tmp/ws");
    });
    const session = useChatStore.getState().bySession[KEY];
    expect(session.messages.some((m) => m.role === "user")).toBe(true);
    expect(session.error).toBeNull();
    expect(session.loading).toBe(false);
    expect(planRows()).toHaveLength(0);
  });
});

describe("conversation-mode mutex", () => {
  let container: HTMLDivElement;
  let root: Root;

  function GateProbe() {
    const active = usePlanReviewGateActive();
    return <span data-testid="gate">{active ? "on" : "off"}</span>;
  }

  function seedGate(record: PlanReview | null, streaming: boolean) {
    useChatStore.setState({
      openTabs: [ACTIVE],
      active: ACTIVE,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming,
          messages: record ? [planMessage(record)] : [],
        },
      },
      streamingByKey: streaming ? { [KEY]: true } : {},
    });
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    void i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ active: null, openTabs: [], bySession: {}, streamingByKey: {} });
  });

  it("the gate is active only while a plan awaits on a live run", () => {
    seedGate(recordOf(), true);
    act(() => root.render(<GateProbe />));
    expect(container.textContent).toBe("on");

    // next_turn wait: the plan turn is over, switching is allowed.
    act(() => seedGate(recordOf({ reviewKind: "next_turn" }), false));
    expect(container.textContent).toBe("off");

    // Live run without a waiting plan: no plan gate (streaming still
    // disables the picker through the existing busy path).
    act(() => seedGate(null, true));
    expect(container.textContent).toBe("off");

    // Settled plan on a live run: nothing to gate.
    act(() => seedGate(recordOf({ status: "approved" }), true));
    expect(container.textContent).toBe("off");
  });

  it("a deferred plan on a live run still offers the interrupt (stop) button", () => {
    // 暂不执行 keeps the native wait parked: the turn stays open, so the
    // composer must keep offering 停止 — losing it would leave a parked run
    // the user cannot end (the send button never interrupts). Two seams:
    // the conversation hands the live streaming flag to the footer, and the
    // toolbar turns that flag into the stop button.
    seedGate(recordOf({ status: "deferred" }), true);
    const composerRef = { current: null };
    act(() =>
      root.render(
        <ChatConversation
          active={ACTIVE}
          engines={[]}
          workspaces={[]}
          startNewChat={vi.fn()}
          composerInputRef={composerRef as never}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="footer"]')?.getAttribute("data-streaming"),
    ).toBe("true");

    act(() => root.unmount());
    container.innerHTML = "";
    root = createRoot(container);
    act(() =>
      root.render(
        <ComposerToolbar
          streaming
          onSend={() => {}}
          onStop={() => {}}
        />,
      ),
    );
    expect(container.querySelector('button[aria-label="停止"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="发送"]')).toBeFalsy();
  });

  it("the mode picker entry is disabled while a plan awaits on a live run", () => {
    const dispose = conversationModeRegistry.register({
      id: "plugin:relay",
      label: () => "Relay",
      component: () => null,
    });
    try {
      seedGate(recordOf(), true);
      const composerRef = { current: null };
      act(() =>
        root.render(
          <ChatConversation
            active={ACTIVE}
            engines={[]}
            workspaces={[]}
            startNewChat={vi.fn()}
            composerInputRef={composerRef as never}
          />,
        ),
      );
      const entry = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Relay",
      ) as HTMLButtonElement;
      expect(entry).toBeTruthy();
      expect(entry.disabled).toBe(true);
    } finally {
      dispose();
      getConversationModeState().exit(
        getConversationModeState().identity(KEY, ACTIVE.workspacePath, false),
      );
    }
  });
});
