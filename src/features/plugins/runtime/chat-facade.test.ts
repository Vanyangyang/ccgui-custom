import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import type { ChatStore, SendOptions } from "@/features/chat/store/types";
import { sessionKey } from "@/features/chat/store/persistence";
import { desktopChatFacade } from "./chat-bridge";

const fake = vi.hoisted(() => ({ state: null as unknown as ChatStore, subscribe: vi.fn(() => () => {}) }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn() }));
vi.mock("@/features/chat/store", async () => ({
  sessionKey: (await import("@/features/chat/store/persistence")).sessionKey,
  useChatStore: { getState: () => fake.state, subscribe: fake.subscribe },
}));
const tab = { engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/one", model: "original-model" };
const other = { engine: "claude", sessionId: "22222222-2222-2222-2222-222222222222", workspacePath: "G:/two" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
beforeEach(() => {
  fake.state = { initialized: true, active: tab, openTabs: [tab, other], archivedSessionKeys: {},
    bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "original-model", activeEffort: "high", activeProvider: "original-channel" } },
    send: vi.fn(async (_prompt: string, _images: string[], options?: SendOptions) => options?.onRunStarted?.({ runId: options.requestedRunId!, sessionId: tab.sessionId })),
  } as unknown as ChatStore;
});

describe("host-owned desktop store facade", () => {
  it("reads native identity and sends through the real store API with exact tab, frozen run and no model overrides", async () => {
    const facade = await desktopChatFacade(); const target = facade.current()!;
    expect(target).toMatchObject({ client: "ccgui", nativeSessionId: tab.sessionId, guiSessionId: tab.sessionId, workspacePath: tab.workspacePath, status: "idle" });
    fake.state.active = other;
    expect(await facade.send(target, "Canvas", "run-frozen")).toEqual({ runId: "run-frozen", sessionId: tab.sessionId });
    expect(fake.state.send).toHaveBeenCalledWith("Canvas", [], { requestedRunId: "run-frozen", onRunStarted: expect.any(Function) }, tab);
    expect(fake.state.active).toEqual(other);
  });
  it("preserves a real null-session spawn ACK without filling it from the requested timeline", async () => {
    const facade = await desktopChatFacade(); const target = facade.current()!; fake.state.active = other;
    vi.mocked(fake.state.send).mockImplementationOnce(async (_prompt, _images, options) => {
      options?.onRunStarted?.({ runId: options.requestedRunId!, sessionId: null });
    });
    expect(await facade.send(target, "Canvas", "run-frozen")).toEqual({ runId: "run-frozen", sessionId: null });
    expect(fake.state.active).toEqual(other);
  });
  it("does not manufacture native identity or reach closed, unloaded, archived, other-document sessions", async () => {
    const facade = await desktopChatFacade(); const target = facade.current()!;
    expect(facade.inspect({ ...target, windowId: "other-window" })).toBeNull();
    fake.state.active = { ...tab, sessionId: null }; expect(facade.current()).toBeNull();
    fake.state.bySession[key].loading = true; expect(facade.inspect(target)).toBeNull();
    fake.state.bySession[key].loading = false; fake.state.archivedSessionKeys[key] = true; expect(facade.inspect(target)).toBeNull();
    fake.state.archivedSessionKeys = {}; fake.state.openTabs = [other]; expect(facade.inspect(target)).toBeNull();
    await expect(facade.send(target, "never", "run-frozen")).rejects.toThrow(/reachable/);
    expect(fake.state.send).not.toHaveBeenCalled();
  });
  it("reports busy/GUI permission state without approving or interrupting", async () => {
    const facade = await desktopChatFacade(); const target = facade.current()!;
    fake.state.bySession[key].streaming = true; expect(facade.inspect(target)?.status).toBe("busy");
    await expect(facade.send(target, "never", "run-frozen")).rejects.toThrow(/busy/);
    fake.state.bySession[key].messages = [{ role: "question", seq: 1, text: "", ts: "", question: { status: "pending" } }] as ChatStore["bySession"][string]["messages"];
    expect(facade.inspect(target)?.status).toBe("awaiting_permission");
    expect(fake.state.send).not.toHaveBeenCalled();
  });
});
