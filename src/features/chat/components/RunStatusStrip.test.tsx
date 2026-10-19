import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { useChatStore } from "../store";
import { useGitStore } from "@/features/git/store";
import { RunStatusStrip } from "./RunStatusStrip";
import { deriveTodoList } from "./agent-task-steps";
import { ipc } from "@/lib/ipc";
import type { Message, NativeTaskStopResult, TodosPayload } from "@/lib/ipc";
import type { NativeTask } from "@/lib/events";
import { EMPTY_SESSION } from "../store/stream";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "test-session";
const WS = "/ws";

function msg(seq: number, role: string, text: string, path?: string): Message {
  return { seq, role, text, path: path ?? null, ts: null };
}
function todoMsg(seq: number, todos: TodosPayload): Message {
  return { seq, role: "tool", text: "todo", ts: null, todos };
}

/** Turn with one active subagent spawn and one edit to /ws/src/a.ts. */
const TURN: Message[] = [
  msg(1, "user", "fix the tests"),
  msg(2, "tool", "task · Dispatching 10 parallel fix agents"),
  msg(3, "tool", "edit_file", "/ws/src/a.ts"),
];

function seed(messages: Message[], streaming: boolean) {
  useChatStore.setState({
    bySession: { [KEY]: { messages, streaming } as never },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh");
  useChatStore.setState({ bySession: {} });
  useGitStore.setState({
    statusByWorkspace: {
      [WS]: {
        branch: "main",
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", additions: 10, deletions: 2 }],
        untracked: [],
      },
    },
    // Strip must not hit IPC in tests.
    refresh: async () => {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderStrip() {
  await act(async () => {
    root.render(<RunStatusStrip sessionKey={KEY} engine="pi" workspacePath={WS} />);
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function pill(label: string): Element {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (el) => el.textContent?.includes(label),
  );
  expect(found, `pill ${label}`).toBeTruthy();
  return found!;
}

function deferredStop() {
  let resolveResult!: (result: NativeTaskStopResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<NativeTaskStopResult>((yes, no) => { resolveResult = yes; reject = no; });
  const resolve = (...results: [] | [NativeTaskStopResult]) => resolveResult(results.length
    ? results[0] : { taskId: STOP_TASK.id, status: "stopped" });
  return { promise, resolve, reject };
}

const STOP_TASK: NativeTask = { id: "task:actual/id", kind: "local_bash", description: "find /workspace", status: "running" };

function seedStopTasks(tasks: NativeTask[] = [STOP_TASK], runId = "run:actual/id", key = KEY) {
  useChatStore.setState((s) => ({ bySession: {
    ...s.bySession,
    [key]: { ...EMPTY_SESSION, nativeTasks: tasks, nativeTaskRunId: runId },
  } }));
}

async function renderNativeStrip(key = KEY, engine = "claude") {
  await act(async () => root.render(<RunStatusStrip sessionKey={key} engine={engine} workspacePath={WS} />));
}

async function openTask(index = 0) {
  await click(container.querySelectorAll("[data-agent-step-key]")[index]);
}

function stopButton() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent === "停止此任务" || button.textContent === "正在停止…");
}

describe("native task stop", () => {
  it("sends exact native task/run ids, prevents batched duplicate clicks and awaits native state", async () => {
    const pending = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    const button = stopButton()!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith({ runId: "run:actual/id", taskId: "task:actual/id" });
    expect(stopButton()?.disabled).toBe(true);
    expect(stopButton()?.textContent).toBe("正在停止…");
    expect(container.querySelector("[data-testid='subagent-detail-overlay']")?.textContent).toContain("运行中");
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("running");
    await act(async () => {
      seedStopTasks([{ ...STOP_TASK, status: "stopped" }]);
      pending.resolve();
    });
    expect(stopButton()).toBeUndefined();
    expect(container.textContent).toContain("已停止");
  });

  it("shows rejection visibly and allows a fresh retry for a paused task", async () => {
    const pending = deferredStop();
    const retry = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    seedStopTasks([{ ...STOP_TASK, status: "paused" }]);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => pending.reject(new Error("native control rejected")));
    expect(container.querySelector("[role='alert']")?.textContent).toContain("停止任务失败：native control rejected");
    expect(stopButton()?.disabled).toBe(false);
    await click(stopButton()!);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(stopButton()?.disabled).toBe(true);
    await act(async () => {
      seedStopTasks([{ ...STOP_TASK, status: "stopped" }]);
      retry.resolve();
    });
  });

  it.each(["stopped", "completed", "failed"] as const)("converges to exact confirmed %s without a tasks event", async (status) => {
    const pending = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    const other: NativeTask = { ...STOP_TASK, id: "second", description: "Still running" };
    seedStopTasks([STOP_TASK, other]);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => pending.resolve({ taskId: STOP_TASK.id, status }));
    expect(stopButton()).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    const tasks = useChatStore.getState().bySession[KEY].nativeTasks!;
    expect(tasks[0].status).toBe(status);
    expect(tasks[1]).toBe(other);
    expect(container.querySelector("[data-testid='subagent-detail-overlay']")?.textContent).toContain(
      status === "completed" ? "已完成" : status === "failed" ? "失败" : "已停止");
    await click(container.querySelector("[aria-label='返回任务列表']")!);
    await openTask(1);
    expect(stopButton()?.disabled).toBe(false);
  });

  it("preserves pending across returning to the list, opening another task and closing the panel", async () => {
    const pending = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks([STOP_TASK, { ...STOP_TASK, id: "second", description: "Second task" }]);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await click(container.querySelector("[aria-label='返回任务列表']")!);
    await openTask(1);
    expect(stopButton()?.disabled).toBe(false);
    await act(async () => pending.reject("first task rejected"));
    expect(container.querySelector("[role='alert']")).toBeNull();
    await click(container.querySelector("[aria-label='返回任务列表']")!);
    await openTask();
    expect(container.querySelector("[role='alert']")?.textContent).toContain("first task rejected");
    // Retry then close the panel; reopening the first task keeps the lock.
    const retry = deferredStop();
    stop.mockReturnValueOnce(retry.promise);
    await click(stopButton()!);
    await click(pill("任务"));
    await click(pill("任务"));
    await openTask();
    expect(stopButton()?.disabled).toBe(true);
    await click(stopButton()!);
    expect(stop).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve());
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("stopped");
  });

  it.each([undefined, new Error("")])("keeps an empty rejection visible and retryable (%j)", async (error) => {
    const pending = deferredStop();
    vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => pending.reject(error));
    expect(container.querySelector("[role='alert']")?.textContent).toContain("停止任务失败：未知错误");
    expect(stopButton()?.disabled).toBe(false);
  });

  it.each([
    undefined,
    { taskId: "different", status: "stopped" },
    { taskId: STOP_TASK.id, status: "accepted" },
    { taskId: STOP_TASK.id, status: "unsupported" },
    { taskId: STOP_TASK.id, status: "running" },
  ])("keeps malformed or unconfirmed success retryable (%j)", async (result) => {
    const pending = deferredStop();
    const retry = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => pending.resolve(result as NativeTaskStopResult));
    expect(container.querySelector("[role='alert']")?.textContent).toContain("原生响应未确认此任务的终态");
    expect(stopButton()?.disabled).toBe(false);
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("running");
    await click(stopButton()!);
    expect(stop).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve());
    expect(stopButton()).toBeUndefined();
  });

  it("preserves an earlier catalog terminal when a conflicting confirmed result arrives before React commits", async () => {
    const pending = deferredStop();
    vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => {
      seedStopTasks([{ ...STOP_TASK, status: "completed" }]);
      pending.resolve({ taskId: STOP_TASK.id, status: "stopped" });
      await Promise.resolve();
    });
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("completed");
    expect(stopButton()).toBeUndefined();
    expect(container.textContent).toContain("已完成");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it.each(["completed", "failed", "stopped", "unknown"] as const)("does not expose stop for native %s tasks", async (status) => {
    seedStopTasks([{ ...STOP_TASK, status }]);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    expect(stopButton()).toBeUndefined();
  });

  it.each([
    ["", "task:actual/id"],
    ["   ", "task:actual/id"],
    ["run:actual/id", ""],
    ["run:actual/id", "   "],
  ])("does not guess missing protocol identity (run=%j, task=%j)", async (runId, taskId) => {
    seedStopTasks([{ ...STOP_TASK, id: taskId }], runId);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    expect(stopButton()).toBeUndefined();
  });

  it("keeps history and non-Claude heuristic rows read-only", async () => {
    seed([{ ...msg(1, "tool", "Agent"), args: { description: STOP_TASK.description }, result: { backgroundTaskId: STOP_TASK.id, isAsync: true } }], false);
    await renderNativeStrip();
    await click(pill("子代理"));
    await openTask();
    expect(stopButton()).toBeUndefined();
    await click(pill("子代理"));
    await act(async () => useChatStore.setState({ bySession: { [KEY]: {
      ...EMPTY_SESSION,
      messages: [{ ...msg(1, "tool", "Agent"), args: { description: STOP_TASK.description } }],
      streaming: true,
      nativeTasks: [STOP_TASK],
      nativeTaskRunId: "run:actual/id",
    } } }));
    await renderNativeStrip(KEY, "pi");
    await click(pill("子代理"));
    await openTask();
    expect(stopButton()).toBeUndefined();
  });

  it.each(["resolve", "reject"] as const)("isolates a late %s after switching sessions with identical run/task ids", async (outcome) => {
    const old = deferredStop();
    const current = deferredStop();
    const stop = vi.spyOn(ipc, "stopNativeTask").mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    seedStopTasks();
    seedStopTasks([{ ...STOP_TASK, description: "Other session" }], "run:actual/id", "other");
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await renderNativeStrip("other");
    // The same display key keeps the detail open, but its request is scoped.
    expect(stopButton()?.disabled).toBe(false);
    await click(stopButton()!);
    await act(async () => outcome === "resolve" ? old.resolve() : old.reject("old session error"));
    expect(stopButton()?.disabled).toBe(true);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("running");
    expect(useChatStore.getState().bySession.other.nativeTasks?.[0].status).toBe("running");
    await act(async () => current.resolve());
  });

  it("discards rejection once a native terminal arrives, including before the React update commits", async () => {
    const pending = deferredStop();
    vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => {
      seedStopTasks([{ ...STOP_TASK, status: "completed" }]);
      pending.reject("late native error");
      await Promise.resolve();
    });
    expect(stopButton()).toBeUndefined();
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(container.textContent).toContain("已完成");
    await act(async () => seedStopTasks());
    expect(stopButton()?.disabled).toBe(false);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("discards the old run's %s when a new run reuses the task id", async (outcome) => {
    const old = deferredStop();
    const current = deferredStop();
    vi.spyOn(ipc, "stopNativeTask").mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => seedStopTasks([STOP_TASK], "next-run"));
    await openTask();
    await click(stopButton()!);
    await act(async () => outcome === "resolve" ? old.resolve() : old.reject("old run error"));
    expect(stopButton()?.disabled).toBe(true);
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(useChatStore.getState().bySession[KEY].nativeTasks?.[0].status).toBe("running");
    await act(async () => current.resolve());
  });

  it("discards callbacks after the strip unmounts", async () => {
    const pending = deferredStop();
    vi.spyOn(ipc, "stopNativeTask").mockReturnValue(pending.promise);
    seedStopTasks();
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await click(stopButton()!);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderNativeStrip();
    await click(pill("任务"));
    await openTask();
    await act(async () => pending.reject("unmounted strip error"));
    expect(stopButton()?.disabled).toBe(false);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("RunStatusStrip", () => {
  it("shows paused and ambient tasks while excluding both from the running pill count", async () => {
    const tasks: NativeTask[] = [
      { id: "active", kind: "local_bash", description: "Foreground build", status: "running" },
      { id: "watcher", kind: "local_monitor", description: "Ambient watcher", status: "running", ambient: true },
      { id: "paused", kind: "local_agent", description: "Paused review", status: "paused" },
      { id: "done", kind: "local_bash", description: "Completed lint", status: "completed" },
    ];
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, nativeTasks: tasks, nativeTaskRunId: "ambient-run" } } });
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    expect(pill("任务").textContent).toContain("1 运行中 · 1/4");
    await click(pill("任务"));
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("[data-agent-step-key]")];
    expect(rows()).toHaveLength(4);
    expect(rows()[1].textContent).toContain("Ambient watcher");
    expect(rows()[1].textContent).toContain("运行中");
    expect(rows()[1].querySelector(".animate-ping")).toBeNull();
    expect(rows()[2].textContent).toContain("暂停");
    expect(rows()[2].textContent).not.toContain("已完成");
    await click(rows()[2]);
    expect(container.querySelector("[data-testid='subagent-detail-overlay']")?.textContent).toContain("暂停");
    await act(async () => useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], nativeTasks: [{ ...tasks[0], status: "completed" }, ...tasks.slice(1)] } } })));
    expect(pill("任务").textContent).toContain("2/4");
    expect(pill("任务").textContent).not.toContain("运行中");
    expect(pill("任务").querySelector(".animate-ping")).toBeNull();
  });

  it("shows a restored async Claude launch as unknown when no native catalog survives reopening", async () => {
    seed([
      { ...msg(1, "tool", "Agent"), args: { description: "Historical review" }, result: { backgroundTaskId: "old-review", isAsync: true } },
      msg(2, "assistant", "Started review"),
    ], false);
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    await click(pill("子代理"));
    expect(container.textContent).toContain("Historical review");
    expect(container.textContent).toContain("未知");
    expect(container.textContent).not.toContain("已完成");
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it("shows native command and subagent statuses after the main reply ends, with live detail updates", async () => {
    const nativeTasks: NativeTask[] = [
      { id: "bash", kind: "local_bash", description: "Build frontend", status: "running", summary: "Compiling", progress: "20%" },
      { id: "agent", kind: "local_agent", description: "Review changes", status: "failed", summary: "Review failed" },
      { id: "workflow", kind: "local_workflow", description: "Workflow", status: "stopped" },
      { id: "monitor", kind: "local_monitor", description: "Monitor", status: "unknown" },
    ];
    const seedNative = (tasks: NativeTask[]) => useChatStore.setState({ bySession: {
      [KEY]: { ...EMPTY_SESSION, nativeTasks: tasks, nativeTaskRunId: "native", streaming: false,
        messages: [msg(1, "user", "build"), { ...msg(2, "tool", "Agent"), args: { description: "Duplicate heuristic agent" } }, msg(3, "assistant", "Started background work")] },
    } });
    seedNative(nativeTasks);
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    expect(container.textContent).not.toContain("子代理");
    expect(pill("任务").textContent).toContain("1 运行中 · 0/4");
    await click(pill("任务"));
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>("[data-agent-step-key]")];
    expect(rows()).toHaveLength(4);
    expect(rows()[0].textContent).toContain("后台命令");
    expect(rows()[0].textContent).toContain("运行中");
    expect(rows()[1].textContent).toContain("子代理");
    expect(rows()[1].textContent).toContain("失败");
    expect(rows()[2].textContent).toContain("已停止");
    expect(rows()[3].textContent).toContain("未知");
    expect(container.textContent).not.toContain("Duplicate heuristic agent");
    await click(rows()[0]);
    expect(container.textContent).toContain("Compiling");
    expect(container.textContent).toContain("20%");
    await act(async () => seedNative([{ ...nativeTasks[0], status: "completed", summary: "Build passed", progress: "100%" }, ...nativeTasks.slice(1)]));
    expect(container.textContent).toContain("Build passed");
    expect(container.textContent).toContain("100%");
    expect(container.textContent).toContain("已完成");
    expect(pill("任务").textContent).toContain("1/4");
    expect(pill("任务").textContent).not.toContain("运行中");
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it("keeps native catalogs scoped to their session when switching the strip", async () => {
    useChatStore.setState({ bySession: {
      [KEY]: { ...EMPTY_SESSION, nativeTaskRunId: "first", nativeTasks: [{ id: "same", kind: "local_bash", description: "First build", status: "completed" }] },
      other: { ...EMPTY_SESSION, nativeTaskRunId: "second", nativeTasks: [{ id: "same", kind: "local_agent", description: "Second review", status: "failed" }] },
    } });
    const render = async (key: string) => act(async () => root.render(<RunStatusStrip sessionKey={key} engine="claude" workspacePath={WS} />));
    await render(KEY);
    await click(pill("任务"));
    expect(container.textContent).toContain("First build");
    await render("other");
    expect(container.textContent).toContain("Second review");
    expect(container.textContent).toContain("失败");
    expect(container.textContent).not.toContain("First build");
    await render(KEY);
    expect(container.textContent).toContain("First build");
    expect(container.textContent).not.toContain("Second review");
  });

  it("uses distinct checklist and native task pills, suppresses empty-native heuristic rows and preserves other engines", async () => {
    const messages = [{ ...msg(1, "tool", "Agent"), args: { description: "Legacy agent" } }, todoMsg(2, { replace: true, items: [{ content: "Follow up", status: "pending" }] })];
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, messages, nativeTasks: [{ id: "bash", kind: "local_bash", description: "Native command", status: "running" }] } } });
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    expect(pill("待办清单")).toBeTruthy();
    expect(pill("任务")).toBeTruthy();
    await click(pill("任务"));
    expect(container.textContent).toContain("Native command");
    await act(async () => useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], nativeTasks: [] } } })));
    expect(container.querySelector("[data-testid='run-status-subagents']")).toBeNull();
    expect(container.textContent).not.toContain("子代理");
    await renderStrip(); // pi still reads its own legacy delegation data
    await click(pill("子代理"));
    expect(container.textContent).toContain("Legacy agent");
    expect(container.textContent).not.toContain("Native command");
  });

  it("gives a running ambient task a neutral hollow ring, never the completed-green dot or the ping", async () => {
    const tasks: NativeTask[] = [
      { id: "watcher", kind: "local_monitor", description: "Ambient watcher", status: "running", ambient: true },
      { id: "done", kind: "local_bash", description: "Completed lint", status: "completed" },
      { id: "live", kind: "local_bash", description: "Foreground build", status: "running" },
    ];
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, nativeTasks: tasks, nativeTaskRunId: "ring" } } });
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    await click(pill("任务"));
    const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-agent-step-key]")];
    const green = "[class*='bg-[var(--color-status-unseen)]']";
    const ring = "[data-testid='task-glyph-ambient']";
    // Ambient running: ring only.
    expect(rows[0].querySelector(ring)).not.toBeNull();
    expect(rows[0].querySelector(green)).toBeNull();
    expect(rows[0].querySelector(".animate-ping")).toBeNull();
    expect(rows[0].querySelector(ring)?.getAttribute("aria-hidden")).toBe("true");
    // Completed keeps the green dot; foreground running keeps the pinging dot.
    expect(rows[1].querySelector(green)).not.toBeNull();
    expect(rows[1].querySelector(ring)).toBeNull();
    expect(rows[2].querySelector(".animate-ping")).not.toBeNull();
    expect(rows[2].querySelector(ring)).toBeNull();
    // Once the ambient task completes it reads as completed, not as a ring.
    await act(async () => useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], nativeTasks: [{ ...tasks[0], status: "completed" }, ...tasks.slice(1)] } } })));
    const after = container.querySelector<HTMLButtonElement>("[data-agent-step-key]")!;
    expect(after.querySelector(ring)).toBeNull();
    expect(after.querySelector(green)).not.toBeNull();
  });

  it("localizes every known native task kind and falls back to one generic label, never a raw identifier", async () => {
    const kinds: Array<[string, string]> = [
      ["local_bash", "后台命令"],
      ["local_agent", "子代理"],
      ["local_workflow", "工作流"],
      ["remote_agent", "云端会话"],
      ["in_process_teammate", "队友"],
      ["monitor_mcp", "监控"],
      ["local_monitor", "监控"],
      ["mcp_task", "MCP 任务"],
      ["task", "原生任务"],
      ["unknown", "原生任务"],
      ["future_kind-name", "原生任务"],
      ["", "原生任务"],
    ];
    const tasks: NativeTask[] = kinds.map(([kind], i) => ({ id: `k${i}`, kind, description: `Row ${i}`, status: "completed" }));
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, nativeTasks: tasks, nativeTaskRunId: "kinds" } } });
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    await click(pill("任务"));
    const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-agent-step-key]")];
    expect(rows).toHaveLength(kinds.length);
    // Row layout: glyph cell, [type chip + name], status; the chip leads the name.
    const chipOf = (row: Element) => row.children[1].firstElementChild as HTMLElement;
    kinds.forEach(([, label], i) => expect(chipOf(rows[i]).textContent, `row ${i}`).toBe(label));
    for (const raw of ["local_workflow", "local workflow", "remote agent", "in process teammate", "monitor mcp", "future kind name", "future_kind"]) {
      expect(container.textContent).not.toContain(raw);
    }
    // The chip is width-bounded so a long label cannot squeeze the task name.
    const chip = chipOf(rows[0]);
    expect(chip.className).toMatch(/\bmax-w-/);
    expect(chip.className).toMatch(/\btruncate\b/);
  });

  it("uses native wording in the task and checklist detail views and keeps the legacy wording elsewhere", async () => {
    const messages = [todoMsg(1, { replace: true, items: [{ content: "Follow up", status: "pending" }] })];
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, messages, nativeTasks: [{ id: "bash", kind: "local_bash", description: "Native command", status: "running" }], nativeTaskRunId: "wording" } } });
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    // Task detail: back reads "tasks", not "subagents", and never the checklist label.
    await click(pill("任务"));
    await click(container.querySelector("[data-agent-step-key]")!);
    expect(container.querySelector("[aria-label='返回子代理列表']")).toBeNull();
    const taskBack = container.querySelector<HTMLButtonElement>("[aria-label='返回任务列表']");
    expect(taskBack).not.toBeNull();
    expect(taskBack?.title).toBe("返回任务列表");
    await click(taskBack!);
    // Checklist detail: field label and back button follow the 待办清单 pill.
    await click(pill("待办清单"));
    await click(container.querySelector("[data-todo-item-key]")!);
    const overlay = container.querySelector("[data-testid='todo-detail-overlay']")!;
    expect(overlay.textContent).toContain("待办清单: Follow up");
    expect(overlay.textContent).not.toContain("任务:");
    expect(container.querySelector("[aria-label='返回任务列表']")).toBeNull();
    expect(container.querySelector("[aria-label='返回待办清单']")).not.toBeNull();
    // Legacy engines are unchanged.
    await click(container.querySelector("[aria-label='返回待办清单']")!);
    await click(pill("待办清单")); // close the panel so the pi render starts collapsed
    await renderStrip();
    await click(pill("任务"));
    await click(container.querySelector("[data-todo-item-key]")!);
    expect(container.querySelector("[data-testid='todo-detail-overlay']")?.textContent).toContain("任务: Follow up");
    expect(container.querySelector("[aria-label='返回任务列表']")).not.toBeNull();
  });

  it.each([
    ["an array of text blocks", [{ type: "text", text: "Async agent launched successfully. (internal)\nagentId: a1b2c3 ... You will be notified automatically when it completes." }]],
    ["a plain string", "Async agent launched successfully. (internal)\nagentId: a1b2c3"],
  ])("shows a reopened real-history async Agent launch (%s) as unknown, not completed", async (_shape, result) => {
    seed([
      msg(1, "user", "review in background"),
      { ...msg(2, "tool", "Agent"), args: { description: "Historical review" }, result },
      msg(3, "assistant", "Started review"),
    ], false);
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    await click(pill("子代理"));
    expect(container.textContent).toContain("Historical review");
    expect(container.textContent).toContain("未知");
    expect(container.textContent).not.toContain("已完成");
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  // Turn 2 in the same tab (or a reopened one) has no current-run native
  // catalog, so the strip falls back to history. An old async launch of unknown
  // status is settled history: it must not read as running work.
  it("does not pulse the legacy Tasks pill for an old async launch of unknown status while a later turn streams", async () => {
    seed([
      msg(1, "user", "review in background"),
      { ...msg(2, "tool", "Agent"), args: { description: "Historical review" }, result: [{ type: "text", text: "Async agent launched successfully. (internal)\nagentId: a1b2c3" }] },
      msg(3, "assistant", "Started review"),
      msg(4, "user", "now something unrelated"),
    ], true);
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    // done/total keeps its meaning: the unknown launch is not counted as done.
    expect(pill("子代理").textContent).toContain("0/1");
    expect(pill("子代理").querySelector(".animate-ping")).toBeNull();
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it("still pulses the legacy Tasks pill for a genuinely running subagent next to an old unknown launch", async () => {
    seed([
      msg(1, "user", "review in background"),
      { ...msg(2, "tool", "Agent"), args: { description: "Historical review" }, result: { backgroundTaskId: "old-review", isAsync: true } },
      msg(3, "assistant", "Started review"),
      msg(4, "user", "review the diff"),
      { ...msg(5, "tool", "Agent"), args: { description: "Live review" } },
    ], true);
    await act(async () => root.render(<RunStatusStrip sessionKey={KEY} engine="claude" workspacePath={WS} />));
    expect(pill("子代理").textContent).toContain("0/2");
    expect(pill("子代理").querySelector(".animate-ping")).not.toBeNull();
    // The same live row once the turn settles: no more pulse.
    await act(async () => seed([
      msg(1, "user", "review the diff"),
      { ...msg(2, "tool", "Agent"), args: { description: "Live review" } },
      msg(3, "assistant", "Done"),
    ], false));
    expect(pill("子代理").querySelector(".animate-ping")).toBeNull();
  });

  it("does not reread a completed edit payload when assistant text grows", async () => {
    const readContent = vi.fn(() => "one\ntwo");
    const tool: Message = {
      ...msg(1, "tool", "edit_file", "/ws/src/a.ts"),
      args: { get content() { return readContent(); } },
    };
    seed([tool], true);
    await renderStrip();
    const reads = readContent.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await act(async () => seed([tool, msg(2, "assistant", "more text")], true));
    expect(readContent).toHaveBeenCalledTimes(reads);
    await act(async () => seed([tool, msg(2, "assistant", "more text still arriving")], true));
    expect(readContent).toHaveBeenCalledTimes(reads);
  });

  it("restores older subagents with their session after switching and reopening", async () => {
    const brief = "# Target\nReview relay recovery.\n# Acceptance\nReconnect without toggling.";
    const history: Message[] = [
      msg(1, "user", "Review the relay"),
      {
        ...msg(2, "tool", "task · Reviewing relay"),
        args: { tasks: [{ name: "SavedReviewer", agent: "reviewer", task: brief }] },
      },
      {
        ...msg(3, "tool", "hub · Waiting for review"),
        args: { op: "wait" },
        result: { details: { jobs: [{ id: "SavedReviewer", status: "completed" }] } },
      },
    ];
    const savedPage = {
      messages: [msg(201, "user", "Continue later"), msg(202, "assistant", "Ready")],
      nextBefore: 201,
      subagentHistory: history,
    };
    vi.spyOn(ipc, "loadSessionPage").mockImplementation(async (_engine, id, _limit, before) =>
      structuredClone(id === "saved" ? before ? {
        messages: history,
        nextBefore: null,
        subagentHistory: [],
      } : savedPage : {
        messages: [msg(1, "user", "Unrelated session")],
        nextBefore: null,
        subagentHistory: [],
      }),
    );
    const open = async (id: string) => {
      await act(async () => {
        await useChatStore.getState().selectSession("omp", id, WS);
        root.render(<RunStatusStrip key={id} sessionKey={`omp/${id}`} engine="omp" workspacePath={WS} />);
      });
    };

    await open("saved");
    await click(pill("子代理"));
    const row = container.querySelector<HTMLButtonElement>("[data-agent-step-key]")!;
    expect(row.textContent).toContain("SavedReviewer");
    expect(row.textContent).toContain("reviewer");
    expect(row.textContent).toContain("已完成");
    await click(row);
    expect(container.querySelector("[data-testid='subagent-detail-overlay'] pre")?.textContent).toBe(brief);

    await open("other");
    expect(container.querySelector("[data-testid='run-status-strip']")).toBeNull();
    await open("saved");
    expect(pill("子代理").textContent).toContain("1/1");

    // Drop all frontend session state: reopening must reconstruct from history.
    await act(async () => {
      root.unmount();
      useChatStore.setState({ bySession: {}, active: null });
    });
    root = createRoot(container);
    await open("saved");
    await click(pill("子代理"));
    const restored = container.querySelector<HTMLButtonElement>("[data-agent-step-key]")!;
    expect(restored.textContent).toContain("SavedReviewer");
    expect(restored.textContent).toContain("已完成");
    await click(restored);
    expect(container.querySelector("[data-testid='subagent-detail-overlay'] pre")?.textContent).toBe(brief);

    await act(async () => {
      await useChatStore.getState().loadEarlier();
    });
    await click(container.querySelector("[aria-label='返回子代理列表']")!);
    expect(pill("子代理").textContent).toContain("1/1");
    expect(container.querySelectorAll("[data-agent-step-key]")).toHaveLength(1);
    await act(async () => {
      useChatStore.setState((state) => {
        const session = state.bySession["omp/saved"];
        return {
          bySession: {
            ...state.bySession,
            "omp/saved": {
              ...session,
              streaming: true,
              messages: [...session.messages, {
                ...msg(203, "tool", "hub · Resuming saved reviewer"),
                args: { op: "wait" },
                result: { details: { jobs: [{ id: "SavedReviewer", status: "running" }] } },
              }],
            },
          },
        };
      });
    });
    expect(container.querySelector("[data-agent-step-key]")?.textContent).toContain("运行中");
    expect(pill("子代理").textContent).toContain("0/1");
  });

  it("moves focus into the subagent detail and back to its row", async () => {
    seed(TURN, true);
    await renderStrip();
    await click(pill("子代理"));

    const row = container.querySelector<HTMLButtonElement>("[data-agent-step-key]")!;
    await click(row);
    const back = container.querySelector<HTMLButtonElement>("[aria-label='返回子代理列表']");
    expect(document.activeElement).toBe(back);

    await click(back!);
    const restored = container.querySelector<HTMLButtonElement>(
      `[data-agent-step-key="${row.dataset.agentStepKey}"]`,
    );
    expect(document.activeElement).toBe(restored);
  });

  it("renders subagent count and edited git stats as pills", async () => {
    seed(TURN, true);
    await renderStrip();
    expect(pill("子代理").textContent).toContain("0/1");
    // The +/− numbers render as odometer digit columns, so the pill's text
    // content is the 0-9 strip: read the semantic value instead.
    const edited = pill("已编辑");
    const additions = edited.querySelector("[data-testid='run-status-edit-additions']");
    const deletions = edited.querySelector("[data-testid='run-status-edit-deletions']");
    expect(additions?.getAttribute("aria-label")).toBe("+10");
    expect(additions?.getAttribute("data-value")).toBe("10");
    expect(deletions?.getAttribute("aria-label")).toBe("−2");
    expect(deletions?.getAttribute("data-value")).toBe("2");
  });

  it("opens panels single-open above the strip and closes on Esc", async () => {
    seed(TURN, true);
    await renderStrip();

    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).toContain(
      "运行中",
    );

    // Single-open: switching pills swaps the panel.
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-subagents']")).toBeNull();
    expect(container.querySelector("[data-testid='run-status-files']")?.textContent).toContain(
      "a.ts",
    );

    // Same pill toggles closed…
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-files']")).toBeNull();

    // …and Esc collapses an open panel.
    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[data-testid='run-status-subagents']")).toBeNull();
  });

  it("chrome toggle hides the pill row and persists across remounts", async () => {
    seed(TURN, true);
    await renderStrip();
    await click(container.querySelector("[aria-label='收起运行状态']")!);
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(localStorage.getItem("ccgui.chat.runStatusChromeOpen")).toBe("0");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderStrip();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector("[aria-label='展开运行状态']")).not.toBeNull();
  });

  it("freezes counts and shows 已完成 once the turn settles", async () => {
    seed(TURN, true);
    await renderStrip();
    await act(async () => {
      seed(TURN, false);
    });
    expect(pill("子代理").textContent).toContain("1/1");
    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).toContain(
      "已完成",
    );
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).not.toContain(
      "运行中",
    );
  });

  it("renders nothing when the turn has no subagents or edits", async () => {
    seed([msg(1, "user", "hi"), msg(2, "assistant", "hello")], false);
    await renderStrip();
    expect(container.querySelector("[data-testid='run-status-strip']")).toBeNull();
  });
  it("ignores write-tool rows targeting device endpoints, not files", async () => {
    seed(
      [msg(1, "user", "hi"), msg(2, "tool", "write", "xd://browser"), msg(3, "tool", "edit_file", "/ws/src/a.ts")],
      false,
    );
    await renderStrip();
    await click(pill("已编辑"));
    const files = container.querySelector("[data-testid='run-status-files']");
    expect(files?.textContent).toContain("a.ts");
    expect(files?.textContent).not.toContain("browser");
  });
  it("keeps files edited in earlier turns (session-scoped, no expiry)", async () => {
    seed(
      [
        msg(1, "user", "first turn"),
        msg(2, "tool", "edit_file", "/ws/src/old.ts"),
        msg(3, "assistant", "done"),
        msg(4, "user", "second turn"),
        msg(5, "assistant", "no edits this turn"),
      ],
      false,
    );
    await renderStrip();
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-files']")?.textContent).toContain(
      "old.ts",
    );
  });
  it("folds todo snapshots and patches into the 任务 pill", async () => {
    seed(
      [
        msg(1, "user", "do work"),
        todoMsg(2, {
          replace: true,
          items: [
            { content: "定位根因", status: "pending" },
            { content: "修复", status: "pending" },
            { content: "回归验证", status: "pending" },
          ],
        }),
        todoMsg(3, { replace: false, items: [{ content: "定位根因", status: "complete" }] }),
        todoMsg(4, { replace: false, items: [{ content: "修复", status: "active" }] }),
      ],
      true,
    );
    await renderStrip();
    expect(pill("任务").textContent).toContain("1/3");
    await click(pill("任务"));
    const panel = container.querySelector("[data-testid='run-status-todos']")?.textContent;
    expect(panel).toContain("定位根因");
    expect(panel).toContain("已完成");
    expect(panel).toContain("运行中");
    expect(panel).toContain("待处理");
  });

  it("a later replace snapshot resets the list; dropped patches remove items", async () => {
    const folded = deriveTodoList([
      todoMsg(1, {
        replace: true,
        items: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      }),
      todoMsg(2, { replace: false, items: [{ content: "a", status: "dropped" }] }),
      todoMsg(3, { replace: true, items: [{ content: "c", status: "complete" }] }),
    ]);
    expect(folded).toEqual([{ content: "c", status: "complete" }]);
  });

  it("extracts subagent type and description with breathing light indicator", async () => {
    const subagentTurn: Message[] = [
      msg(1, "user", "run architecture analysis"),
      {
        seq: 2,
        role: "tool",
        text: "Agent",
        ts: null,
        args: {
          subagent_type: "architect",
          description: "分析系统设计与模块划分",
        },
      },
    ];

    seed(subagentTurn, true);
    await renderStrip();

    expect(pill("子代理").textContent).toContain("0/1");
    // In running state, breathing light animation is rendered
    expect(container.querySelector(".animate-ping")).not.toBeNull();

    await click(pill("子代理"));
    const panel = container.querySelector("[data-testid='run-status-subagents']")?.textContent;
    expect(panel).toContain("architect");
    expect(panel).toContain("分析系统设计与模块划分");
    expect(panel).toContain("运行中");
  });

  it("opens a subagent's full assignment inside the existing panel", async () => {
    const assignment = "# Target\nOwn relay.rs only.\n# Acceptance\nOutages recover without toggling.";
    seed([
      msg(1, "user", "delegate"),
      {
        seq: 2,
        role: "tool",
        text: "task · Dispatching relay worker",
        ts: null,
        args: { tasks: [{ agent: "task", name: "RelayRecovery", task: assignment }] },
      },
    ], true);
    await renderStrip();
    await click(pill("子代理"));
    await click(container.querySelector("[data-agent-step-key]")!);

    const panel = container.querySelector("[data-testid='run-status-subagents']");
    expect(panel?.textContent).toContain("RelayRecovery");
    expect(panel?.textContent).toContain("Own relay.rs only.");
    expect(panel?.textContent).toContain("Outages recover without toggling.");
    expect(panel?.querySelector("[data-testid='subagent-detail-overlay']")).not.toBeNull();
  });

  it("keeps subagents from earlier turns visible in completed state", async () => {
    const multiTurn: Message[] = [
      msg(1, "user", "turn 1: run subagent"),
      {
        seq: 2,
        role: "tool",
        text: "Agent",
        ts: null,
        args: {
          subagent_type: "code-reviewer",
          description: "检查代码安全漏洞",
        },
      },
      msg(3, "assistant", "turn 1 finished"),
      msg(4, "user", "turn 2: ordinary message"),
      msg(5, "assistant", "no subagents here"),
    ];

    seed(multiTurn, false);
    await renderStrip();

    // The subagent pill survives cross-turn in completed state
    expect(pill("子代理").textContent).toContain("1/1");
    expect(container.querySelector(".animate-ping")).toBeNull();

    await click(pill("子代理"));
    const panel = container.querySelector("[data-testid='run-status-subagents']")?.textContent;
    expect(panel).toContain("code-reviewer");
    expect(panel).toContain("检查代码安全漏洞");
    expect(panel).toContain("已完成");
  });

  it("correctly maps TaskCreate and subsequent TaskUpdate by taskId to complete status", async () => {
    const taskTurn: Message[] = [
      msg(1, "user", "create and complete task"),
      {
        seq: 2,
        role: "tool",
        text: "TaskCreate",
        ts: null,
        args: {
          subject: "在输入框上方模块增加子代理任务信息与呼吸灯",
        },
        result: "Task #13 created successfully",
        todos: {
          replace: false,
          items: [
            {
              id: "13",
              content: "在输入框上方模块增加子代理任务信息与呼吸灯",
              status: "pending",
            },
          ],
        },
      },
      {
        seq: 3,
        role: "tool",
        text: "TaskUpdate",
        ts: null,
        args: {
          taskId: "13",
          status: "completed",
        },
        todos: {
          replace: false,
          items: [
            {
              id: "13",
              content: "",
              status: "complete",
            },
          ],
        },
      },
    ];

    seed(taskTurn, false);
    await renderStrip();

    expect(pill("任务").textContent).toContain("1/1");
    await click(pill("任务"));
    const panel = container.querySelector("[data-testid='run-status-todos']")?.textContent;
    expect(panel).toContain("在输入框上方模块增加子代理任务信息与呼吸灯");
    expect(panel).toContain("已完成");
    expect(panel).not.toContain("待处理");
  });

  it("turns off breathing dots on both 任务 and 子代理 pills when streaming is false", async () => {
    const messages: Message[] = [
      msg(1, "user", "run tasks"),
      {
        seq: 2,
        role: "tool",
        text: "task · Dispatching 4 agents",
        ts: null,
        args: {
          tasks: [
            { name: "A", task: "Task A" },
            { name: "B", task: "Task B" },
            { name: "C", task: "Task C" },
            { name: "D", task: "Task D" },
          ],
        },
      },
      {
        seq: 3,
        role: "tool",
        text: "hub · Waiting for agents",
        ts: null,
        args: { op: "wait" },
        result: {
          details: {
            jobs: [
              { id: "A", status: "completed" },
              { id: "B", status: "completed" },
              { id: "C", status: "completed" },
              { id: "D", status: "running" },
            ],
          },
        },
      },
      todoMsg(4, {
        replace: true,
        items: [{ content: "单一任务", status: "active" }],
      }),
      msg(5, "assistant", "Turn finished."),
    ];

    // While streaming: both pills show breathing light
    seed(messages, true);
    await renderStrip();
    expect(pill("任务").textContent).toContain("0/1");
    expect(pill("子代理").textContent).toContain("3/4");
    expect(container.querySelectorAll(".animate-ping").length).toBeGreaterThanOrEqual(2);

    // When turn ends (streaming: false): breathing lights MUST turn off
    await act(async () => seed(messages, false));
    expect(pill("任务").textContent).toContain("0/1");
    expect(pill("子代理").textContent).toContain("4/4");
    expect(container.querySelector(".animate-ping")).toBeNull();

    // Inside panel: when not live, active item displays 待处理 instead of 运行中
    await click(pill("任务"));
    const todoPanel = container.querySelector("[data-testid='run-status-todos']")?.textContent;
    expect(todoPanel).toContain("待处理");
    expect(todoPanel).not.toContain("运行中");
  });

  it("reads completed todo snapshot from message.result without pre-set message.todos", async () => {
    const messages: Message[] = [
      msg(1, "user", "complete todo"),
      {
        seq: 2,
        role: "tool",
        text: "todo",
        ts: null,
        args: { op: "init" },
        result: {
          details: {
            phases: [
              {
                name: "phase1",
                tasks: [{ content: "修复状态问题", status: "completed" }],
              },
            ],
          },
        },
      },
      msg(3, "assistant", "done"),
    ];

    seed(messages, false);
    await renderStrip();
    expect(pill("任务").textContent).toContain("1/1");
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it("drills down into task detail and execution status on click, and returns on back", async () => {
    const messages: Message[] = [
      msg(1, "user", "create task"),
      {
        seq: 2,
        role: "tool",
        text: "todo",
        ts: null,
        args: { op: "init" },
        result: {
          details: {
            phases: [
              {
                name: "Diagnose",
                tasks: [
                  {
                    content: "定位页面查询零条数原因",
                    status: "completed",
                    detail: "排查数据库连接池与实体映射",
                  },
                ],
              },
            ],
          },
        },
      },
      msg(3, "assistant", "done"),
    ];

    seed(messages, false);
    await renderStrip();
    await click(pill("任务"));

    // Find the task row button and click it to drill down
    const row = container.querySelector<HTMLButtonElement>("[data-todo-item-key]")!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("定位页面查询零条数原因");
    await click(row);

    // Overlay is open
    const overlay = container.querySelector("[data-testid='todo-detail-overlay']");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("定位页面查询零条数原因");
    expect(overlay?.textContent).toContain("Diagnose");
    expect(overlay?.textContent).toContain("已完成");
    expect(overlay?.textContent).toContain("排查数据库连接池与实体映射");

    // Focus moved to back button
    const back = container.querySelector<HTMLButtonElement>("[aria-label='返回任务列表']");
    expect(document.activeElement).toBe(back);

    // Click back to return to the task list
    await click(back!);
    expect(container.querySelector("[data-testid='todo-detail-overlay']")).toBeNull();
    expect(container.querySelectorAll("[data-todo-item-key]")).toHaveLength(1);
    expect(document.activeElement?.getAttribute("data-todo-item-key")).toBe("定位页面查询零条数原因");
  });
});
