import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationModeRegistry } from "@ccgui/plugin-sdk";
import { useChatStore, sessionKey, type ActiveSession } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";

vi.mock("../runtime/loader", () => ({ notePluginRenderOk: vi.fn(), reportPluginCrash: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storageKey = "ccgui.plugin-conversation-identities:v1";
const restoredId = JSON.stringify(["/restored", "new:pi:/restored", "saved-draft-token"]);
localStorage.setItem(storageKey, JSON.stringify({ [JSON.stringify(["/restored", "new:pi:/restored"])]: restoredId }));
const { useConversationMode } = await import("./use-conversation-mode");
const savedAfterImport = localStorage.getItem(storageKey);

describe("conversation mode lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useConversationMode>;
  let dispose: () => void;
  const first: ActiveSession = { engine: "pi", sessionId: null, workspacePath: "/a" };
  const second: ActiveSession = { engine: "pi", sessionId: null, workspacePath: "/b" };

  function Harness() {
    const active = useChatStore((state) => state.active);
    result = useConversationMode(active);
    return <span>{result.mode?.id ?? "normal"}</span>;
  }

  beforeEach(() => {
    useChatStore.setState({ active: first, openTabs: [first, second], bySession: {}, drafts: {} });
    dispose = conversationModeRegistry.register({ id: "plugin:relay", label: () => "Relay", component: () => null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => { root.unmount(); dispose(); });
    container.remove();
    useChatStore.setState({ active: null, openTabs: [], bySession: {}, drafts: {} });
  });

  it("does not erase persisted draft identity before asynchronous chat hydration", () => {
    expect(JSON.parse(savedAfterImport!)[JSON.stringify(["/restored", "new:pi:/restored"])]).toBe(restoredId);
  });

  it("isolates sessions and workspaces; stale exits cannot clear the newly active mode", () => {
    const firstId = result.conversationId;
    act(() => result.onSelect("plugin:relay"));
    const oldExit = result.onExit;
    act(() => useChatStore.setState({ active: second }));
    expect(result.mode).toBeUndefined();
    expect(result.conversationId).not.toBe(firstId);
    act(() => result.onSelect("plugin:relay"));
    act(oldExit);
    expect(result.mode?.id).toBe("plugin:relay");
    act(() => useChatStore.setState({ active: first }));
    expect(result.conversationId).toBe(firstId);
    expect(result.mode).toBeUndefined();
  });

  it("rechecks live streaming and queues at selection time, including stale handlers", () => {
    const select = result.onSelect;
    const key = sessionKey(first.engine, first.sessionId, first.workspacePath);
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, streaming: true } } });
    act(() => select("plugin:relay"));
    expect(result.mode).toBeUndefined();
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, queue: [{ id: "q", text: "wait", images: [], queuedAt: 1 }] } } });
    act(() => select("plugin:relay"));
    expect(result.mode).toBeUndefined();
    act(() => useChatStore.setState({ active: second, bySession: {} }));
    act(() => select("plugin:relay"));
    expect(result.mode).toBeUndefined();
  });

  it("removes mode selection on unload, including inactive sessions", () => {
    act(() => result.onSelect("plugin:relay"));
    act(() => useChatStore.setState({ active: second }));
    act(dispose);
    act(() => {
      dispose = conversationModeRegistry.register({ id: "plugin:relay", label: () => "Relay", component: () => null });
      useChatStore.setState({ active: first });
    });
    expect(result.mode).toBeUndefined();
  });

  it("keeps draft identity across a remount but renews it after closing and recreating a draft", () => {
    const identity = result.conversationId;
    act(() => result.onSelect("plugin:relay"));
    act(() => root.render(null));
    act(() => root.render(<Harness />));
    expect(result.conversationId).toBe(identity);
    expect(result.mode?.id).toBe("plugin:relay");
    act(() => useChatStore.setState({ active: second, openTabs: [second] }));
    act(() => useChatStore.setState({ active: { ...first }, openTabs: [second, { ...first }] }));
    expect(result.conversationId).not.toBe(identity);
    expect(result.mode).toBeUndefined();
  });
});
