import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type Workspace } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import type { LeaderBranch, LeaderSnapshot } from "@/features/leader/types";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { replaceHandoffDraftSummary, useHandoffStore } from "./session-cleanup";
import { HANDOFF_PREFERENCES_KEY } from "./handoff-preferences";
import { HandoffOverlayCard } from "./components/HandoffOverlayCard";

// These controls fetch catalogs unrelated to child snapshot/lifecycle behavior.
vi.mock("./components/HandoffCompressionControls", () => ({ HandoffCompressionControls: () => null }));
vi.mock("./components/HandoffWorkspaceControl", () => ({ HandoffWorkspaceControl: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original = useChatStore.getState();
const workspacePath = "/handoff-children";
const destination = "/handoff-target";
const key = (path = workspacePath, engine = "codex") => sessionKey(engine, null, path);
const state = { ...EMPTY_SESSION, messages: [
  { seq: 1, ts: "1", role: "user" as const, text: "parent request" },
  { seq: 2, ts: "2", role: "assistant" as const, text: "parent conclusion" },
] };
const args = { workspacePath, sourceEngine: "codex", sourceSessionId: "source-session",
  sourceTitle: "Source", sourceState: state, nextTask: "user next task", initialMode: "local" as const };
const child: LeaderBranch = {
  id: "child-branch", parentEngine: "codex", parentSessionId: args.sourceSessionId, workspacePath,
  engine: "claude", sessionId: "child-session", title: "Child report", task: "Verify fix",
  model: null, effort: null, runId: null, state: "completed", createdAt: 1, updatedAt: 2,
  lastActivityAt: 2, deadlineAt: 0, expired: false, result: "child-only evidence " + "中文结果😀".repeat(200),
  resultTruncated: false, error: null,
};
const snapshot: LeaderSnapshot = { leaders: [], branches: [child] };
const emptySnapshot: LeaderSnapshot = { leaders: [], branches: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const draft = (path = workspacePath, engine = "codex") => useChatStore.getState().drafts[key(path, engine)] ?? "";
const entry = (path = workspacePath) => useHandoffStore.getState().byWorkspace[path];
async function flush() { await Promise.resolve(); await Promise.resolve(); }
let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function mountCard() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<HandoffOverlayCard active={useChatStore.getState().active} />));
}
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState({ ...original, activeEngine: "codex", active: null, openTabs: [], drafts: {},
    sessions: [], bySession: {}, streamingByKey: {}, retryingByKey: {},
    workspaces: [{ path: destination } as Workspace] });
  vi.spyOn(ipc, "taskSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(ipc, "handoffFullHistorySupported").mockResolvedValue(true);
  vi.spyOn(ipc, "summarizeSessionHandoff").mockResolvedValue("model merged summary");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState(original);
  vi.restoreAllMocks();
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
});

describe("handoff child snapshot lifecycle", () => {
  it.each(["local", "grok"] as const)("includes reports absent from parent history in %s mode with a protected splice boundary", async (mode) => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: mode });
    expect(entry().childrenStatus).toBe("loading");
    expect(draft()).toContain("parent conclusion");
    expect(draft()).not.toContain("child-only evidence");
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
    pending.resolve(snapshot);
    await flush();
    const children = entry().children!;
    expect(entry()).toMatchObject({ childrenStatus: "ready", childrenApplied: true });
    expect(draft()).toContain(children.block);
    expect(draft()).toContain("child-only evidence");
    expect(draft()).toContain("接下来请继续：user next task");
    expect(ipc.taskSnapshot).toHaveBeenCalledTimes(1);
    if (mode === "grok") {
      await vi.waitFor(() => expect(entry().grokStatus).toBe("done"));
      expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        childContext: children.context, historyScope: "full",
      }));
      expect(vi.mocked(ipc.summarizeSessionHandoff).mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
      expect(children.context.length).toBeGreaterThan(children.block.length);
      expect(draft()).toContain("model merged summary");
      expect(draft()).not.toContain("> parent conclusion");
    } else expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
    const replaced = replaceHandoffDraftSummary(draft(), "another main summary")!;
    expect(replaced).toContain(children.block);
    expect(replaced).toContain("接下来请继续：user next task");
  });

  it("waits for children and starts only the final model selection", async () => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    useHandoffStore.getState().setCompressionSelection(workspacePath, { engine: "codex", model: "gpt-5.4", effort: "high" });
    useHandoffStore.getState().setCompressionSelection(workspacePath, { engine: "claude", model: "claude-opus-4-6", effort: "high" });
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
    pending.resolve(snapshot);
    await flush();
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      compressionSelection: { engine: "claude", model: "claude-opus-4-6", effort: "high" },
    }));
  });

  it("does not infer after compression was turned off during the read", async () => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    useHandoffStore.getState().setCompressionMode(workspacePath, "local");
    pending.resolve(snapshot);
    await flush();
    expect(draft()).toContain("child-only evidence");
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
  });

  it("distinguishes read failure from empty children and keeps a usable parent draft", async () => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff(args);
    const before = draft();
    await mountCard();
    expect(container!.textContent).toContain(i18n.t("chat.handoffChildrenLoading"));
    expect(container!.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { pending.reject(new Error("snapshot unavailable")); await flush(); });
    expect(draft()).toBe(before);
    expect(entry()).toMatchObject({ childrenStatus: "error", childrenError: "snapshot unavailable" });
    expect(entry().children).toBeUndefined();
    expect(container!.textContent).toContain(i18n.t("chat.handoffChildrenFailed"));
    expect(container!.querySelector("section")?.getAttribute("aria-busy")).toBe("false");
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
  });

  it("can compress the parent after read failure without inventing child context", async () => {
    vi.mocked(ipc.taskSnapshot).mockRejectedValue(new Error("snapshot failed"));
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await flush();
    expect(entry().childrenStatus).toBe("error");
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.summarizeSessionHandoff).mock.calls[0][0]).not.toHaveProperty("childContext");
    await vi.waitFor(() => expect(draft()).toContain("model merged summary"));
  });

  it("keeps the exact old draft for an empty snapshot", async () => {
    vi.mocked(ipc.taskSnapshot).mockResolvedValue(emptySnapshot);
    useHandoffStore.getState().startHandoff(args);
    const before = draft();
    await flush();
    expect(draft()).toBe(before);
    expect(entry()).toMatchObject({ childrenStatus: "ready", children: { total: 0, block: "", context: "" } });
    expect(entry().childrenError).toBeUndefined();
    await mountCard();
    expect(container!.querySelector("[data-testid='handoff-children-status']")).toBeNull();
  });

  it.each(["sending", "dismissed", "ordinary", "successor"] as const)("does not write a late child read into a %s draft", async (scenario) => {
    const pending = deferred<LeaderSnapshot>();
    const successor = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValueOnce(pending.promise).mockReturnValueOnce(successor.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    if (scenario === "sending") useHandoffStore.getState().setSending(workspacePath, entry().id, true);
    if (scenario === "dismissed") useHandoffStore.getState().dismissHandoff(workspacePath);
    if (scenario === "ordinary") useChatStore.getState().setDraft(key(), "ordinary user draft");
    if (scenario === "successor") useHandoffStore.getState().startHandoff({ ...args, sourceTitle: "Successor" });
    const before = draft();
    pending.resolve(snapshot);
    await flush();
    expect(draft()).toBe(before);
    expect(draft()).not.toContain("child-only evidence");
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
    if (scenario === "successor") {
      expect(entry().childrenStatus).toBe("loading");
      successor.resolve(emptySnapshot);
      await flush();
      expect(entry().children?.total).toBe(0);
    }
  });

  it("applies the deferred child block once after a failed send unlocks the draft", async () => {
    const pending = deferred<LeaderSnapshot>();
    const summary = deferred<string>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    vi.mocked(ipc.summarizeSessionHandoff).mockReturnValue(summary.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    const handoffId = entry().id;
    useChatStore.getState().setDraft(key(), `${draft()}\nuser appended before send lock`);
    const before = draft();
    useHandoffStore.getState().setSending(workspacePath, handoffId, true);
    pending.resolve(snapshot);
    await flush();
    expect(draft()).toBe(before);
    expect(entry().childrenApplied).toBe(false);
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();

    useHandoffStore.getState().setSending(workspacePath, handoffId, false);
    await flush();
    const children = entry().children!;
    expect(entry().childrenApplied).toBe(true);
    expect(draft()).toContain(children.block);
    expect(draft()).toContain("user appended before send lock");
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ childContext: children.context }));
    useHandoffStore.getState().setSending(workspacePath, handoffId, false);
    await flush();
    expect(draft().split(children.heading)).toHaveLength(2);
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(1);
    expect(ipc.taskSnapshot).toHaveBeenCalledTimes(1);
    summary.resolve("summary after failed send");
    await flush();
    expect(draft()).toContain("summary after failed send");
    expect(draft()).toContain(children.block);
    expect(draft()).toContain("user appended before send lock");
  });

  it("does not reconstruct a handoff replaced by an ordinary draft while send is locked", async () => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    const handoffId = entry().id;
    useHandoffStore.getState().setSending(workspacePath, handoffId, true);
    useChatStore.getState().setDraft(key(), "ordinary draft written while locked");
    pending.resolve(snapshot);
    await flush();
    useHandoffStore.getState().setSending(workspacePath, handoffId, false);
    await flush();
    expect(draft()).toBe("ordinary draft written while locked");
    expect(ipc.summarizeSessionHandoff).not.toHaveBeenCalled();
    expect(entry().childrenApplied).toBe(false);
  });

  it.each(["edit", "delete"] as const)("rejects late model replies after a child block %s and retries only visible content", async (change) => {
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(ipc.summarizeSessionHandoff).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await flush();
    const children = entry().children!;
    const visible = change === "edit" ? `${children.heading}\n\n> user corrected child report` : "";
    const edited = draft().replace(children.block, visible);
    useChatStore.getState().setDraft(key(), edited);
    await mountCard();
    await act(async () => { first.resolve("stale model result with old child evidence"); await flush(); });
    expect(draft()).toBe(edited);
    expect(entry()).toMatchObject({ grokStatus: "stale", grokSummary: null });
    expect(container!.textContent).toContain(i18n.t("chat.handoffGrokStale"));
    await act(async () => useHandoffStore.getState().retryGrok(workspacePath));
    const request = vi.mocked(ipc.summarizeSessionHandoff).mock.calls[1][0];
    if (change === "edit") expect(request.childContext).toBe(visible);
    else expect(request).not.toHaveProperty("childContext");
    await act(async () => { second.resolve("fresh visible-only summary"); await flush(); });
    expect(draft()).toContain("fresh visible-only summary");
    expect(draft()).not.toContain("child-only evidence");
    expect(draft()).not.toContain("stale model result");
    if (change === "edit") expect(draft()).toContain(visible);
    else expect(draft()).not.toContain(children.heading);
  });

  it("preserves the independently quoted child block across local/detailed/model switches", async () => {
    useHandoffStore.getState().startHandoff(args);
    await flush();
    const children = entry().children!;
    await mountCard();
    expect(container!.textContent).toContain(i18n.t("chat.handoffChildrenLoaded", { count: 1, attention: 0 }));
    for (const mode of ["detailed", "local", "grok", "local", "grok"] as const) {
      await act(async () => { useHandoffStore.getState().setCompressionMode(workspacePath, mode); await flush(); });
      expect(draft()).toContain(children.block);
      expect(draft().split(children.heading)).toHaveLength(2);
      expect(draft()).toContain("接下来请继续：user next task");
    }
    expect(ipc.taskSnapshot).toHaveBeenCalledTimes(1);
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(1);
  });

  it("follows workspace and engine migration while reading children from the source identity", async () => {
    const pending = deferred<LeaderSnapshot>();
    vi.mocked(ipc.taskSnapshot).mockReturnValue(pending.promise);
    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    expect(useHandoffStore.getState().moveHandoffToWorkspace(workspacePath, destination)).toBe(true);
    useChatStore.getState().setActiveEngine("claude");
    const otherKey = key("/unrelated", "codex");
    useChatStore.getState().setDraft(otherKey, "unrelated draft");
    pending.resolve(snapshot);
    await flush();
    expect(entry()).toBeUndefined();
    expect(entry(destination)).toMatchObject({ workspacePath, children: { total: 1 } });
    expect(draft(destination, "claude")).toContain("child-only evidence");
    await vi.waitFor(() => expect(draft(destination, "claude")).toContain("model merged summary"));
    expect(draft(workspacePath)).not.toContain("child-only evidence");
    expect(useChatStore.getState().drafts[otherKey]).toBe("unrelated draft");
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      engine: "codex", sessionId: args.sourceSessionId, childContext: entry(destination).children!.context,
    }));
  });

  it("lets users filter, toggle, clear, and select all child chats with live draft splicing", async () => {
    const multiBranches: LeaderBranch[] = [
      { ...snapshot.branches[0], id: "c-done-1", sessionId: "sid-done-1", title: "Auth module audit", state: "completed", result: "auth report ok", updatedAt: 50 },
      { ...snapshot.branches[0], id: "c-done-2", sessionId: "sid-done-2", title: "Billing schema check", state: "completed", result: "billing report ok", updatedAt: 40 },
      { ...snapshot.branches[0], id: "c-fail-1", sessionId: "sid-fail-1", title: "Payment webhook retry", state: "failed", error: "timeout", result: "webhook partial", updatedAt: 30 },
      { ...snapshot.branches[0], id: "c-wait-1", sessionId: "sid-wait-1", title: "Cache warmup worker", state: "waiting", result: "waiting input", updatedAt: 20 },
      { ...snapshot.branches[0], id: "c-done-3", sessionId: "sid-done-3", title: "Search index migration", state: "completed", result: "search report ok", updatedAt: 10 },
    ];
    vi.mocked(ipc.taskSnapshot).mockResolvedValue({ leaders: [], branches: multiBranches });
    useChatStore.setState({
      sessions: [
        { engine: "claude", sessionId: "sid-fail-1", workspacePath, title: '[Message from CC GUI {"engine":"claude","session_id":"trunc' } as never,
      ],
    });

    useHandoffStore.getState().startHandoff({ ...args, initialMode: "local" });
    await flush();
    await mountCard();

    expect(entry().selectedChildIds).toHaveLength(5);
    expect(draft()).toContain("auth report ok");
    expect(draft()).toContain("webhook partial");

    // Expand picker
    const toggleBtn = container!.querySelector('[data-testid="handoff-children-toggle"]') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    await act(async () => { toggleBtn.click(); });
    expect(container!.querySelector('[data-testid="handoff-children-picker"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="handoff-child-item-c-fail-1"]')!.textContent).toContain("Payment webhook retry");
    expect(container!.querySelector('[data-testid="handoff-child-item-c-fail-1"]')!.textContent).not.toContain("[Message from CC GUI");

    // Filter via search input (rendered when candidates >= 5)
    const searchInput = container!.querySelector('[data-testid="handoff-children-search"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(searchInput, "Billing");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="handoff-child-item-c-done-2"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="handoff-child-item-c-done-1"]')).toBeNull();

    // Select only completed (3 items)
    const completedBtn = container!.querySelector('[data-testid="handoff-children-select-completed"]') as HTMLButtonElement;
    await act(async () => { completedBtn.click(); });
    expect(entry().selectedChildIds).toEqual(["c-done-1", "c-done-2", "c-done-3"]);
    expect(draft()).toContain("auth report ok");
    expect(draft()).not.toContain("webhook partial");
    expect(draft()).toContain("接下来请继续：user next task");

    // Clear all -> removes child block cleanly while keeping summary & user prompt
    const clearBtn = container!.querySelector('[data-testid="handoff-children-clear"]') as HTMLButtonElement;
    await act(async () => { clearBtn.click(); });
    expect(entry().selectedChildIds).toEqual([]);
    expect(draft()).not.toContain(i18n.t("chat.handoffChildrenHeading"));
    expect(draft()).toContain("parent conclusion");
    expect(draft()).toContain("接下来请继续：user next task");

    // Select all -> re-inserts child block before "接下来请继续："
    const allBtn = container!.querySelector('[data-testid="handoff-children-select-all"]') as HTMLButtonElement;
    expect(allBtn.textContent).toBe(i18n.t("chat.handoffChildrenSelectAll", { count: 5 }));
    await act(async () => { allBtn.click(); });
    expect(entry().selectedChildIds).toHaveLength(5);
    expect(draft().indexOf(i18n.t("chat.handoffChildrenHeading"))).toBeLessThan(draft().indexOf("接下来请继续：user next task"));

    // Clicking "取消全选" (same select-all button when all are selected) toggles off all items
    expect(allBtn.disabled).toBe(false);
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(allBtn.textContent).toBe(i18n.t("chat.handoffChildrenDeselectAll", { count: 5 }));
    await act(async () => { allBtn.click(); });
    expect(entry().selectedChildIds).toEqual([]);
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
    expect(allBtn.textContent).toBe(i18n.t("chat.handoffChildrenSelectAll", { count: 5 }));
    expect(draft()).not.toContain(i18n.t("chat.handoffChildrenHeading"));
  });

  it("discovers same-group siblings unselected from a child chat and compresses selected childBranchIds on demand", async () => {
    const groupBranches: LeaderBranch[] = [
      { ...snapshot.branches[0], engine: "codex", id: "b-self", sessionId: "child-self", title: "Current Child", result: "self report" },
      { ...snapshot.branches[0], engine: "codex", id: "b-peer-1", sessionId: "child-peer-1", title: "Sibling API", result: "sibling api findings" },
      { ...snapshot.branches[0], engine: "codex", id: "b-peer-2", sessionId: "child-peer-2", title: "Sibling UI", result: "sibling ui findings" },
    ];
    vi.mocked(ipc.taskSnapshot).mockResolvedValue({ leaders: [], branches: groupBranches });
    const cancelSpy = vi.spyOn(ipc, "cancelSessionHandoff").mockResolvedValue(true);
    const first = deferred<string>();
    const second = deferred<string>();
    vi.mocked(ipc.summarizeSessionHandoff)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    useHandoffStore.getState().startHandoff({
      ...args,
      sourceSessionId: "child-self",
      sourceMeta: { engine: "codex", sessionId: "child-self", workspacePath } as Parameters<typeof ipc.archiveSession>[0],
      initialMode: "grok",
    });
    await flush();
    await mountCard();

    // Initially 0 siblings selected, first model compression runs without childBranchIds
    expect(entry().selectedChildIds).toEqual([]);
    expect(draft()).not.toContain("sibling api findings");
    const firstReq = vi.mocked(ipc.summarizeSessionHandoff).mock.calls[0][0];
    expect(firstReq).not.toHaveProperty("childBranchIds");
    expect(firstReq.requestId).toEqual(expect.any(String));

    // While first model compression is still running, user selects b-peer-1
    await act(async () => {
      (container!.querySelector('[data-testid="handoff-children-toggle"]') as HTMLButtonElement).click();
    });
    expect(container!.textContent).toContain(i18n.t("chat.handoffChildrenSiblingBadge"));
    const peerCheckbox = container!.querySelector('[data-testid="handoff-child-item-b-peer-1"] input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { peerCheckbox.click(); });

    // Selection change immediately cancels obsolete flight and keeps "压缩所选" enabled!
    expect(cancelSpy).toHaveBeenCalledWith(firstReq.requestId);
    expect(entry().selectedChildIds).toEqual(["b-peer-1"]);
    expect(draft()).toContain("sibling api findings");
    expect(container!.textContent).toContain(i18n.t("chat.handoffChildrenSelectionStale"));
    const compressBtn = container!.querySelector('[data-testid="handoff-children-compress-btn"]') as HTMLButtonElement;
    expect(compressBtn.disabled).toBe(false);

    // User clicks "压缩所选" right away (even before cancelled first flight finishes IPC teardown)
    await act(async () => { compressBtn.click(); });
    expect(entry().grokStatus).toBe("running");

    // Once cancelled first flight rejects/settles, queued second compression starts automatically
    await act(async () => {
      first.reject(new Error("handoff compression cancelled"));
      await first.promise.catch(() => {});
      await flush();
    });
    await vi.waitFor(() => expect(vi.mocked(ipc.summarizeSessionHandoff)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ipc.summarizeSessionHandoff).mock.calls[1][0]).toMatchObject({
      engine: "codex",
      sessionId: "child-self",
      historyScope: "full",
      sourceWorkspacePath: workspacePath,
      childBranchIds: ["b-peer-1"],
    });

    await act(async () => { second.resolve("merged summary with sibling api"); await flush(); });
    expect(entry().grokStatus).toBe("done");
    expect(entry().childrenSelectionModified).toBe(false);
    expect(draft()).toContain("merged summary with sibling api");
    expect(draft()).toContain("sibling api findings");
  });

  it("allows stopping an active compression without closing handoff, then unchecking children and re-distilling", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const cancelSpy = vi.spyOn(ipc, "cancelSessionHandoff").mockImplementation(async () => {
      first.reject(new Error("handoff compression cancelled"));
      return true;
    });
    vi.mocked(ipc.summarizeSessionHandoff)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await flush();
    await mountCard();

    await vi.waitFor(() => expect(vi.mocked(ipc.summarizeSessionHandoff)).toHaveBeenCalledTimes(1));
    const stopBtn = container!.querySelector('[data-testid="handoff-grok-stop-btn"]') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();

    // Clicking "停止" cancels the native flight, keeps handoff panel & draft open
    await act(async () => {
      stopBtn.click();
      await first.promise.catch(() => {});
      await flush();
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(entry()).toBeDefined();
    expect(entry().grokStatus).toBe("idle");
    expect(entry().compressionRunning).toBe(false);
    expect(container!.querySelector('[data-testid="handoff-overlay-card"]')).toBeTruthy();
    expect(container!.textContent).toContain(i18n.t("chat.handoffGrokStopped"));
    expect(draft()).toContain("parent conclusion");

    // Uncheck all children and click re-distill -> compresses main chat only (no childContext / childBranchIds)
    await act(async () => {
      (container!.querySelector('[data-testid="handoff-children-toggle"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container!.querySelector('[data-testid="handoff-children-select-all"]') as HTMLButtonElement).click();
    });
    expect(entry().selectedChildIds).toEqual([]);
    const recompressBtn = container!.querySelector('[data-testid="handoff-children-compress-btn"]') as HTMLButtonElement;
    expect(recompressBtn.textContent).toBe(i18n.t("chat.handoffGrokRetry"));
    await act(async () => { recompressBtn.click(); await flush(); });

    await vi.waitFor(() => expect(vi.mocked(ipc.summarizeSessionHandoff)).toHaveBeenCalledTimes(2));
    const secondReq = vi.mocked(ipc.summarizeSessionHandoff).mock.calls[1][0];
    expect(secondReq).not.toHaveProperty("childBranchIds");
    expect(secondReq).not.toHaveProperty("childContext");

    await act(async () => { second.resolve("parent-only compressed summary"); await flush(); });
    expect(entry().grokStatus).toBe("done");
    expect(draft()).toContain("parent-only compressed summary");
    expect(draft()).not.toContain("child-only evidence");
  });

  it("displays live compression progress stages, enforces monotonic order, and allows lowering high effort mid-run", async () => {
    localStorage.setItem(
      HANDOFF_PREFERENCES_KEY,
      JSON.stringify({
        enabled: true,
        model: "gpt-6.1-terra",
        selection: { engine: "codex", model: "gpt-6.1-terra", effort: "xhigh" },
      }),
    );
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    let latestOnProgress: Parameters<typeof ipc.summarizeSessionHandoff>[0]["onProgress"];
    vi.spyOn(ipc, "taskSnapshot").mockResolvedValue(emptySnapshot);
    vi.spyOn(ipc, "cancelSessionHandoff").mockResolvedValue(true);
    vi.spyOn(ipc, "summarizeSessionHandoff").mockImplementation((req) => {
      calls += 1;
      latestOnProgress = req.onProgress;
      return calls === 1 ? first.promise : second.promise;
    });

    useHandoffStore.getState().startHandoff({ ...args, initialMode: "grok" });
    await flush();
    await mountCard();

    await vi.waitFor(() => expect(calls).toBe(1));
    const hint = container!.querySelector('[data-testid="handoff-high-effort-hint"]');
    expect(hint?.textContent).toContain(i18n.t("chat.effortXhigh"));
    const lowerBtn = container!.querySelector('[data-testid="handoff-lower-effort-btn"]') as HTMLButtonElement;
    expect(lowerBtn.textContent).toBe(i18n.t("chat.handoffUseMediumEffort"));

    await act(async () => {
      latestOnProgress?.({ phase: "reading" });
      await flush();
    });
    expect(container!.querySelector('[data-testid="handoff-grok-status"]')?.textContent).toContain(
      i18n.t("chat.handoffProgressReading"),
    );

    const segTiming = {
      elapsedMs: 1200,
      readingMs: 200,
      segmentsMs: 1000,
      mergingMs: 0,
      verifyingMs: 0,
      modelCalls: 4,
      completedModelCalls: 2,
      activeModelCalls: 2,
      modelElapsedMs: 1800,
      lastModelCallMs: 900,
      longestModelCallMs: 900,
    };
    await act(async () => {
      latestOnProgress?.({ phase: "segments", completed: 2, total: 5, timing: segTiming });
      await flush();
    });
    expect(container!.querySelector('[data-testid="handoff-grok-status"]')?.textContent).toContain(
      i18n.t("chat.handoffProgressSegments", { completed: 2, total: 5 }),
    );
    expect(
      container!.querySelector('[data-testid="handoff-grok-status"] span[title]')?.getAttribute("title"),
    ).toBe(i18n.t("chat.handoffProgressCallsTooltip", { completed: 2, started: 4, active: 2 }));

    // Out-of-order regression must be ignored.
    await act(async () => {
      latestOnProgress?.({ phase: "segments", completed: 1, total: 5, timing: segTiming });
      await flush();
    });
    expect(entry().grokProgress?.completed).toBe(2);

    const mergeTiming = {
      ...segTiming,
      elapsedMs: 2200,
      segmentsMs: 1500,
      mergingMs: 500,
      modelCalls: 6,
      completedModelCalls: 5,
      activeModelCalls: 1,
      modelElapsedMs: 3000,
      lastModelCallMs: 500,
    };
    await act(async () => {
      latestOnProgress?.({ phase: "merging", round: 1, completed: 1, total: 2, timing: mergeTiming });
      await flush();
    });
    expect(container!.querySelector('[data-testid="handoff-grok-status"]')?.textContent).toContain(
      i18n.t("chat.handoffProgressMerging", { round: 1, completed: 1, total: 2 }),
    );

    await act(async () => {
      latestOnProgress?.({
        phase: "verifying",
        timing: { ...mergeTiming, elapsedMs: 2500, mergingMs: 800, verifyingMs: 100, completedModelCalls: 6, activeModelCalls: 0 },
      });
      await flush();
    });
    expect(container!.querySelector('[data-testid="handoff-grok-status"]')?.textContent).toContain(
      i18n.t("chat.handoffProgressVerifying"),
    );

    // Clicking lower effort cancels xhigh run, updates effort to medium, and re-distills when the flight ends.
    await act(async () => {
      lowerBtn.click();
      await flush();
    });
    expect(ipc.cancelSessionHandoff).toHaveBeenCalledTimes(1);
    expect(entry().compressionSelection?.effort).toBe("medium");
    expect(container!.querySelector('[data-testid="handoff-high-effort-hint"]')).toBeNull();

    await act(async () => {
      first.resolve("stale xhigh summary");
      await flush();
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(vi.mocked(ipc.summarizeSessionHandoff).mock.calls[1][0]).toEqual(
      expect.objectContaining({
        compressionSelection: expect.objectContaining({
          engine: "codex",
          model: "gpt-6.1-terra",
          effort: "medium",
        }),
      }),
    );

    await act(async () => {
      second.resolve("medium effort summary");
      await flush();
    });
    expect(entry().grokStatus).toBe("done");
    expect(draft()).toContain("medium effort summary");
  });

  it("skips trailing CLI rate-limit banners in local and detailed summaries when real replies exist", async () => {
    vi.spyOn(ipc, "taskSnapshot").mockResolvedValue(emptySnapshot);
    const rateLimitedState = {
      ...EMPTY_SESSION,
      messages: [
        { seq: 1, ts: "1", role: "user" as const, text: "fix slow handoff" },
        { seq: 2, ts: "2", role: "assistant" as const, text: "Increased CHUNK_CHARS to 64k and enabled 4x Codex concurrency." },
        { seq: 3, ts: "3", role: "assistant" as const, text: "> You've hit your 5-hour limit · resets 7:20am (Asia/Singapore)" },
      ],
    };
    useHandoffStore.getState().startHandoff({ ...args, sourceState: rateLimitedState, initialMode: "local" });
    await flush();
    expect(draft()).toContain("Increased CHUNK_CHARS to 64k");
    expect(draft()).not.toContain("You've hit your 5-hour limit");

    useHandoffStore.getState().setCompressionMode(workspacePath, "detailed");
    expect(draft()).toContain("Increased CHUNK_CHARS to 64k");
    expect(draft()).not.toContain("You've hit your 5-hour limit");

    // Falls back to the banner only when no real assistant reply exists in the session.
    const bannerOnlyState = {
      ...EMPTY_SESSION,
      messages: [
        { seq: 1, ts: "1", role: "user" as const, text: "only banner" },
        { seq: 2, ts: "2", role: "assistant" as const, text: "> You've hit your 5-hour limit · resets 7:20am (Asia/Singapore)" },
      ],
    };
    useHandoffStore.getState().startHandoff({
      ...args,
      workspacePath: destination,
      sourceState: bannerOnlyState,
      initialMode: "local",
    });
    await flush();
    expect(draft(destination)).toContain("You've hit your 5-hour limit");
  });
});
