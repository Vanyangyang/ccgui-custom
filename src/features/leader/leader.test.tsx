import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiChatSidebar, type AiChatThread } from "@/components/application/ai-chat/ai-chat-sidebar";
import { ThreadContextMenu } from "@/components/application/ai-chat/thread-context-menu";
import { paginateThreads } from "@/components/application/ai-chat/repo-pagination";
import { useChatStore } from "@/features/chat/store";
import { handleEngineEvents, settledRuns, upsertSessionMetaInto, type EngineEventDeps } from "@/features/chat/store/engine-events";
import { EMPTY_SESSION, runRouting } from "@/features/chat/store/stream";
import { createSessionActions } from "@/features/chat/store/sessions";
import type { ChatStore } from "@/features/chat/store/types";
import type { SessionMeta, SessionPage } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { pluginBus, resetPluginBusForTests, SESSION_ACTIVATED_TOPIC } from "@/features/plugins/runtime/events";
import { leaderHistoryLoaded, leaderEventAllowed, isReclaimedLeaderSession } from "./event-state";
import { invoke, listen } from "@/lib/transport";
import { groupLeaderThreads } from "./tree";
import { useLeaderStore } from "./store";
import { useLeaderTreeUI } from "./tree-ui";
import { startLeaderRuntime } from "./runtime";
import { LeaderManagementHost } from "./LeaderManagementHost";
import type { LeaderArchivedGroup, LeaderBranch, LeaderSnapshot } from "./types";
import { isCrossSessionRecordUnread, useCrossSessionActivityStore } from "@/features/chat/cross-session";
import { CrossSessionQueue } from "@/features/chat/components/CrossSessionQueue";

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; }, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/ipc", () => ({ ipc: { loadSessionPage: vi.fn(), officialConfigRead: vi.fn(async () => [{ path: "/global/.claude/settings.json", exists: true, format: "json", content: '{"autoCompactWindow":750000}' }]), rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}), computerUseSetActive: vi.fn(async () => {}), remoteControlActive: vi.fn(async () => false), listPlanReviews: vi.fn(async () => []) } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { title?: string; count?: number; time?: string; tokens?: string; max?: string; percent?: string }) =>
    key === "leader.deleteGroupConfirm" ? `${key}:${options?.title}:${options?.count}` : options?.time ? `${key}:${options.time}` : key === "leader.contextUsage" ? `${key}:${options?.tokens}/${options?.max}:${options?.percent}` : key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const parent = { engine: "claude", sessionId: "root", workspacePath: "/branches" };
function branch(id: string, engine = "codex", parentSessionId = "root", parentEngine = "claude"): LeaderBranch {
  return { id, engine, sessionId: id, parentEngine, parentSessionId, workspacePath: "/branches", title: `task-${id}`, task: `assignment-${id}`,
    model: null, effort: null, runId: `run-${id}`, state: "running", createdAt: 1, updatedAt: 2, lastActivityAt: 2, deadlineAt: Date.now() + 1800000,
    expired: false, result: "", resultTruncated: false, error: null };
}
function snapshot(): LeaderSnapshot { return { leaders: [parent], branches: [branch("child"), branch("grandchild", "claude", "child", "codex")] }; }
function rows() { return [{ id: "claude/root", label: "root conversation", engine: "claude", time: "" }, { id: "codex/child", label: "child conversation", time: "" }, { id: "claude/grandchild", label: "grandchild conversation", time: "" }]; }
let node: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); localStorage.clear(); runRouting.clear(); settledRuns.clear();
  runtime.web = false;
  vi.mocked(listen).mockReset().mockResolvedValue(() => {});
  resetPluginBusForTests();
  vi.mocked(ipc.loadSessionPage).mockReset().mockResolvedValue({ messages: [], subagentHistory: [], nextBefore: null });
  vi.mocked(ipc.officialConfigRead).mockReset().mockResolvedValue([{ path: "/global/.claude/settings.json", exists: true, format: "json", content: '{"autoCompactWindow":750000}' }]);
  vi.mocked(invoke).mockReset().mockResolvedValue(snapshot());
  useLeaderTreeUI.setState({ expanded: new Set() });
  useCrossSessionActivityStore.getState().reset();
  useLeaderStore.setState({ snapshot: snapshot(), error: null, busy: false, managing: null });
  useChatStore.setState({ sessions: [], bySession: {}, drafts: {}, unseen: {}, openTabs: [], active: null, activeEngine: "codex", streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {} });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Leader sidebar tree", () => {
  it.each(["workspace", "recent"])("shows each child's own cache evidence alongside task status in the %s list", async (mode) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    localStorage.setItem("ccgui-next.sidebarChatListMode:v1", mode);
    const hotCache = { startedAt: now - 60_000, observedAt: now - 50_000, ttlSeconds: 3600, source: "anthropic-usage" as const };
    const coldCache = { startedAt: now - 600_000, observedAt: now - 590_000, ttlSeconds: 300, source: "anthropic-usage" as const };
    const native: LeaderSnapshot = { leaders: [parent], branches: [
      { ...branch("child", "claude"), state: "completed" },
      branch("grandchild", "codex", "child", "claude"),
      { ...branch("unknown", "agy"), state: "failed" },
      { ...branch("cursor", "cursor"), state: "stopped" },
      { ...branch("pending"), sessionId: null, state: "starting" },
    ] };
    const threads: AiChatThread[] = [
      { id: "claude/root", engine: "claude", label: "root conversation", time: "root-age", promptCache: hotCache },
      { id: "claude/child", engine: "claude", label: "child conversation", time: "child-age", promptCache: coldCache },
      { id: "codex/grandchild", engine: "codex", label: "grandchild conversation", time: "grandchild-age", promptCache: { ...hotCache, ttlSeconds: 1800, source: "openai-policy" } },
      { id: "agy/unknown", engine: "agy", label: "unknown conversation", time: "unknown-age" },
      { id: "cursor/cursor", engine: "cursor", label: "cursor conversation", time: "cursor-age", promptCache: hotCache },
    ];
    const grouped = groupLeaderThreads(threads, native, "/branches");
    await act(async () => root.render(<AiChatSidebar
      repos={[{ id: "ws", label: "workspace", defaultOpen: true, threads: grouped }]}
      activeThreadId="codex/grandchild"
    />));
    const row = (title: string) => node.querySelector<HTMLElement>(`[title="${title}"]`)!.closest("button")!.parentElement!;
    const chip = (title: string) => row(title).querySelector<HTMLElement>("[data-cache-heat]");
    expect(chip("root conversation")?.dataset.cacheHeat).toBe("hot");
    const childChip = chip("child conversation");
    expect(childChip?.dataset.cacheHeat).toBe("cold");
    expect(childChip?.textContent).toBe("child-age");
    expect(childChip?.classList.contains("group-hover:hidden")).toBe(false);
    expect(row("child conversation").textContent).toContain("leader.state.completed");
    expect(chip("grandchild conversation")?.dataset.cacheHeat).toBe("hot");
    expect(row("grandchild conversation").textContent).toContain("leader.state.running");
    expect(chip("unknown conversation")?.dataset.cacheHeat).toBe("unknown");
    expect(row("unknown conversation").textContent).toContain("leader.state.failed");
    expect(chip("cursor conversation")).toBeNull();
    expect(row("cursor conversation").textContent).toContain("cursor-age");
    expect(row("cursor conversation").textContent).toContain("leader.state.stopped");
    expect(chip("task-pending")).toBeNull();
    expect(row("task-pending").textContent).toContain("leader.state.starting");

    await act(async () => childChip!.focus());
    const card = document.body.querySelector('[data-testid="cache-window-hover-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("chat.cacheHeadlineCold");
  });
  it("manages a Windows parent from its branches without an enabled mode", async () => {
    const identity = { ...parent, workspacePath: "G:/project" };
    const child = { ...branch("child"), workspacePath: "G:\\project" };
    const native: LeaderSnapshot = { leaders: [], branches: [child] };
    useLeaderStore.setState({ snapshot: native, managing: identity });
    vi.mocked(invoke).mockImplementation(async (command) => command === "task_branch_action" ? child : native);
    useChatStore.setState({ sessions: [{ ...identity, title: "Windows root", customTitle: null, filePath: "", fileSize: 0, fileMtimeMs: 0,
      preview: "", createdAt: 1, updatedAt: 1, messageCount: 0, pinned: false }] });
    await act(async () => root.render(<><ThreadContextMenu menu={{ x: 0, y: 0, threadId: "claude/root" }} onClose={() => {}} onThreadAction={vi.fn()} /><LeaderManagementHost /></>));
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("leader.manage");
    expect(menu.textContent).not.toContain("leader.disable");
    expect(menu.textContent).not.toContain("chat.deleteSession");
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(child.title);
    await act(async () => { await useLeaderStore.getState().act(identity, child.id, "renew"); });
    expect(invoke).toHaveBeenCalledWith("task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "G:/project", branchId: child.id, action: "renew" });
    for (const workspacePath of ["G:/other", "G:/project/child", "/project\\name"]) {
      await act(async () => { await expect(useLeaderStore.getState().act({ ...identity, workspacePath }, child.id, "renew")).rejects.toThrow(); });
    }
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "task_branch_action")).toHaveLength(1);
  });
  it("ignores a legacy zero-child leader marker and keeps ordinary archive/delete available", async () => {
    const empty: LeaderSnapshot = { leaders: [parent], branches: [] };
    useLeaderStore.setState({ snapshot: empty }); vi.mocked(invoke).mockResolvedValue(empty);
    useChatStore.setState({ sessions: [{ ...parent, title: "Empty Leader root", customTitle: null, filePath: "", fileSize: 0, fileMtimeMs: 0,
      preview: "", createdAt: 1, updatedAt: 1, messageCount: 0, pinned: false }] });
    const grouped = groupLeaderThreads([rows()[0]], empty, "/branches");
    expect(grouped[0].isLeader).not.toBe(true);
    expect(grouped[0].protectedFromDeletion).not.toBe(true);
    const actions = vi.fn();
    await act(async () => root.render(<AiChatSidebar repos={[{ id: "ws", label: "workspace", defaultOpen: true, threads: grouped }]} activeThreadId="claude/root" onThreadAction={actions} />));
    expect(node.querySelector('button[aria-label="chat.deleteSession"]')).not.toBeNull();
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "claude/root" }} onClose={() => {}} onThreadAction={actions} />));
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("chat.archiveSession"); expect(menu.textContent).toContain("chat.deleteSession");
    for (const label of ["leader.enable", "leader.disable", "leader.manage", "leader.archiveGroup", "leader.deleteGroup"]) expect(menu.textContent).not.toContain(label);
    expect(useLeaderStore.getState().managing).toBeNull(); expect(actions).not.toHaveBeenCalled();
    const disabled = groupLeaderThreads([rows()[0]], { leaders: [], branches: [] }, "/branches");
    expect(disabled[0].protectedFromDeletion).not.toBe(true);
  });
  it("retains completed results in the complete tree until explicit whole-group archive, then restores pending fallbacks too", () => {
    const complete = snapshot(); complete.branches[0] = { ...complete.branches[0], state: "completed", result: "kept 中文 🚀" };
    complete.branches.push({ ...branch("pending"), sessionId: null });
    const group: LeaderArchivedGroup = { root: parent, title: "group", archivedAt: 100, members: [parent, { engine: "codex", sessionId: "child", workspacePath: "/branches" }, { engine: "claude", sessionId: "grandchild", workspacePath: "/branches" }], branchIds: complete.branches.map((b) => b.id) };
    expect(groupLeaderThreads(rows(), complete, "/branches")[0].children?.[0].leaderBranch?.result).toBe("kept 中文 🚀");
    expect(groupLeaderThreads(rows(), { ...complete, archivedGroups: [group] }, "/branches")).toEqual([]);
    expect(groupLeaderThreads([], { ...complete, archivedGroups: [group] }, "/branches")).toEqual([]);
    const restored = groupLeaderThreads(rows(), { ...complete, archivedGroups: [] }, "/branches");
    expect(restored[0].children?.[0].selectable).toBe(true);
    expect(restored[0].children?.at(-1)?.selectable).toBe(false);
  });
  it("offers a root group archive entry through management, with no child reclaim guidance", async () => {
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "claude/root" }} onClose={() => {}} onThreadAction={vi.fn()} />));
    const menu = document.body.querySelector('[role="menu"]')!;
    const archive = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.archiveGroup")!;
    expect(archive).toBeTruthy(); expect(menu.textContent).not.toContain("chat.archiveSession");
    await act(async () => archive.click()); expect(useLeaderStore.getState().managing).toEqual(parent);
  });
  it("offers whole-group deletion at the root without deleting before management confirmation", async () => {
    const complete = { ...snapshot(), branches: snapshot().branches.map((b) => ({ ...b, state: "completed" as const })) };
    useLeaderStore.setState({ snapshot: complete }); vi.mocked(invoke).mockResolvedValue(complete);
    const actions = vi.fn();
    await act(async () => root.render(<><ThreadContextMenu menu={{ x: 0, y: 0, threadId: "claude/root" }} onClose={() => {}} onThreadAction={actions} /><LeaderManagementHost /></>));
    const menu = document.body.querySelector('[role="menu"]')!;
    const remove = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!;
    expect(remove).toBeTruthy(); expect(remove.disabled).toBe(false);
    await act(async () => remove.click());
    expect(useLeaderStore.getState().managing).toEqual(parent);
    expect(actions).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    const management = document.body.querySelector('[role="dialog"]')!;
    const confirmEntry = [...management.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!;
    await act(async () => confirmEntry.click());
    const confirmation = [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("leader.deleteGroupConfirm"))!;
    expect(confirmation.textContent).toContain("leader.deleteGroupConfirm:root:2");
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "common.cancel")!.click());
    expect(document.body.textContent).not.toContain("leader.deleteGroupConfirm");
    expect(invoke).not.toHaveBeenCalledWith("task_group_action", expect.anything());
    await act(async () => useLeaderStore.setState({ busy: true }));
    expect(remove.disabled).toBe(true);
  });
  it.each(["codex/child", "claude/grandchild"])("does not expose root group deletion from child %s", async (threadId) => {
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId }} onClose={() => {}} onThreadAction={vi.fn()} />));
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).not.toContain("leader.deleteGroup");
    expect(menu.textContent).not.toContain("chat.deleteSession");
  });
  it("groups recursive mixed-engine children once and paginates whole roots", () => {
    const grouped = groupLeaderThreads(rows(), snapshot(), "/branches");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].children?.[0].children?.[0].id).toBe("claude/grandchild");
    expect(paginateThreads(grouped, 1, 0).visibleThreads[0].children).toHaveLength(1);
    const flat = rows(); expect(groupLeaderThreads(flat, snapshot(), "/other")).toBe(flat);
    expect(paginateThreads(flat, 1, 0).hiddenCount).toBe(2);
  });
  it("reconstitutes a missing parent and keeps pending branches unopenable", () => {
    const pending = { ...branch("pending"), sessionId: null, state: "starting" as const };
    const grouped = groupLeaderThreads([], { leaders: [parent], branches: [pending] }, "/branches");
    expect(grouped[0].id).toBe("claude/root");
    expect(grouped[0].leaderParentFallback).toBe(true);
    expect(grouped[0].children?.[0].selectable).toBe(false);
  });
  it("reveals ancestors and the workspace on child selection, preserves manual collapse and hides delete", async () => {
    const select = vi.fn(), action = vi.fn();
    const repos = [{ id: "ws", label: "workspace", threads: groupLeaderThreads(rows(), snapshot(), "/branches") }];
    await act(async () => root.render(<AiChatSidebar repos={repos} activeThreadId="claude/grandchild" onThreadSelect={select} onThreadAction={action} />));
    const toggles = [...node.querySelectorAll<HTMLButtonElement>('button[aria-label="leader.toggleChildren"]')];
    expect(toggles).toHaveLength(2);
    expect(toggles.every((b) => b.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(node.textContent).toContain("grandchild conversation");
    expect(node.querySelector('button[aria-label="chat.deleteSession"]')).toBeNull();
    const child = [...node.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("grandchild conversation"))!;
    await act(async () => child.click()); expect(select).toHaveBeenCalledWith("claude/grandchild");
    await act(async () => toggles[0].click());
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("ccgui.leader.expanded.v1")!)).toHaveLength(1);
    // Native status refresh recreates child objects; it must not fight a
    // user who just collapsed the currently selected branch's ancestor.
    const refreshed = [{ ...repos[0], threads: groupLeaderThreads(rows(), snapshot(), "/branches") }];
    await act(async () => root.render(<AiChatSidebar repos={refreshed} activeThreadId="claude/grandchild" onThreadSelect={select} onThreadAction={action} />));
    expect(node.querySelector('button[aria-label="leader.toggleChildren"]')?.getAttribute("aria-expanded")).toBe("false");
  });
  it("child menu routes management to its own children and offers no archive/delete", async () => {
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "codex/child" }} onClose={() => {}} onThreadAction={vi.fn()} />));
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("leader.goParent"); expect(menu.textContent).toContain("leader.manage");
    expect(menu.textContent).not.toContain("chat.deleteSession"); expect(menu.textContent).not.toContain("chat.archiveSession");
    const manage = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("leader.manage"))!;
    await act(async () => manage.click());
    expect(useLeaderStore.getState().managing).toEqual({ engine: "codex", sessionId: "child", workspacePath: "/branches" });
  });
});

describe("Leader TTL and context management display", () => {
  it("keeps sidebar TTL readable alongside a truncated long title and exposes the complete expired deadline and error", async () => {
    const expired = { ...branch("child"), expired: true, deadlineAt: new Date("2026-10-04T11:15:30Z").getTime(), error: "retained failure" };
    const label = "Very long task title 中文 🚀 ".repeat(20);
    const threads = groupLeaderThreads([rows()[0], { ...rows()[1], label }], { leaders: [parent], branches: [expired] }, "/branches");
    await act(async () => root.render(<AiChatSidebar repos={[{ id: "ws", label: "workspace", threads }]} activeThreadId="codex/child" />));
    const title = [...node.querySelectorAll<HTMLElement>("[title]")].find((element) => element.title === label)!;
    expect(title.className).toContain("truncate"); expect(title.className).toContain("min-w-0");
    const ttl = [...node.querySelectorAll<HTMLElement>("[title]")].find((element) => element.title.includes("leader.expiredDeadline"))!;
    expect(ttl.title).toContain(new Date(expired.deadlineAt).toLocaleString()); expect(ttl.title).toContain("retained failure");
    expect(ttl.textContent).toContain("leader.ttlExpiredShort"); expect(ttl.querySelector(".whitespace-nowrap")).toBeTruthy();
    expect(ipc.loadSessionPage).not.toHaveBeenCalled();
  });
  it("shows accurate expired deadlines and suggests only expired high historical occupancy without changing focus or compacting", async () => {
    const children = [
      { ...branch("not-expired"), state: "completed" as const },
      { ...branch("low", "claude"), state: "waiting" as const, expired: true, deadlineAt: 1234 },
      { ...branch("high", "claude"), state: "stopped" as const, expired: true, deadlineAt: 2345 },
      { ...branch("unknown"), state: "completed" as const, expired: true, deadlineAt: 3456 },
      { ...branch("no-window"), state: "completed" as const, expired: true, deadlineAt: 4567 },
    ];
    const readings: Record<string, unknown> = {
      "not-expired": { input_tokens: 900_000, model_context_window: 1_000_000 },
      low: { input_tokens: 25_000 }, high: { input_tokens: 375_000 },
      unknown: { info: { model_context_window: 1_000_000, total_token_usage: { input_tokens: 9_000_000 } } },
      "no-window": { input_tokens: 900_000 },
    };
    vi.mocked(ipc.loadSessionPage).mockImplementation(async (_engine, id) => ({ messages: [{ seq: 1, role: "assistant", text: "history", ts: null, usage: readings[id] }], subagentHistory: [], nextBefore: null }));
    useLeaderStore.setState({ managing: parent, snapshot: { leaders: [parent], branches: children } });
    const foreground = { engine: "codex", sessionId: "foreground", workspacePath: "/other" };
    useChatStore.setState({ active: foreground, openTabs: [foreground], bySession: {
      "codex/foreground": { ...EMPTY_SESSION, usage: { input_tokens: 800_000, model_context_window: 1_000_000 } },
      "claude/low": { ...EMPTY_SESSION, usage: { input_tokens: 900_000, model_context_window: 1_000_000 } },
      "claude/high": { ...EMPTY_SESSION, usage: { input_tokens: 900_000, model_context_window: 1_000_000 } },
      "codex/unknown": { ...EMPTY_SESSION, usage: { input_tokens: 900_000, model_context_window: 1_000_000 } },
    } });
    const before = useChatStore.getState(); const compact = vi.spyOn(before, "compactContext").mockResolvedValue();
    await act(async () => root.render(<LeaderManagementHost />));
    const card = (id: string) => document.body.querySelector(`[data-leader-branch="${id}"]`)!;
    expect(card("not-expired").textContent).not.toContain("leader.compactSuggestion");
    expect(card("low").textContent).toContain("leader.contextUsage:25,000/750,000:3%"); expect(card("low").textContent).not.toContain("leader.compactSuggestion");
    expect(card("high").textContent).toContain("leader.contextUsage:375,000/750,000:50%"); expect(card("high").textContent).toContain("leader.compactSuggestion");
    expect(card("high").textContent).toContain(`leader.expiredDeadline:${new Date(2345).toLocaleString()}`); expect(card("high").textContent).toContain("leader.contextHistory");
    expect(card("unknown").textContent).toContain("leader.contextUsage:leader.unknown/1,000,000:leader.unknown"); expect(card("unknown").textContent).not.toContain("leader.compactSuggestion");
    expect(card("no-window").textContent).toContain("leader.contextUsage:900,000/leader.unknown:leader.unknown"); expect(card("no-window").textContent).not.toContain("leader.compactSuggestion");
    expect(ipc.officialConfigRead).toHaveBeenCalledExactlyOnceWith("claude"); expect(ipc.loadSessionPage).toHaveBeenCalledTimes(5);
    expect(useChatStore.getState()).toBe(before); expect(compact).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it("renews both child engines with native defaults, clears expired guidance immediately, and accepts an explicit override", async () => {
    const children = ["codex", "claude"].map((engine) => ({ ...branch(`renew-${engine}`, engine), state: "completed" as const, expired: true, deadlineAt: 1234 }));
    let currentSnapshot: LeaderSnapshot = { leaders: [parent], branches: children };
    useLeaderStore.setState({ managing: parent, snapshot: currentSnapshot });
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({ messages: [{ seq: 1, role: "assistant", text: "history", ts: null, usage: { input_tokens: 600_000, model_context_window: 1_000_000 } }], subagentHistory: [], nextBefore: null });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "task_branch_action") return currentSnapshot;
      const renewed = { ...currentSnapshot.branches.find((child) => child.id === (args as { branchId: string }).branchId)!, expired: false, deadlineAt: Date.now() + 3600_000 };
      currentSnapshot = { ...currentSnapshot, branches: currentSnapshot.branches.map((child) => child.id === renewed.id ? renewed : child) };
      return renewed;
    });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!; const input = dialog.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.value).toBe(""); expect(dialog.textContent).toContain("leader.ttlDefaultHint");
    const renew = (id: string) => [...dialog.querySelectorAll<HTMLButtonElement>(`[data-leader-branch="${id}"] button`)].find((button) => button.textContent === "leader.renew")!;
    await act(async () => renew("renew-codex").click());
    expect(dialog.querySelector('[data-leader-branch="renew-codex"]')?.textContent).not.toContain("leader.compactSuggestion");
    await act(async () => renew("renew-claude").click());
    const defaultCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "task_branch_action");
    expect(defaultCalls).toHaveLength(2); expect(defaultCalls.every(([, args]) => !("ttlSeconds" in (args as object)))).toBe(true);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "45"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => renew("renew-codex").click());
    expect(invoke).toHaveBeenCalledWith("task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "/branches", branchId: "renew-codex", action: "renew", ttlSeconds: 2700 });
  });
  it.each(["0", "0.5"])("shows invalid renewal input %s and prevents IPC until the input is cleared", async (value) => {
    useLeaderStore.setState({ managing: parent });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>('input[type="number"]')!;
    const renew = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "leader.renew")!;
    expect(renew.disabled).toBe(false);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(input.getAttribute("aria-invalid")).toBe("true"); expect(dialog.textContent).toContain("leader.ttlRangeError"); expect(renew.disabled).toBe(true);
    await act(async () => renew.click());
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(input.getAttribute("aria-invalid")).toBe("false"); expect(dialog.textContent).not.toContain("leader.ttlRangeError"); expect(renew.disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("shows an inline history read failure, clears old high guidance and skips refresh success feedback without retrying automatically", async () => {
    vi.useFakeTimers();
    const child = { ...branch("child"), state: "completed" as const, expired: true, deadlineAt: 1234 };
    const currentSnapshot = { leaders: [parent], branches: [child] };
    useLeaderStore.setState({ managing: parent, snapshot: currentSnapshot }); vi.mocked(invoke).mockResolvedValue(currentSnapshot);
    const highUsage = { input_tokens: 600_000, model_context_window: 1_000_000 };
    useChatStore.setState({ bySession: { "codex/child": { ...EMPTY_SESSION, usage: highUsage } } });
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ messages: [{ seq: 1, role: "assistant", text: "history", usage: highUsage, ts: null }], subagentHistory: [], nextBefore: null })
      .mockRejectedValueOnce(new Error("private transcript and credential details"));
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const refresh = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "leader.refresh")!;
    const card = dialog.querySelector('[data-leader-branch="child"]')!;
    expect(card.textContent).toContain("leader.compactSuggestion");
    await act(async () => refresh.click());
    expect(card.textContent).toContain("leader.contextReadFailed"); expect(card.textContent).toContain("leader.contextUsage:leader.unknown/1,000,000:leader.unknown");
    expect(card.textContent).not.toContain("leader.compactSuggestion"); expect(card.textContent).not.toContain("private transcript and credential details");
    await act(async () => vi.advanceTimersByTime(700));
    expect(refresh.querySelector(".lucide-check.opacity-100")).toBeNull(); expect(refresh.disabled).toBe(false);
    await act(async () => useLeaderStore.setState({ snapshot: { ...currentSnapshot, branches: [{ ...child, updatedAt: 999 }] } }));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2); expect(refresh.querySelector(".lucide-check.opacity-100")).toBeNull();
  });
  it("keeps a successful history read with no usage unknown and still shows normal refresh success feedback", async () => {
    vi.useFakeTimers();
    const child = { ...branch("child"), state: "completed" as const, expired: true, deadlineAt: 1234 };
    const currentSnapshot = { leaders: [parent], branches: [child] };
    useLeaderStore.setState({ managing: parent, snapshot: currentSnapshot }); vi.mocked(invoke).mockResolvedValue(currentSnapshot);
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({ messages: [{ seq: 1, role: "assistant", text: "no usage report", ts: null }], subagentHistory: [], nextBefore: null });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const refresh = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "leader.refresh")!;
    await act(async () => refresh.click());
    expect(dialog.textContent).toContain("leader.contextUsage:leader.unknown/leader.unknown:leader.unknown"); expect(dialog.textContent).not.toContain("leader.contextReadFailed");
    await act(async () => vi.advanceTimersByTime(700));
    expect(refresh.querySelector(".lucide-check.opacity-100")).not.toBeNull(); expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2);
  });
});

function deps(): EngineEventDeps {
  return { set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: (meta) => upsertSessionMetaInto(useChatStore.setState, meta) };
}
describe("Leader over the remote browser transport", () => {
  beforeEach(() => { runtime.web = true; });

  it("offers AGY root controls and direct-child management without ordinary deletion", async () => {
    const agyParent = { ...parent, engine: "agy" };
    const child = branch("agy-child", "agy", "root", "agy");
    useLeaderStore.setState({ snapshot: { leaders: [agyParent], branches: [child] } });
    useChatStore.setState({ sessions: [{ engine: "agy", sessionId: "root", workspacePath: parent.workspacePath } as SessionMeta] });
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "agy/root" }} onClose={() => {}} />));
    let menu = document.body.querySelector('[role="menu"]')!;
    for (const label of ["leader.manage", "leader.archiveGroup", "leader.deleteGroup"]) expect(menu.textContent).toContain(label);
    expect(menu.textContent).not.toContain("leader.disable");
    expect(menu.textContent).not.toContain("chat.deleteSession");
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "agy/agy-child" }} onClose={() => {}} />));
    menu = document.body.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("leader.goParent");
    expect(menu.textContent).toContain("leader.manage");
    expect(menu.textContent).not.toContain("leader.enable");
    expect(menu.textContent).not.toContain("chat.deleteSession");
  });

  it("offers child management and group actions for host-local sessions without a mode switch", async () => {
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "claude/root" }} onClose={() => {}} />));
    const menu = document.body.querySelector('[role="menu"]')!;
    for (const label of ["leader.manage", "leader.archiveGroup", "leader.deleteGroup"]) expect(menu.textContent).toContain(label);
    expect(menu.textContent).not.toContain("leader.disable");
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: "codex/child" }} onClose={() => {}} />));
    expect(document.body.querySelector('[role="menu"]')!.textContent).toContain("leader.manage");
    await act(async () => useLeaderStore.setState({ managing: parent }));
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('input[type="number"]')).toBeTruthy();
    for (const label of ["leader.renew", "leader.stop", "leader.archiveGroup", "leader.deleteGroup"]) expect(dialog.textContent).toContain(label);
    const renew = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "leader.renew")!;
    vi.mocked(invoke).mockResolvedValueOnce(branch("child")).mockResolvedValueOnce(snapshot());
    await act(async () => renew.click());
    expect(invoke).toHaveBeenCalledWith("task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "/branches", branchId: "child", action: "renew" });
  });

  it.each(["remote", "unsupported"])("keeps mode unavailable for %s sessions", async (kind) => {
    const identity = { ...parent, engine: kind === "unsupported" ? "pi" : "claude" };
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
    useChatStore.setState({ sessions: [{ ...identity, remote: kind === "remote", title: "session", customTitle: null, filePath: "", fileSize: 0, fileMtimeMs: 0,
      preview: "", createdAt: 1, updatedAt: 1, messageCount: 0, pinned: false }] });
    await act(async () => root.render(<ThreadContextMenu menu={{ x: 0, y: 0, threadId: `${identity.engine}/${identity.sessionId}` }} onClose={() => {}} />));
    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain("leader.enable");
  });

  it("refreshes the authoritative branch snapshot and preserves it on read failure", async () => {
    await useLeaderStore.getState().refresh();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("task_snapshot", {});
    const next = { leaders: [], branches: [] };
    vi.mocked(invoke).mockResolvedValueOnce(next);
    await useLeaderStore.getState().refresh();
    expect(invoke).toHaveBeenLastCalledWith("task_snapshot", {});
    expect(useLeaderStore.getState().snapshot).toBe(next);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Leader workspace authority rejected"));
    await useLeaderStore.getState().refresh();
    expect(useLeaderStore.getState().snapshot).toBe(next);
    expect(useLeaderStore.getState()).toMatchObject({ error: "Leader workspace authority rejected", busy: false });
  });

  it.each(["stop", "renew", "reclaim"] as const)("dispatches %s only for a direct child", async (action) => {
    const result = { ...branch("child"), state: action === "reclaim" ? "reclaimed" as const : "stopped" as const };
    vi.mocked(invoke).mockResolvedValueOnce(result).mockResolvedValueOnce(snapshot());
    await useLeaderStore.getState().act(parent, "child", action);
    expect(invoke).toHaveBeenNthCalledWith(1, "task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "/branches", branchId: "child", action });
    expect(invoke).toHaveBeenNthCalledWith(2, "task_snapshot", {});
    vi.mocked(invoke).mockClear();
    await expect(useLeaderStore.getState().act({ ...parent, sessionId: "sibling" }, "child", action)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["archive", "restore", "delete"] as const)("dispatches whole-group %s", async (action) => {
    const refreshSessions = vi.spyOn(useChatStore.getState(), "refreshSessions").mockResolvedValue();
    const next: LeaderSnapshot = { leaders: [parent], branches: [] };
    vi.mocked(invoke).mockResolvedValueOnce(next);
    await useLeaderStore.getState().groupAction(parent, action);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("task_group_action", { ...parent, action });
    expect(useLeaderStore.getState().snapshot).toBe(next);
    expect(refreshSessions).toHaveBeenCalledTimes(action === "restore" ? 1 : 0);
  });
});

describe("Leader runtime connection lifecycle", () => {
  it.each([false, true])("loads initially and reconciles changed and connected snapshots (web=%s)", async (web) => {
    runtime.web = web;
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    const unlisteners = [vi.fn(), vi.fn()];
    vi.mocked(listen).mockImplementation(async (name, callback) => {
      callbacks.set(name, callback);
      return unlisteners[callbacks.size - 1];
    });
    const initial: LeaderSnapshot = { leaders: [parent], branches: [] };
    vi.mocked(invoke).mockResolvedValueOnce(initial);
    const off = startLeaderRuntime();
    try {
      await vi.waitFor(() => expect(useLeaderStore.getState().snapshot).toBe(initial));
      expect([...callbacks.keys()]).toEqual(["task://changed", "transport://connected"]);
      expect(invoke).toHaveBeenCalledExactlyOnceWith("task_snapshot", {});
      const changed = snapshot();
      vi.mocked(invoke).mockResolvedValueOnce(changed);
      callbacks.get("task://changed")!({ payload: null });
      await vi.waitFor(() => expect(useLeaderStore.getState().snapshot).toBe(changed));
      vi.mocked(invoke).mockRejectedValueOnce(new Error("web bridge disconnected"));
      callbacks.get("task://changed")!({ payload: null });
      await vi.waitFor(() => expect(useLeaderStore.getState().error).toBe("web bridge disconnected"));
      const reconnected: LeaderSnapshot = { ...changed, branches: [...changed.branches, branch("reconnected")] };
      vi.mocked(invoke).mockResolvedValueOnce(reconnected);
      callbacks.get("transport://connected")!({ payload: "1.1.1" });
      await vi.waitFor(() => expect(useLeaderStore.getState().snapshot).toBe(reconnected));
      expect(useLeaderStore.getState().error).toBeNull();
    } finally { off(); }
    unlisteners.forEach((unlisten) => expect(unlisten).toHaveBeenCalledOnce());
    vi.mocked(invoke).mockClear();
    callbacks.forEach((callback) => callback({ payload: null }));
    expect(invoke).not.toHaveBeenCalled();
    const afterUnmount = branch(`after-unmount-${web}`);
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [afterUnmount] } });
    useChatStore.setState({ bySession: { [`codex/${afterUnmount.id}`]: { ...EMPTY_SESSION } } });
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
    expect(useChatStore.getState().bySession[`codex/${afterUnmount.id}`]).toBeTruthy();
  });

  it("cleans both asynchronous subscriptions after disposal without starting an initial request", async () => {
    const pending: Array<(off: () => void) => void> = [];
    vi.mocked(listen).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const unlisteners = [vi.fn(), vi.fn()];
    const off = startLeaderRuntime(); off();
    pending.forEach((resolve, index) => resolve(unlisteners[index]));
    await Promise.resolve();
    unlisteners.forEach((unlisten) => expect(unlisten).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cleans the remaining subscription when the connection listener fails", async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error("connection listener failed"));
    const off = startLeaderRuntime();
    await vi.waitFor(() => expect(useLeaderStore.getState().error).toContain("connection listener failed"));
    off();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("native-managed background events", () => {
  it("adopts two same-engine children without taking a foreground draft or opening tabs", () => {
    const draft = { ...EMPTY_SESSION, messages: [{ seq: 1, role: "user", text: "my unsent task", ts: null }] };
    const active = { engine: "codex", sessionId: null, workspacePath: "/foreground" };
    useChatStore.setState({ active, openTabs: [active], bySession: { "new:codex:/foreground": draft } });
    const events = ["one", "two"].map((id) => ({ engine: "codex", sessionId: id, runId: `background-${id}`, seq: 1, kind: "session" as const, data: id,
      leader: { branchId: `branch-${id}`, workspacePath: "/branches", title: id, assignment: `任务 ${id} 🚀` } }));
    handleEngineEvents(events, deps()); handleEngineEvents(events, deps());
    const state = useChatStore.getState();
    expect(state.active).toBe(active); expect(state.openTabs).toEqual([active]); expect(state.bySession["new:codex:/foreground"]).toBe(draft);
    expect(state.bySession["codex/one"].messages.map((m) => m.text)).toEqual(["任务 one 🚀"]);
    expect(state.bySession["codex/two"].messages.map((m) => m.text)).toEqual(["任务 two 🚀"]);
    expect(state.sessions.every((m) => m.workspacePath === "/branches")).toBe(true);
    handleEngineEvents([{ ...events[0], kind: "delta", data: "中文 👨‍👩‍👧‍👦" }, { ...events[0], kind: "done", data: { usage: null } }], deps());
    expect(useChatStore.getState().bySession["codex/one"].messages.at(-1)?.text).toBe("中文 👨‍👩‍👧‍👦");
    expect(useChatStore.getState().bySession["codex/one"].streaming).toBe(false);
  });
  it("adopts an early delta before the session event and retains it through assignment/error", () => {
    const event = { engine: "claude", sessionId: "early", runId: "early-run", seq: 1, kind: "delta" as const, data: "partial",
      leader: { branchId: "early-branch", workspacePath: "/branches", title: "early" } };
    handleEngineEvents([event, { ...event, kind: "session", data: "early", leader: { ...event.leader, assignment: "task" } }, { ...event, kind: "error", data: "failure" }], deps());
    expect(useChatStore.getState().bySession["claude/early"].messages.map((m) => m.text)).toContain("partial");
    expect(useChatStore.getState().bySession["claude/early"].error).toBe("failure");
  });
  it("rejects a native reclaimed event before touching a draft", () => {
    handleEngineEvents([{ engine: "codex", sessionId: "dead", runId: "dead-run", seq: 1, kind: "session", data: "dead", leader: { branchId: "dead", workspacePath: "/branches", title: "dead", reclaimed: true } }], deps());
    expect(useChatStore.getState().bySession).toEqual({}); expect(useChatStore.getState().sessions).toEqual([]);
  });
  it("ignores a native rejected identity without changing an unrelated draft", () => {
    const draft = { ...EMPTY_SESSION };
    useChatStore.setState({ bySession: { "new:codex:/foreground": draft } });
    handleEngineEvents([{ engine: "codex", sessionId: "forged", runId: "forged-run", seq: 1, kind: "session", data: "forged",
      leader: { branchId: "forged", workspacePath: "/branches", title: "forged", identityRejected: true } }], deps());
    expect(useChatStore.getState().bySession).toEqual({ "new:codex:/foreground": draft });
    expect(useChatStore.getState().sessions).toEqual([]);
  });
  it("hydrates managed optimistic history after stability without replacing deltas during a history race", async () => {
    const key = "codex/hydrating";
    leaderHistoryLoaded(key);
    handleEngineEvents([{ engine: "codex", sessionId: "hydrating", runId: "hydrating-run", seq: 1, kind: "session", data: "hydrating",
      leader: { branchId: "hydrating-branch", workspacePath: "/branches", title: "hydrating", assignment: "task" } }], deps());
    let state = useChatStore.getState();
    const observers = new Set<() => void>();
    const set = (patch: Partial<ChatStore> | ((s: ChatStore) => Partial<ChatStore>)) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; [...observers].forEach(fn => fn()); };
    const history: SessionPage = { messages: [{ seq: 1, role: "user", text: "task", ts: null }, { seq: 2, role: "assistant", text: "final", ts: null }], subagentHistory: [], nextBefore: null };
    const load = vi.fn(async () => history);
    const teardowns: Array<() => void> = [];
    const actions = createSessionActions({ get: () => state, set, subscribe: fn => { observers.add(fn); return () => { observers.delete(fn); }; },
      loadHistoryPage: load, eventTeardowns: teardowns, activateTab: () => {}, removeTab: () => {}, forgetClosedTab: () => {}, drainQueue: () => {}, markUnseenIfBackground: () => {} });
    try {
      await actions.selectSession("codex", "hydrating", "/branches", { background: true });
      expect(load).not.toHaveBeenCalled();
      expect(state.active).toBeNull();
      set(s => ({ bySession: { ...s.bySession, [key]: { ...s.bySession[key], streaming: false } } }));
      await vi.waitFor(() => expect(state.bySession[key].messages).toBe(history.messages));
      expect(state.bySession[key].messages.filter(m => m.role === "user")).toHaveLength(1);
    } finally { teardowns.forEach(off => off()); }
  });
});

describe("parent management and lifecycle", () => {
  it("archives all generations and the root in one batch, restores without tombstones or stealing focus", async () => {
    const child = { ...branch("archive-clean-child"), state: "completed" as const, result: "saved result" };
    const grandchild = { ...branch("archive-clean-grandchild", "claude", child.sessionId!, child.engine), state: "stopped" as const };
    const groupRoot = { ...parent, sessionId: "archive-clean-root" }; child.parentSessionId = groupRoot.sessionId;
    const before: LeaderSnapshot = { leaders: [groupRoot], branches: [child, grandchild] };
    const members = [groupRoot, { engine: child.engine, sessionId: child.sessionId!, workspacePath: child.workspacePath }, { engine: grandchild.engine, sessionId: grandchild.sessionId!, workspacePath: grandchild.workspacePath }];
    const archived: LeaderSnapshot = { ...before, archivedGroups: [{ root: groupRoot, title: "saved group", archivedAt: 1, members, branchIds: [child.id, grandchild.id] }] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "codex", sessionId: "archive-focus-survivor", workspacePath: "/foreground" };
    const keys = members.map((m) => `${m.engine}/${m.sessionId}`);
    // A fully warm cache includes usage; missing usage legitimately triggers a history backfill.
    const usage = { input_tokens: 100, output_tokens: 20 };
    useChatStore.setState({ active: members[0], openTabs: [survivor, ...members], bySession: Object.fromEntries([...keys, "codex/archive-focus-survivor"].map((key) => [key, { ...EMPTY_SESSION, usage, messages: [{ seq: 1, role: "assistant", text: "loaded history", ts: null, usage }] }])), drafts: Object.fromEntries(keys.map((key) => [key, "unsent"])), unseen: Object.fromEntries(keys.map((key) => [key, true])) });
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    const refreshSessions = vi.spyOn(useChatStore.getState(), "refreshSessions").mockResolvedValue();
    try {
      vi.mocked(invoke).mockResolvedValueOnce(archived);
      await useLeaderStore.getState().groupAction(groupRoot, "archive");
      expect(invoke).toHaveBeenLastCalledWith("task_group_action", { ...groupRoot, action: "archive" });
      expect(useChatStore.getState().openTabs).toEqual([survivor]); expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(activated).toHaveBeenCalledExactlyOnceWith({ engine: survivor.engine, sessionId: survivor.sessionId });
      for (const key of keys) { expect(useChatStore.getState().bySession[key]).toBeUndefined(); expect(useChatStore.getState().drafts[key]).toBeUndefined(); expect(isReclaimedLeaderSession(key)).toBe(false); }
      expect(leaderEventAllowed(child.id, keys[1])).toBe(true);
      expect(useLeaderStore.getState().snapshot.branches).toBe(before.branches);
      activated.mockClear(); vi.mocked(invoke).mockResolvedValueOnce({ ...before, archivedGroups: [] });
      await useLeaderStore.getState().groupAction(groupRoot, "restore");
      expect(ipc.rescanSessions).toHaveBeenCalledOnce(); expect(refreshSessions).toHaveBeenCalledOnce();
      expect(useChatStore.getState().archivedSessionKeys).toEqual({}); expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(activated).not.toHaveBeenCalled(); expect(ipc.loadSessionPage).not.toHaveBeenCalled();
      expect(groupLeaderThreads([], useLeaderStore.getState().snapshot, "/branches")[0].children?.[0].selectable).toBe(true);
    } finally { offActivated(); off(); }
  });
  it("rejects child group actions and serializes double clicks; native idle errors preserve results", async () => {
    const before = useLeaderStore.getState().snapshot;
    await expect(useLeaderStore.getState().groupAction({ engine: "codex", sessionId: "child", workspacePath: "/branches" }, "archive")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    let reject!: (reason: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = useLeaderStore.getState().groupAction(parent, "archive");
    await expect(useLeaderStore.getState().groupAction(parent, "delete")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    reject(new Error("Root is waiting for approval")); await expect(pending).rejects.toThrow("waiting for approval");
    expect(useLeaderStore.getState().snapshot).toBe(before); expect(useLeaderStore.getState().busy).toBe(false);
    expect(useLeaderStore.getState().error).toContain("waiting for approval");
  });
  it("reconciles a partially failed delete without retrying or clearing the original error", async () => {
    const before = useLeaderStore.getState().snapshot;
    const partial: LeaderSnapshot = { ...before, archivedGroups: [{ root: parent, title: "Partial group", archivedAt: 1,
      members: [parent, { engine: "codex", sessionId: "child", workspacePath: "/branches" }], branchIds: before.branches.map((b) => b.id), deletionStarted: true }] };
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Second transcript deletion failed")).mockResolvedValueOnce(partial);
    await expect(useLeaderStore.getState().groupAction(parent, "delete")).rejects.toThrow("Second transcript deletion failed");
    expect(invoke).toHaveBeenNthCalledWith(1, "task_group_action", { ...parent, action: "delete" });
    expect(invoke).toHaveBeenNthCalledWith(2, "task_snapshot", {});
    expect(invoke).toHaveBeenCalledTimes(2); expect(ipc.rescanSessions).not.toHaveBeenCalled();
    expect(useLeaderStore.getState().snapshot).toBe(partial);
    expect(useLeaderStore.getState().snapshot.archivedGroups?.[0].deletionStarted).toBe(true);
    expect(useLeaderStore.getState().error).toBe("Second transcript deletion failed"); expect(useLeaderStore.getState().busy).toBe(false);
  });
  it("closes the full cached group after a partially failed delete without tombstones and activates one survivor", async () => {
    const groupRoot = { ...parent, sessionId: "partial-cache-root" };
    const child = { ...branch("partial-cache-child"), parentSessionId: groupRoot.sessionId };
    const grandchild = branch("partial-cache-grandchild", "claude", child.sessionId!, child.engine);
    const before: LeaderSnapshot = { leaders: [groupRoot], branches: [child, grandchild] };
    const members = [groupRoot, { engine: child.engine, sessionId: child.sessionId!, workspacePath: child.workspacePath },
      { engine: grandchild.engine, sessionId: grandchild.sessionId!, workspacePath: grandchild.workspacePath }];
    const keys = members.map((member) => `${member.engine}/${member.sessionId}`);
    const survivor = { engine: "codex", sessionId: "partial-cache-survivor", workspacePath: "/foreground" };
    const survivorKey = "codex/partial-cache-survivor";
    const usage = { input_tokens: 100, output_tokens: 20 };
    const cache = { ...EMPTY_SESSION, usage, messages: [{ seq: 1, role: "assistant", text: "warm survivor history", ts: null, usage }] };
    useLeaderStore.setState({ snapshot: before });
    useChatStore.setState({ active: groupRoot, openTabs: [survivor, ...members], bySession: Object.fromEntries([...keys, survivorKey].map((key) => [key, cache])),
      drafts: Object.fromEntries(keys.map((key) => [key, "draft"])), unseen: Object.fromEntries(keys.map((key) => [key, true])) });
    const partial: LeaderSnapshot = { ...before, archivedGroups: [{ root: groupRoot, title: "Partial cached group", archivedAt: 1, members,
      branchIds: before.branches.map((b) => b.id), deletionStarted: true }] };
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    try {
      vi.mocked(invoke).mockRejectedValueOnce(new Error("Later transcript deletion failed")).mockResolvedValueOnce(partial);
      await expect(useLeaderStore.getState().groupAction(groupRoot, "delete")).rejects.toThrow("Later transcript deletion failed");
      expect(useChatStore.getState().openTabs).toEqual([survivor]); expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(useChatStore.getState().bySession[survivorKey]).toBe(cache);
      expect(activated).toHaveBeenCalledExactlyOnceWith({ engine: survivor.engine, sessionId: survivor.sessionId });
      expect(ipc.loadSessionPage).not.toHaveBeenCalled();
      for (const key of keys) {
        expect(useChatStore.getState().bySession[key]).toBeUndefined(); expect(useChatStore.getState().drafts[key]).toBeUndefined();
        expect(useChatStore.getState().unseen[key]).toBeUndefined(); expect(useChatStore.getState().archivedSessionKeys[key]).toBe(true);
        expect(isReclaimedLeaderSession(key)).toBe(false);
      }
      expect(leaderEventAllowed(child.id, keys[1])).toBe(true); expect(leaderEventAllowed(grandchild.id, keys[2])).toBe(true);
      expect(useLeaderStore.getState().snapshot).toBe(partial); expect(useLeaderStore.getState().snapshot.branches).toBe(before.branches);
      expect(useLeaderStore.getState().error).toBe("Later transcript deletion failed"); expect(useLeaderStore.getState().busy).toBe(false);
    } finally { offActivated(); }
  });
  it("preserves open tabs and caches when delete fails before committing a group archive", async () => {
    const groupRoot = { ...parent, sessionId: "uncommitted-root" };
    const child = { ...branch("uncommitted-child"), parentSessionId: groupRoot.sessionId };
    const before: LeaderSnapshot = { leaders: [groupRoot], branches: [child] };
    const childTab = { engine: child.engine, sessionId: child.sessionId!, workspacePath: child.workspacePath };
    useLeaderStore.setState({ snapshot: before });
    useChatStore.setState({ active: groupRoot, openTabs: [groupRoot, childTab], bySession: { "claude/uncommitted-root": { ...EMPTY_SESSION }, "codex/uncommitted-child": { ...EMPTY_SESSION } }, drafts: { "claude/uncommitted-root": "keep draft" } });
    const cached = useChatStore.getState();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Root is still running")).mockResolvedValueOnce(before);
    await expect(useLeaderStore.getState().groupAction(groupRoot, "delete")).rejects.toThrow("Root is still running");
    expect(useChatStore.getState()).toBe(cached); expect(useLeaderStore.getState().snapshot).toBe(before);
    expect(useLeaderStore.getState().error).toBe("Root is still running"); expect(useLeaderStore.getState().busy).toBe(false);
  });
  it.each(["archive", "delete", "renew"] as const)("keeps a failed %s operation visible after a late snapshot refresh until the next explicit action", async (action) => {
    const complete: LeaderSnapshot = { ...snapshot(), branches: snapshot().branches.map((b) => ({ ...b, state: "completed" })) };
    useLeaderStore.setState({ managing: parent, snapshot: complete });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const label = action === "archive" ? "leader.archiveGroup" : action === "delete" ? "leader.deleteGroup" : "leader.renew";
    const control = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
    vi.mocked(invoke).mockRejectedValueOnce(new Error(`${action} operation failed`));
    if (action === "delete") {
      vi.mocked(invoke).mockResolvedValueOnce(complete);
      await act(async () => control.click());
      const confirmation = [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("leader.deleteGroupConfirm"))!;
      await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!.click());
    } else await act(async () => control.click());
    expect(dialog.textContent).toContain(`${action} operation failed`);
    vi.mocked(invoke).mockResolvedValueOnce(complete);
    await act(async () => useLeaderStore.getState().refresh());
    expect(useLeaderStore.getState().error).toBeNull();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(`${action} operation failed`);
    vi.mocked(invoke).mockResolvedValueOnce(complete.branches[0]).mockResolvedValueOnce(complete);
    const renew = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.renew")!;
    await act(async () => renew.click());
    expect(dialog.textContent).not.toContain(`${action} operation failed`);
  });
  it("shows incomplete root deletion with retained archive title, disables archive and confirms explicit deletion retry", async () => {
    const complete: LeaderSnapshot = { ...snapshot(), branches: snapshot().branches.map((b) => ({ ...b, state: "completed" })),
      archivedGroups: [{ root: parent, title: "Retained archived title", archivedAt: 1, members: [parent], branchIds: ["child", "grandchild"], deletionStarted: true }] };
    useLeaderStore.setState({ managing: parent, snapshot: complete });
    useChatStore.setState({ sessions: [] });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("leader.groupDeletionIncomplete"); expect(dialog.textContent).not.toContain("leader.groupArchiveHint");
    const archive = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.archiveGroup")!;
    expect(archive.disabled).toBe(true);
    const retry = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.retryDeleteGroup")!;
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click()); expect(invoke).not.toHaveBeenCalled();
    const confirmation = [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("leader.deleteGroupConfirm"))!;
    expect(confirmation.textContent).toContain("leader.deleteGroupConfirm:Retained archived title:2");
    vi.mocked(invoke).mockResolvedValueOnce({ leaders: [], branches: [], archivedGroups: [] });
    await act(async () => [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!.click());
    expect(invoke).toHaveBeenCalledWith("task_group_action", { ...parent, action: "delete" });
  });
  it("shows whole-group controls only at the root, blocks archive for active descendants, and confirms deletion", async () => {
    useLeaderStore.setState({ managing: { engine: "codex", sessionId: "child", workspacePath: "/branches" } });
    await act(async () => root.render(<LeaderManagementHost />));
    let dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("leader.rootOnly"); expect(dialog.textContent).not.toContain("leader.archiveGroup"); expect(dialog.textContent).not.toContain("leader.reclaim");
    const manageRoot = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.manageRoot")!;
    await act(async () => manageRoot.click()); dialog = document.body.querySelector('[role="dialog"]')!;
    const archive = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.archiveGroup")!;
    expect(archive.disabled).toBe(true);
    expect([...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!.disabled).toBe(true);
    const complete = { ...snapshot(), branches: [...snapshot().branches.map((b) => ({ ...b, state: "completed" as const })), { ...branch("failed-launch"), sessionId: null, state: "failed" as const }] };
    await act(async () => useLeaderStore.setState({ snapshot: complete })); expect(archive.disabled).toBe(false);
    const remove = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!;
    expect(remove.disabled).toBe(false); // A terminal failed launch retains metadata without a native session ID.
    await act(async () => useChatStore.setState({ bySession: { "claude/root": { ...EMPTY_SESSION, streaming: true } } }));
    expect(archive.disabled).toBe(true); expect(remove.disabled).toBe(true);
    await act(async () => useChatStore.setState({ bySession: {} }));
    await act(async () => remove.click());
    expect(invoke).not.toHaveBeenCalled();
    const confirmation = [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("leader.deleteGroupConfirm"))!;
    expect(confirmation).toBeTruthy();
    vi.mocked(invoke).mockResolvedValueOnce({ leaders: [], branches: [], archivedGroups: [] });
    const confirm = [...confirmation.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.deleteGroup")!;
    await act(async () => confirm.click()); expect(invoke).toHaveBeenCalledWith("task_group_action", { ...parent, action: "delete" });
    expect(useLeaderStore.getState().managing).toBeNull();
  });
  it("preserves pending fallback drafts and composer overrides through normal activation", async () => {
    const dead = branch("pending-fallback-child");
    const before = { leaders: [parent], branches: [dead] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: null, workspacePath: "/foreground", model: "draft-model", effort: "high" };
    const active = { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath };
    const cached = { ...EMPTY_SESSION, activeModel: "draft-model", activeEffort: "high" };
    useChatStore.setState({ active, openTabs: [survivor, active], bySession: { "new:claude:/foreground": cached }, drafts: { "new:claude:/foreground": "draft text" } });
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      expect(useChatStore.getState().active).toBe(survivor);
      expect(useChatStore.getState().activeEngine).toBe("claude");
      expect(useChatStore.getState().bySession["new:claude:/foreground"]).toBe(cached);
      expect(useChatStore.getState().drafts["new:claude:/foreground"]).toBe("draft text");
      expect(activated).toHaveBeenCalledExactlyOnceWith({ engine: "claude", sessionId: null });
      expect(ipc.loadSessionPage).not.toHaveBeenCalled();
    } finally { offActivated(); off(); }
  });

  it("does not reload or announce a surviving active tab when reclaiming a background branch", async () => {
    const dead = branch("background-reclaim-child");
    const before = { leaders: [parent], branches: [dead] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: "active-survivor", workspacePath: "/branches" };
    const cached = { ...EMPTY_SESSION, messages: [{ seq: 1, role: "assistant", text: "cached history", ts: null }] };
    useChatStore.setState({ active: survivor, openTabs: [survivor, { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }], bySession: { "claude/active-survivor": cached } });
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      expect(useChatStore.getState().active).toBe(survivor);
      expect(useChatStore.getState().bySession["claude/active-survivor"]).toBe(cached);
      expect(activated).not.toHaveBeenCalled();
      expect(ipc.loadSessionPage).not.toHaveBeenCalled();
    } finally { offActivated(); off(); }
  });

  it("activates a cold surviving tab once after reclaiming every generation", async () => {
    const dead = branch("cold-child"), grandchild = branch("cold-grandchild", "claude", dead.sessionId!, dead.engine);
    const before = { leaders: [parent], branches: [dead, grandchild] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: "cold-survivor", workspacePath: "/branches", model: "saved-model" };
    const active = { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath };
    useChatStore.setState({ active, openTabs: [survivor, active, { engine: grandchild.engine, sessionId: grandchild.sessionId, workspacePath: grandchild.workspacePath }], drafts: { "claude/cold-survivor": "unsent draft" } });
    let resolve!: (page: SessionPage) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      expect(ipc.loadSessionPage).toHaveBeenCalledExactlyOnceWith("claude", "cold-survivor", 100);
      expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(useChatStore.getState().activeEngine).toBe("claude");
      expect(useChatStore.getState().openTabs).toHaveLength(1);
      expect(useChatStore.getState().bySession["claude/cold-survivor"].loading).toBe(true);
      expect(useChatStore.getState().drafts["claude/cold-survivor"]).toBe("unsent draft");
      expect(activated).toHaveBeenCalledExactlyOnceWith({ engine: "claude", sessionId: "cold-survivor" });
      const messages: SessionPage["messages"] = [{ seq: 1, role: "assistant", text: "restored 中文 🚀", ts: null }];
      resolve({ messages, subagentHistory: [], nextBefore: null });
      await vi.waitFor(() => expect(useChatStore.getState().bySession["claude/cold-survivor"].messages).toBe(messages));
      expect(useChatStore.getState().bySession["claude/cold-survivor"].loading).toBe(false);
    } finally { offActivated(); off(); }
  });

  it("does not resurrect a reclaimed fallback when its slow history resolves", async () => {
    const first = branch("slow-first"), fallback = branch("slow-fallback", "claude");
    const before = { leaders: [parent], branches: [first, fallback] };
    useLeaderStore.setState({ snapshot: before });
    const toTab = (b: LeaderBranch) => ({ engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath });
    useChatStore.setState({ active: toTab(first), openTabs: [toTab(first), toTab(fallback)] });
    let resolve!: (page: SessionPage) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    const activated = vi.fn(); const offActivated = pluginBus.on(SESSION_ACTIVATED_TOPIC, activated);
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [fallback] } });
      expect(ipc.loadSessionPage).toHaveBeenCalledExactlyOnceWith("claude", "slow-fallback", 100);
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      expect(useChatStore.getState().active).toBeNull();
      expect(activated).toHaveBeenLastCalledWith({ engine: null, sessionId: null });
      resolve({ messages: [{ seq: 1, role: "assistant", text: "late history", ts: null }], subagentHistory: [], nextBefore: null });
      await new Promise(done => setTimeout(done, 0));
      expect(useChatStore.getState().bySession["claude/slow-fallback"]).toBeUndefined();
      expect(useChatStore.getState().openTabs).toEqual([]);
      expect(useChatStore.getState().active).toBeNull();
    } finally { offActivated(); off(); }
  });

  it("keeps a later user selection while a fallback history read finishes", async () => {
    const dead = branch("switch-race-child");
    const before = { leaders: [parent], branches: [dead] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: "switch-race-survivor", workspacePath: "/branches" };
    useChatStore.setState({ active: { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }, openTabs: [survivor, { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }] });
    let resolve!: (page: SessionPage) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      useChatStore.getState().focusTab("codex", null, "/new-selection");
      const selected = useChatStore.getState().active;
      const messages: SessionPage["messages"] = [{ seq: 1, role: "assistant", text: "slow history", ts: null }];
      resolve({ messages, subagentHistory: [], nextBefore: null });
      await vi.waitFor(() => expect(useChatStore.getState().bySession["claude/switch-race-survivor"].messages).toBe(messages));
      expect(useChatStore.getState().active).toBe(selected);
      expect(useChatStore.getState().activeEngine).toBe("codex");
    } finally { off(); }
  });

  it("reuses warm history and preserved model metadata for an explicitly reclaimed branch", async () => {
    const dead = branch("warm-reclaim-child");
    const before = { leaders: [parent], branches: [dead] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: "warm-survivor", workspacePath: "/branches", model: "tab-model" };
    const usage = { input_tokens: 100, output_tokens: 20 };
    const cached = { ...EMPTY_SESSION, activeModel: "session-model", activeEffort: "high", usage, messages: [{ seq: 1, role: "assistant", text: "warm history", ts: null, usage }] };
    useChatStore.setState({ active: { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }, openTabs: [survivor, { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }], bySession: { "claude/warm-survivor": cached } });
    vi.mocked(invoke).mockResolvedValue(before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [{ ...dead, state: "reclaimed" }] } });
      expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(useChatStore.getState().bySession["claude/warm-survivor"]).toBe(cached);
      expect(ipc.loadSessionPage).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it("keeps a failed fallback history load visible and allows normal retry", async () => {
    const dead = branch("failed-fallback-child");
    const before = { leaders: [parent], branches: [dead] };
    useLeaderStore.setState({ snapshot: before });
    const survivor = { engine: "claude", sessionId: "failed-survivor", workspacePath: "/branches" };
    useChatStore.setState({ active: { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }, openTabs: [survivor, { engine: dead.engine, sessionId: dead.sessionId, workspacePath: dead.workspacePath }] });
    vi.mocked(ipc.loadSessionPage).mockRejectedValueOnce(new Error("history unavailable"));
    vi.mocked(invoke).mockImplementation(async command => command === "host_chat_is_running" ? false : before);
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    try {
      useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      await vi.waitFor(() => expect(useChatStore.getState().bySession["claude/failed-survivor"].error).toContain("history unavailable"));
      expect(useChatStore.getState().active).toMatchObject(survivor);
      expect(useChatStore.getState().bySession["claude/failed-survivor"].loading).toBe(false);
      await useChatStore.getState().selectSession(survivor.engine, survivor.sessionId, survivor.workspacePath);
      expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2);
      expect(useChatStore.getState().bySession["claude/failed-survivor"].error).toBeNull();
    } finally { off(); }
  });

  it("real parent management lists direct children only and renews with that parent", async () => {
    useLeaderStore.setState({ managing: parent });
    await act(async () => root.render(<LeaderManagementHost />));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("task-child");
    expect(dialog.textContent).not.toContain("task-grandchild");
    vi.mocked(invoke).mockResolvedValueOnce(branch("child")).mockResolvedValueOnce(snapshot());
    const renew = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("leader.renew"))!;
    await act(async () => renew.click());
    expect(invoke).toHaveBeenCalledWith("task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "/branches", branchId: "child", action: "renew" });
  });
  it("rejects sibling/self branch actions before invoking IPC", async () => {
    await expect(useLeaderStore.getState().act({ engine: "codex", sessionId: "child", workspacePath: "/branches" }, "child", "reclaim")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("sends the chosen direct parent identity and configurable renewal", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(branch("child")).mockResolvedValueOnce(snapshot());
    await useLeaderStore.getState().act(parent, "child", "renew", 2400);
    expect(invoke).toHaveBeenNthCalledWith(1, "task_branch_action", { parentEngine: "claude", parentSessionId: "root", workspacePath: "/branches", branchId: "child", action: "renew", ttlSeconds: 2400 });
  });
  it("keeps branch outcome and error after failed reclaim for retry", async () => {
    const before = useLeaderStore.getState().snapshot;
    vi.mocked(invoke).mockRejectedValueOnce(new Error("transcript deletion failed"));
    await expect(useLeaderStore.getState().act(parent, "child", "reclaim")).rejects.toThrow("transcript deletion failed");
    expect(useLeaderStore.getState().snapshot).toBe(before);
    expect(useLeaderStore.getState().error).toContain("transcript deletion failed");
    expect(useLeaderStore.getState().busy).toBe(false);
  });
  it("retires a successful reclaimed subtree even when its follow-up snapshot fails", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ...branch("child"), state: "reclaimed" }).mockRejectedValueOnce(new Error("snapshot unavailable"));
    await useLeaderStore.getState().act(parent, "child", "reclaim");
    expect(useLeaderStore.getState().snapshot.branches.some(b => b.id === "grandchild")).toBe(false);
    expect(useLeaderStore.getState().error).toContain("snapshot unavailable");
  });
  it("cleans reclaimed cache/tabs and discards already buffered output plus generic late events", async () => {
    const dead = branch("retired");
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [dead] } });
    const tab = { engine: "codex", sessionId: "retired", workspacePath: "/branches" };
    useChatStore.setState({ active: tab, openTabs: [tab], bySession: { "codex/retired": { ...EMPTY_SESSION } } });
    vi.mocked(invoke).mockResolvedValue({ leaders: [parent], branches: [dead] });
    const off = startLeaderRuntime(); await Promise.resolve(); await Promise.resolve();
    handleEngineEvents([{ engine: "codex", sessionId: "retired", runId: "retired-run", seq: 1, kind: "delta", data: "buffer", leader: { branchId: "retired", workspacePath: "/branches", title: "retired" } }], deps());
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
    handleEngineEvents([{ engine: "codex", sessionId: "retired", runId: "retired-run", seq: 2, kind: "delta", data: "late" }], deps());
    expect(useChatStore.getState().openTabs).toEqual([]); expect(useChatStore.getState().bySession["codex/retired"]).toBeUndefined();
    expect(runRouting.has("retired-run")).toBe(false); off();
  });
  it("removes a listener resolving after StrictMode cleanup", async () => {
    let resolve!: (off: () => void) => void;
    const lateOff = vi.fn();
    vi.mocked(listen).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const off = startLeaderRuntime(); off(); resolve(lateOff); await Promise.resolve();
    expect(lateOff).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
  });

  it("restores a held follow-up to both participants without sending and clears approval after cancellation", async () => {
    const now = Date.now();
    const held: LeaderBranch = {
      ...branch("held"),
      state: "awaiting_cost_approval",
      runId: null,
      model: "task-model",
      task: "继续核查缓存 👩🏽‍💻\n保留子任务设置",
      costApproval: {
        requestId: "followup-1",
        capturedAt: now,
        model: "task-model",
        cache: { startedAt: now - 600_000, observedAt: now - 590_000, ttlSeconds: 300, source: "anthropic-usage" },
      },
    };
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
    vi.mocked(invoke).mockResolvedValue({ leaders: [parent], branches: [held] });
    const off = startLeaderRuntime();
    try {
      await vi.waitFor(() => {
        expect(useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:held")?.status)
          .toBe("awaiting_cost_approval");
      });
      const record = useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:held")!;
      expect(record).toMatchObject({
        kind: "subtask",
        requestId: "followup-1",
        message: held.task,
        acceptedAt: now,
        leaderCostApproval: { branchId: "held", requestId: "followup-1", model: "task-model" },
        costReview: { model: "task-model", cacheHeat: "cold", context: { kind: "unknown" } },
      });
      for (const active of [parent, { engine: held.engine, sessionId: held.sessionId!, workspacePath: held.workspacePath }]) {
        await act(async () => root.render(<CrossSessionQueue active={active} />));
        expect(node.querySelectorAll('[data-testid="cross-session-cost-approval"]')).toHaveLength(1);
        expect(node.textContent).toContain(held.task);
        expect(node.textContent).toContain("crossSession.taskCostApprovalPending");
      }
      expect(invoke).toHaveBeenCalledExactlyOnceWith("task_snapshot", {});
      expect(ipc.loadSessionPage).not.toHaveBeenCalled();

      useCrossSessionActivityStore.getState().clearFinished();
      expect(useCrossSessionActivityStore.getState().records).toHaveLength(1);
      await act(async () => {
        useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [{
          ...held, state: "stopped", costApproval: undefined, updatedAt: now + 1000,
        }] } });
      });
      const cancelled = useCrossSessionActivityStore.getState().records[0];
      expect(cancelled.status).toBe("failed");
      expect(cancelled.leaderCostApproval).toBeUndefined();
      expect(cancelled.costReview).toBeUndefined();
      expect(node.querySelector('[data-testid="cross-session-cost-approval"]')).toBeNull();
    } finally {
      off();
    }
  });

  it("syncs subtask communication UI across live streaming, completion, and archival/reclaim cleanup", async () => {
    const initialCompleted = { ...branch("old-done"), state: "completed" as const, result: "old result" };
    useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
    vi.mocked(invoke).mockResolvedValue({ leaders: [parent], branches: [initialCompleted] });
    const off = startLeaderRuntime();
    try {
      // First hydration marks pre-existing terminal branches as reviewed so they do not clutter the sidebar.
      await vi.waitFor(() => {
        expect(useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:old-done")).toBeDefined();
      });
      const oldRecord = useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:old-done")!;
      expect(isCrossSessionRecordUnread(oldRecord)).toBe(false);

      // A newly spawned branch transitions to running, streams deltas, and completes unread.
      const liveChild = { ...branch("live-child", "agy"), state: "running" as const, task: "Refactor architecture", result: "" };
      await act(async () => {
        useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [initialCompleted, liveChild] } });
      });
      expect(useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:live-child")).toMatchObject({
        kind: "subtask",
        status: "executing",
        message: "Refactor architecture",
      });

      const threads = groupLeaderThreads(
        [{ id: "claude/root", label: "Root", engine: "claude", time: "1m" }, { id: "agy/live-child", label: "Child", engine: "agy", time: "1m" }],
        useLeaderStore.getState().snapshot,
        "/branches",
      );
      await act(async () => root.render(<AiChatSidebar repos={[{ id: "ws", label: "workspace", defaultOpen: true, threads }]} activeThreadId="agy/live-child" />));
      expect(node.querySelectorAll('[data-testid="thread-cross-session-btn"]')).toHaveLength(2);

      // Stream live delta from engine event before snapshot settles
      act(() => {
        handleEngineEvents([
          { engine: "agy", sessionId: "live-child", runId: "run-live-child", seq: 1, kind: "delta", data: "Streaming reply chunk...", leader: { branchId: "live-child", workspacePath: "/branches", title: "task-live-child" } },
        ], deps());
      });
      expect(useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:live-child")?.replyText).toBe("Streaming reply chunk...");

      // Transition to completed -> unread for both parent and child
      await act(async () => {
        useLeaderStore.setState({
          snapshot: {
            leaders: [parent],
            branches: [initialCompleted, { ...liveChild, state: "completed", result: "Final subtask report" }],
          },
        });
      });
      const finishedRecord = useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "leader:live-child")!;
      expect(finishedRecord.status).toBe("completed");
      expect(finishedRecord.replyText).toBe("Final subtask report");
      expect(isCrossSessionRecordUnread(finishedRecord)).toBe(true);

      // Reclaiming or archiving removes the communication records
      await act(async () => {
        useLeaderStore.setState({ snapshot: { leaders: [parent], branches: [] } });
      });
      expect(useCrossSessionActivityStore.getState().records).toHaveLength(0);
    } finally {
      off();
    }
  });
});
