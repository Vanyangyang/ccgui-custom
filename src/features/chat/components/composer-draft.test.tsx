import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversation } from "./ChatConversation";
import { sessionKey, useChatStore } from "../store";
import { EMPTY_SESSION, runRouting } from "../store/stream";
import { getSelectedAgent } from "@/features/agents/selected-agent";
import { ipc, type ResolvedBuiltInAgent, type Workspace } from "@/lib/ipc";
import { COMPUTER_USE_SETTINGS_HASH } from "../computer-use";
import { invoke } from "@/lib/transport";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: vi.fn(), clearSelectedAgent: vi.fn(), migrateSelectedAgent: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/application/ai-chat/cli-menu", () => ({ CliMenu: () => null }));
vi.mock("@/components/application/ai-chat/add-menu", () => ({ AddMenu: () => null }));
vi.mock("@/components/application/ai-chat/permission-menu", () => ({ PermissionMenu: () => null }));
vi.mock("./use-branch-switcher", () => ({ useBranchSwitcher: () => ({}) }));
vi.mock("./use-engine-models", () => ({ useEngineModels: () => ({ catalogs: {}, modelsByEngine: {}, channelsByEngine: {}, pendingEngines: {}, refresh: vi.fn() }) }));
vi.mock("./MessageTimeline", () => ({ MessageTimeline: () => null }));
// Keep ChatConversation, both composer hooks and messaging real. This minimal
// footer exposes their controlled input, busy/Stop and attachment interfaces.
vi.mock("./ConversationFooter", () => ({ ConversationFooter: (props: {
  draft: string; streaming: boolean; images: string[]; onDraftChange: (v: string) => void; onSubmit: (v: string) => void;
  onStop: () => void; onDropPaths: (paths: string[]) => void; onRemoveImage: (path: string) => void;
  onQueue?: (v: string) => void;
  composerInputRef: RefObject<ComposerInputHandle | null>;
}) => <div>
  <textarea aria-label="draft" value={props.draft} onChange={(e) => props.onDraftChange(e.target.value)} />
  <button onClick={() => props.onSubmit(props.draft)}>submit</button>
  {props.onQueue && <button onClick={() => props.onQueue!(props.draft)}>queue</button>}
  {props.streaming && <button onClick={props.onStop}>stop</button>}
  <button onClick={() => props.onDropPaths(["first.png"])}>attach-first</button>
  <button onClick={() => props.onDropPaths(["next.png"])}>attach-next</button>
  {props.images.map((path) => <button key={path} data-image={path} onClick={() => props.onRemoveImage(path)}>{path}</button>)}
</div> }));

const workspace: Workspace = { id: "draft", path: "G:/composer-draft", name: "draft", lastOpenedAt: null, sortOrder: null, groupId: null };
const tab = { engine: "claude", sessionId: null, workspacePath: workspace.path };
const key = sessionKey(tab.engine, null, workspace.path);
const agentValue: ResolvedBuiltInAgent = { id: "agent", name: "Agent", icon: null, prompt: "Instructions", promptHash: "hash" };
let node: HTMLDivElement, root: Root;
let inputRef: RefObject<ComposerInputHandle | null>;
function state() { return useChatStore.getState(); }
function draftInput() { return node.querySelector<HTMLTextAreaElement>("textarea")!; }
function buttons() { return [...node.querySelectorAll<HTMLButtonElement>("button")]; }
function button(label: string) { return buttons().find((b) => b.textContent === label)!; }
function attached() { return [...node.querySelectorAll<HTMLButtonElement>("[data-image]")].map((b) => b.dataset.image); }
function nativeSends() { return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "send_message" || cmd === "send_leader_message"); }
function render(active = state().active) { return <ChatConversation active={active} engines={state().engines} workspaces={state().workspaces} startNewChat={state().startNewChat} composerInputRef={inputRef} />; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draftInput(), value);
    draftInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); localStorage.clear(); runRouting.clear(); inputRef = createRef();
  vi.mocked(getSelectedAgent).mockReturnValue(null);
  vi.mocked(invoke).mockImplementation(async (cmd, args) => cmd === "send_message" || cmd === "send_leader_message" ? { runId: args!.runId, sessionId: null }
    : cmd === "import_attachments" ? (args!.paths as string[]).map((p) => `/sandbox/${p}`)
    : cmd === "read_file" ? { kind: "other" } : cmd === "load_session_page" ? { messages: [], nextBefore: null, subagentHistory: [] } : undefined);
  useChatStore.setState({ initialized: true, active: tab, openTabs: [tab], activeEngine: "claude", workspaces: [workspace], sessions: [], drafts: { [key]: "first task" },
    bySession: {}, streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {}, unseen: {}, models: {}, efforts: {}, providers: {}, permission: "manual",
    engines: [{ id: "claude", available: true, enabled: true, supportsImages: true, supportsComputerUse: true, permissions: ["manual"] }] });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(render()));
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("draft composer accepts before clearing", () => {
  it("sends through ordinary IPC without the retired Leader workspace eligibility gate", async () => {
    await act(async () => button("attach-first").click()); draftInput().focus();
    useChatStore.setState({ workspaces: [{ ...workspace, meta: { wsl: null } }] });
    await act(async () => button("submit").click());
    expect(nativeSends()).toHaveLength(1); expect(nativeSends()[0][0]).toBe("send_message");
    expect(nativeSends()[0][1]).toMatchObject({ prompt: "first task", imagePaths: ["/sandbox/first.png"] });
    expect(draftInput().value).toBe(""); expect(attached()).toEqual([]);
    expect(document.activeElement).toBe(draftInput());
  });

  it.each(["stop", "close"])("retains input through delayed Agent preparation cancelled by %s", async (action) => {
    await act(async () => button("attach-first").click());
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    draftInput().focus(); await act(async () => button("submit").click());
    expect(draftInput().value).toBe("first task"); expect(attached()).toEqual(["/sandbox/first.png"]);
    expect(button("stop")).toBeTruthy();
    if (action === "stop") await act(async () => button("stop").click());
    else await act(async () => state().closeTab("claude", null, workspace.path));
    await act(async () => agent.resolve(agentValue));
    expect(nativeSends()).toHaveLength(0); expect(draftInput().value).toBe("first task");
    expect(attached()).toEqual(["/sandbox/first.png"]); expect(document.activeElement).toBe(draftInput());
  });

  it("clears accepted original input only, preserving next text and newly added attachments", async () => {
    await act(async () => button("attach-first").click());
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click());
    await edit("next text"); await act(async () => button("attach-next").click());
    draftInput().focus(); await act(async () => agent.resolve(agentValue));
    expect(nativeSends()).toHaveLength(1); expect(nativeSends()[0][1]).toMatchObject({ prompt: expect.stringContaining("first task"), imagePaths: ["/sandbox/first.png"] });
    expect(draftInput().value).toBe("next text"); expect(attached()).toEqual(["/sandbox/next.png"]);
    expect(document.activeElement).toBe(draftInput());
  });

  it("retains a removed-and-reattached identical path as a new attachment", async () => {
    await act(async () => button("attach-first").click());
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click());
    await act(async () => button("/sandbox/first.png").click());
    await act(async () => button("attach-first").click());
    await act(async () => agent.resolve(agentValue));
    expect(draftInput().value).toBe(""); expect(attached()).toEqual(["/sandbox/first.png"]);
    expect(nativeSends()).toHaveLength(1);
  });

  it("queues fresh input during preparation with its attachments instead of dropping it", async () => {
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click());
    await edit("next queued task"); await act(async () => button("attach-next").click());
    await act(async () => button("submit").click());
    expect(state().bySession[key].queue).toMatchObject([{ text: "next queued task", images: ["/sandbox/next.png"] }]);
    expect(draftInput().value).toBe(""); expect(attached()).toEqual([]); expect(nativeSends()).toHaveLength(0);
    await act(async () => agent.resolve(agentValue)); expect(nativeSends()).toHaveLength(1);
    expect(state().bySession[key].queue).toHaveLength(1);
  });

  it.each([false, true])("clears only unchanged original text after switching drafts (original edited: %s)", async (edited) => {
    await act(async () => button("attach-first").click());
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click());
    const other = { ...tab, workspacePath: "G:/other" }; const otherKey = sessionKey(other.engine, null, other.workspacePath);
    await act(async () => {
      useChatStore.setState({ active: other, openTabs: [tab, other], drafts: { ...state().drafts, [key]: edited ? "new hidden text" : "first task", [otherKey]: "other task" } });
      root.render(render(other));
    });
    await act(async () => button("attach-next").click());
    draftInput().focus();
    await act(async () => agent.resolve(agentValue));
    expect(draftInput().value).toBe("other task"); expect(attached()).toContain("/sandbox/next.png");
    expect(state().drafts[key]).toBe(edited ? "new hidden text" : ""); expect(nativeSends()).toHaveLength(1);
    expect(document.activeElement).toBe(draftInput());
  });

  it("clears accepted source text even when the composer unmounted", async () => {
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click()); await act(async () => root.render(null));
    await act(async () => agent.resolve(agentValue));
    expect(state().drafts[key]).toBe(""); expect(nativeSends()).toHaveLength(1);
  });

  it("unlocks Stop immediately and permits a fresh retry without replaying late preparation", async () => {
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>(); vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    await act(async () => button("submit").click()); await act(async () => button("stop").click());
    expect(buttons().some((b) => b.textContent === "stop")).toBe(false);
    expect(draftInput().value).toBe("first task");
    vi.mocked(getSelectedAgent).mockReturnValue(null); await edit("retry task");
    await act(async () => button("submit").click());
    expect(nativeSends()).toHaveLength(1); expect(nativeSends()[0][1]?.prompt).toBe("retry task");
    await act(async () => agent.resolve(agentValue));
    expect(nativeSends()).toHaveLength(1);
    expect(state().bySession[key].messages.filter((m) => m.role === "user")).toMatchObject([{ text: "retry task" }]);
  });

  it("accepts /cua as the first ordinary task once and clears the submitted command", async () => {
    await edit("/ccgui-cua first computer task");
    await act(async () => button("submit").click());
    expect(nativeSends()).toHaveLength(1); expect(nativeSends()[0][0]).toBe("send_message");
    expect(nativeSends()[0][1]).toMatchObject({ prompt: "first computer task", computerUse: true });
    expect(draftInput().value).toBe("");
  });
});

describe("Codex composer live guidance and explicit queue", () => {
  async function seedBusyCodex(streaming = true, engine = "codex") {
    const active = { engine, sessionId: "steer-session", workspacePath: workspace.path };
    const activeKey = sessionKey(active.engine, active.sessionId, active.workspacePath);
    await act(async () => {
      useChatStore.setState({ active, activeEngine: engine, openTabs: [active], bySession: { [activeKey]: { ...EMPTY_SESSION, streaming } },
        drafts: { [activeKey]: "next task" }, engines: [{ id: engine, available: true, enabled: true, supportsImages: true, supportsComputerUse: true, permissions: ["manual"] }] });
      root.render(render(active));
    });
    return { active, activeKey };
  }

  it.each([["codex", true, true], ["codex", false, false], ["claude", true, false], ["pi", true, false]] as const)(
    "exposes explicit queue only for running Codex (engine=%s, streaming=%s)", async (engine, streaming, expected) => {
      await seedBusyCodex(streaming, engine);
      expect(buttons().some((b) => b.textContent === "queue")).toBe(expected);
    },
  );

  it("queues image-only input after existing messages and clears its attachments", async () => {
    const { activeKey } = await seedBusyCodex();
    await act(async () => useChatStore.setState((s) => ({ bySession: { ...s.bySession, [activeKey]: { ...s.bySession[activeKey], queue: [{ id: "earlier", text: "earlier task", images: [], queuedAt: 0 }] } } })));
    await edit(""); await act(async () => button("attach-next").click());
    await act(async () => button("queue").click());
    expect(state().bySession[activeKey].queue).toMatchObject([
      { text: "earlier task", images: [] }, { text: "", images: ["/sandbox/next.png"] },
    ]);
    expect(draftInput().value).toBe(""); expect(attached()).toEqual([]);
    expect(nativeSends()).toHaveLength(0);
  });

  it("routes normal submit to live guidance with its source session and images", async () => {
    const { active } = await seedBusyCodex();
    const original = state().sendWhileBusy;
    const liveSend = vi.fn(async () => {});
    try {
      await act(async () => useChatStore.setState({ sendWhileBusy: liveSend }));
      await act(async () => button("attach-next").click());
      await act(async () => button("submit").click());
      expect(liveSend).toHaveBeenCalledWith("next task", ["/sandbox/next.png"], undefined, active);
      expect(draftInput().value).toBe(""); expect(attached()).toEqual([]);
    } finally {
      await act(async () => useChatStore.setState({ sendWhileBusy: original }));
    }
  });

  it("parses queued computer-use commands and preserves the capability flag", async () => {
    const { activeKey } = await seedBusyCodex();
    await edit("/ccgui-cua open calculator");
    await act(async () => button("queue").click());
    expect(state().bySession[activeKey].queue).toMatchObject([{ text: "open calculator", computerUse: true }]);
    expect(draftInput().value).toBe(""); expect(nativeSends()).toHaveLength(0);
  });

  it("keeps an unsupported queued computer-use command in the draft", async () => {
    const { activeKey } = await seedBusyCodex();
    await act(async () => useChatStore.setState({ engines: [{ id: "codex", available: true, enabled: true, supportsImages: true, supportsComputerUse: false, permissions: ["manual"] }] }));
    await edit("/ccgui-cua open calculator");
    await act(async () => button("queue").click());
    expect(state().bySession[activeKey].queue).toEqual([]);
    expect(draftInput().value).toBe("/ccgui-cua open calculator");
    expect(state().bySession[activeKey].error).toBeTruthy();
  });

  it("keeps bare computer-use setup local for the queue entry", async () => {
    const { activeKey } = await seedBusyCodex();
    await edit("/ccgui-cua");
    await act(async () => button("queue").click());
    expect(window.location.hash).toBe(COMPUTER_USE_SETTINGS_HASH);
    expect(state().bySession[activeKey].queue).toEqual([]);
    expect(draftInput().value).toBe("/ccgui-cua");
  });
});
