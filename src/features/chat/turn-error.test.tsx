import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type Message } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { ERROR_BANNER_AUTO_DISMISS_MS, ErrorBanner } from "./components/ErrorBanner";
import { MessageTimeline } from "./components/MessageTimeline";
import { localizeRunError } from "./run-error";
import { SessionScope } from "./split/session-scope";
import { sessionKey, useChatStore } from "./store";
import {
  handleEngineEvents,
  settledRunOutcomes,
  settledRuns,
  type EngineEventDeps,
} from "./store/engine-events";
import { EMPTY_SESSION, hasInlineTurnError, runRouting } from "./store/stream";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
      })),
    getTotalSize: () => options.count * 72,
    measureElement: () => {},
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("@/features/shortcuts/runtime", () => ({
  registerShortcutHandler: () => () => {},
}));

vi.mock("./components/Markdown", () => ({
  default: ({ text }: { text: string }) => <div data-markdown="">{text}</div>,
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async (req: { runId: string; sessionId: string | null }) => ({
      runId: req.runId,
      sessionId: req.sessionId,
    })),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({
      messages: [],
      nextBefore: null,
      subagentHistory: [],
    })),
    listPlanReviews: vi.fn(async () => []),
    rescanSessions: vi.fn(async () => {}),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    refreshSessionUsage: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("IntersectionObserver", ResizeObserverStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = {
  engine: "agy",
  sessionId: "sess-1",
  workspacePath: "C:/Projects/sample-app",
} as const;
const KEY = sessionKey(TAB.engine, TAB.sessionId, TAB.workspacePath);

function eventDeps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
    refreshSessionUsage: vi.fn(async () => {}),
  };
}

function resetStore(messages: Message[] = []) {
  runRouting.clear();
  settledRuns.clear();
  settledRunOutcomes.clear();
  vi.clearAllMocks();
  useChatStore.setState({
    initialized: true,
    archivedSessionKeys: {},
    engines: [
      {
        id: "agy",
        name: "AGY",
        available: true,
        enabled: true,
        supportsImages: true,
        supportsComputerUse: false,
      } as never,
    ],
    models: { agy: "" },
    efforts: {},
    providers: {},
    active: { ...TAB },
    openTabs: [{ ...TAB }],
    sessions: [],
    bySession: {
      [KEY]: {
        ...EMPTY_SESSION,
        messages,
      },
    },
    streamingByKey: {},
    retryingByKey: {},
  });
}

function ConnectedConversationTestView() {
  const session = useChatStore((s) => s.bySession[KEY]);
  const dismissSessionError = useChatStore((s) => s.dismissSessionError);
  const { t } = { t: i18n.t.bind(i18n) };
  if (!session) return null;
  const topError =
    session.error &&
    !(hasInlineTurnError(session) && session.error === session.failedTurn?.error)
      ? session.error
      : null;
  return (
    <SessionScope session={{ ...TAB }}>
      {topError && (
        <div data-top-banner="">
          <ErrorBanner
            message={localizeRunError(topError, t)}
            onDismiss={() => dismissSessionError(KEY)}
          />
        </div>
      )}
      <MessageTimeline
        engine={TAB.engine}
        sessionIdentity={KEY}
        session={session}
        streaming={session.streaming}
        onLoadEarlier={() => {}}
        workspacePath={TAB.workspacePath}
      />
    </SessionScope>
  );
}

describe("inline failed-turn error notice and atomic retry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetStore();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderTimeline() {
    act(() => {
      root.render(<ConnectedConversationTestView />);
    });
  }

  function clickButton(label: string) {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button, `button "${label}"`).toBeTruthy();
    return button!;
  }

  it("persists inline error beneath failed user message across 5s and retries without duplicating bubble", async () => {
    renderTimeline();

    // Send a prompt cleanly first, then simulate native session/resume timeout error.
    await act(async () => {
      await useChatStore.getState().send("不是，我是说这个标题不对呀，没显示标题", []);
    });
    const sentRunId = vi.mocked(ipc.sendMessage).mock.calls[0]?.[0]?.runId;
    expect(sentRunId).toBeTruthy();

    act(() => {
      handleEngineEvents(
        [
          {
            runId: sentRunId!,
            sessionId: TAB.sessionId,
            engine: TAB.engine,
            seq: 1,
            kind: "error",
            data: "AGY ACP `session/resume` timed out",
          } as never,
        ],
        eventDeps(),
      );
    });

    const sessionAfterError = useChatStore.getState().bySession[KEY];
    expect(sessionAfterError.failedTurn).toEqual({
      userSeq: 1,
      error: "AGY ACP `session/resume` timed out",
    });
    expect(sessionAfterError.messages.filter((m) => m.role === "user")).toHaveLength(1);

    // Inline alert renders under the user bubble; top banner is suppressed to avoid duplicate UI.
    expect(container.querySelector("[data-top-banner]")).toBeNull();
    const alert = container.querySelector("[data-turn-error]");
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("AGY ACP `session/resume` timed out");

    // Advance well past 5s ErrorBanner auto-dismiss: inline error must remain intact.
    await act(async () => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS + 2_000);
    });
    expect(useChatStore.getState().bySession[KEY].failedTurn?.error).toBe(
      "AGY ACP `session/resume` timed out",
    );
    expect(container.querySelector("[data-turn-error]")?.textContent).toContain(
      "AGY ACP `session/resume` timed out",
    );

    // Click Retry: re-sends original message and replaces trailing failed user bubble (still 1 user bubble!).
    await act(async () => {
      clickButton(i18n.t("chat.turnFailedRetry")).click();
      await Promise.resolve();
    });

    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.sendMessage).mock.calls[1]?.[0]?.prompt).toBe(
      "不是，我是说这个标题不对呀，没显示标题",
    );
    const sessionOnRetry = useChatStore.getState().bySession[KEY];
    expect(sessionOnRetry.failedTurn).toBeNull();
    expect(sessionOnRetry.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(sessionOnRetry.messages[0].text).toBe("不是，我是说这个标题不对呀，没显示标题");
    expect(container.querySelector("[data-turn-error]")).toBeNull();
  });

  it("handles direct ipc.sendMessage rejection and manual close via dismissTurnError", async () => {
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("spawn ENOENT"));
    renderTimeline();

    await act(async () => {
      await useChatStore.getState().send("检查状态", []);
    });

    const alert = container.querySelector("[data-turn-error]");
    expect(alert?.textContent).toContain("spawn ENOENT");
    expect(useChatStore.getState().bySession[KEY].failedTurn?.userSeq).toBe(1);

    // Clicking Close dismisses the inline turn error and clears matching session.error.
    act(() => {
      clickButton(i18n.t("common.close")).click();
    });
    expect(useChatStore.getState().bySession[KEY].failedTurn).toBeNull();
    expect(useChatStore.getState().bySession[KEY].error).toBeNull();
    expect(container.querySelector("[data-turn-error]")).toBeNull();
  });

  it("preserves failedTurn when a transient ErrorBanner auto-dismisses at the top", async () => {
    resetStore([
      { seq: 1, role: "user", text: "请求失败的那一条", ts: null },
    ]);
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          error: "AGY ACP `session/resume` timed out",
          failedTurn: { userSeq: 1, error: "AGY ACP `session/resume` timed out" },
        },
      },
    }));
    renderTimeline();

    // Surface a transient composer error in session.error without wiping failedTurn.
    act(() => {
      useChatStore.getState().setSessionError(KEY, i18n.t("chat.imagesUnsupported"));
    });
    expect(container.querySelector("[data-top-banner]")?.textContent).toContain(
      i18n.t("chat.imagesUnsupported"),
    );
    expect(container.querySelector("[data-turn-error]")).toBeTruthy();

    // After 5s, the transient top ErrorBanner auto-dismisses and restores failedTurn.error.
    await act(async () => {
      vi.advanceTimersByTime(ERROR_BANNER_AUTO_DISMISS_MS);
    });
    expect(container.querySelector("[data-top-banner]")).toBeNull();
    expect(useChatStore.getState().bySession[KEY].failedTurn?.error).toBe(
      "AGY ACP `session/resume` timed out",
    );
    expect(useChatStore.getState().bySession[KEY].error).toBe(
      "AGY ACP `session/resume` timed out",
    );
    expect(container.querySelector("[data-turn-error]")).toBeTruthy();
  });

  it("appends rather than replaces when the failed turn already produced partial output, and hides Retry for codex-desktop unconfirmed errors", async () => {
    resetStore([
      { seq: 1, role: "user", text: "生成图表", ts: null },
      { seq: 2, role: "assistant", text: "已经开始分析…", ts: null },
    ]);
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          error: "stream dropped midway",
          failedTurn: { userSeq: 1, error: "stream dropped midway" },
        },
      },
    }));
    renderTimeline();

    // Error attaches after the partial assistant row and keeps history when retried.
    const alert = container.querySelector("[data-turn-error]");
    expect(alert?.textContent).toContain("stream dropped midway");

    await act(async () => {
      clickButton(i18n.t("chat.turnFailedRetry")).click();
      await Promise.resolve();
    });
    const afterRetry = useChatStore.getState().bySession[KEY].messages;
    expect(afterRetry.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    // Codex Desktop unconfirmed terminal state omits Retry button while keeping Close.
    act(() => {
      resetStore([{ seq: 1, role: "user", text: "交给 Desktop", ts: null }]);
      useChatStore.setState((s) => ({
        bySession: {
          ...s.bySession,
          [KEY]: {
            ...s.bySession[KEY],
            error: "[codex-desktop:timeout] follow timed out",
            failedTurn: { userSeq: 1, error: "[codex-desktop:timeout] follow timed out" },
          },
        },
      }));
    });
    renderTimeline();

    const desktopAlert = container.querySelector("[data-turn-error]");
    expect(desktopAlert?.textContent).toContain(i18n.t("chat.codexDesktop.timeout"));
    const retryBtn = [...desktopAlert!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === i18n.t("chat.turnFailedRetry"),
    );
    expect(retryBtn).toBeUndefined();
    const closeBtn = [...desktopAlert!.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === i18n.t("common.close"),
    );
    expect(closeBtn).toBeTruthy();
  });
});
