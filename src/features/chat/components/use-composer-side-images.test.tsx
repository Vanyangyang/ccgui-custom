import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { useComposerActions } from "./use-composer-actions";
import { sessionKey, useChatStore } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import { handleSideRunEvent, useSidechatStore } from "@/features/sidechat/store";
import { useSlashCommandStore } from "@/components/application/ai-chat/slash-commands";
import { ipc } from "@/lib/ipc";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));
const original = useChatStore.getState();
const sends = vi.fn(async () => {}), clearImages = vi.fn(), acceptedImages = vi.fn(), errors = vi.fn();
const tab = { engine: "codex", sessionId: "side-parent", workspacePath: "/fixture" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
let root: Root, host: HTMLDivElement;
function Harness({ text, supported = true }: { text: string; supported?: boolean }) {
  const actions = useComposerActions({ active: tab, sessionKey: key, streaming: false,
    images: ["/shot.png"], clearImages, captureImageSubmission: () => acceptedImages, importImageFiles: vi.fn(), supportsImages: supported,
    composerInputRef: createRef<ComposerInputHandle>() });
  return <button onClick={() => actions.submit(text)}>submit</button>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); useSlashCommandStore.setState({ byRoot: {} });
  useSidechatStore.setState({ sidechatBySession: {}, btwBySession: {} });
  useChatStore.setState({ ...original, active: tab, openTabs: [tab], drafts: {}, bySession: { [key]: { ...EMPTY_SESSION } }, streamingByKey: {}, send: sends, setSessionError: errors });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useChatStore.setState(original, true); vi.restoreAllMocks(); });
async function submit(text: string, supported = true) {
  useChatStore.getState().setDraft(key, text);
  await act(async () => root.render(<Harness text={text} supported={supported} />));
  await act(async () => host.querySelector("button")!.click());
}
describe("side commands with screenshots", () => {
  it("uses the current parent permission for executable /sidechat while /btw stays read-only", async () => {
    const sideSend = vi.spyOn(ipc, "sendSideMessage").mockResolvedValue({ runId: "unused", sessionId: "side" });
    await useSidechatStore.getState().openSidechat({ sessionKey: key, engine: tab.engine, workspacePath: tab.workspacePath, parentSessionId: tab.sessionId });
    useSidechatStore.getState().setSidechatMode(key, "execute");
    for (const permission of ["auto", "plan"] as const) {
      useChatStore.setState({ permission });
      await submit("/sidechat 看图并处理");
      expect(sideSend).toHaveBeenLastCalledWith(expect.objectContaining({ permission, ephemeral: false }));
      const runId = useSidechatStore.getState().sidechatBySession[key].runId!;
      await act(async () => handleSideRunEvent({ engine: tab.engine, sessionId: "side", runId, seq: 1, kind: "done", data: {} }));
    }
    await submit("/btw 看图解释");
    expect(sideSend.mock.lastCall![0].permission ?? null).toBeNull();
  });

  it.each(["btw", "sidechat"])("forwards /%s screenshots and only clears the source when accepted", async (command) => {
    let resolve!: (value: { runId: string; sessionId: string }) => void;
    const sideSend = vi.spyOn(ipc, "sendSideMessage").mockImplementation(() => new Promise((yes) => { resolve = yes; }));
    await submit(`/${command} 看图 🙂`);
    expect(sideSend).toHaveBeenCalledWith(expect.objectContaining({ prompt: "看图 🙂", imagePaths: ["/shot.png"], ephemeral: command === "btw" }));
    expect(sends).not.toHaveBeenCalled(); expect(clearImages).not.toHaveBeenCalled(); expect(acceptedImages).not.toHaveBeenCalled();
    expect(useChatStore.getState().drafts[key]).toBe(`/${command} 看图 🙂`);
    await act(async () => resolve({ runId: "unused", sessionId: "side" }));
    expect(acceptedImages).toHaveBeenCalledOnce();
    expect(useChatStore.getState().drafts[key]).toBe("");
  });
  it("preserves failed attachments and newer text typed before acceptance", async () => {
    vi.spyOn(ipc, "sendSideMessage").mockRejectedValueOnce(new Error("offline"));
    await submit("/btw");
    expect(useChatStore.getState().drafts[key]).toBe("/btw"); expect(acceptedImages).not.toHaveBeenCalled();
    let resolve!: (value: { runId: string; sessionId: string }) => void;
    vi.mocked(ipc.sendSideMessage).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    await submit("/sidechat");
    useChatStore.getState().setDraft(key, "new draft");
    await act(async () => resolve({ runId: "unused", sessionId: "side" }));
    expect(useChatStore.getState().drafts[key]).toBe("new draft");
  });
  it("honors unsupported engines and custom command precedence", async () => {
    const sideSend = vi.spyOn(ipc, "sendSideMessage");
    await submit("/btw screenshot", false);
    expect(errors).toHaveBeenCalled(); expect(sideSend).not.toHaveBeenCalled(); expect(acceptedImages).not.toHaveBeenCalled();
    useSlashCommandStore.setState({ byRoot: { [tab.workspacePath]: { entries: [{ name: "btw", description: null, source: "workspace", kind: "command" }], status: "ready", fetchedAt: 0 } } });
    await submit("/btw custom");
    expect(sends).toHaveBeenCalledWith("/btw custom", ["/shot.png"], undefined, tab);
    expect(sideSend).not.toHaveBeenCalled();
  });
});
