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
      expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        childContext: children.context, transcriptExcerpt: expect.not.stringContaining("child-only evidence"),
      }));
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
    expect(draft()).toContain("model merged summary");
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
    expect(draft(destination, "claude")).toContain("model merged summary");
    expect(draft(workspacePath)).not.toContain("child-only evidence");
    expect(useChatStore.getState().drafts[otherKey]).toBe("unrelated draft");
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      engine: "codex", sessionId: args.sourceSessionId, childContext: entry(destination).children!.context,
    }));
  });
});
