import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { SidechatPanel } from "./SidechatPanel";
import { useSidechatStore } from "./store";
import { resolveSideLaunch } from "./launch";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));
vi.mock("@/features/chat/store", () => ({ useChatStore: Object.assign((selector: (state: { engines: unknown[] }) => unknown) => selector({ engines: [] }), { getState: vi.fn() }) }));
vi.mock("./launch", () => ({ resolveSideLaunch: vi.fn() }));
vi.mock("./insert-answer", () => ({ insertSideAnswer: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Sidechat textarea clipboard events", () => {
  let container: HTMLDivElement;
  let root: Root;
  const sessionKey = "codex:paste-parent";
  beforeEach(async () => {
    vi.clearAllMocks();
    useSidechatStore.setState({ sidechatBySession: {}, btwBySession: {} });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", (media: string) => ({
      media, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await useSidechatStore.getState().openSidechat({
      sessionKey, engine: "codex", workspacePath: "C:/fixture", parentSessionId: "paste-parent",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<><textarea aria-label="Main draft" defaultValue="main draft" /><SidechatPanel active={null} sessionKey={sessionKey} /></>));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["ordinary text", "第一行 🙂\n第二行 👩‍💻"])("allows the native paste event chain for %j", async (text) => {
    const input = container.querySelector("aside textarea") as HTMLTextAreaElement;
    await act(async () => input.focus());
    expect(document.activeElement).toBe(input);
    const key = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => text, items: [] } });
    await act(async () => {
      input.dispatchEvent(key);
      input.dispatchEvent(paste);
    });
    expect(key.defaultPrevented).toBe(false);
    expect(paste.defaultPrevented).toBe(false);
    // jsdom does not implement the browser's paste default action. Emulate its
    // native value insertion and input event after checking neither was blocked.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
    });
    expect(input.value).toBe(text);
    expect(useSidechatStore.getState().sidechatBySession[sessionKey].draft).toBe(text);
    expect((container.querySelector('[aria-label="Main draft"]') as HTMLTextAreaElement).value).toBe("main draft");
    expect(resolveSideLaunch).not.toHaveBeenCalled();
  });

  it("keeps Shift+Enter and IME confirmation distinct from Enter submit", async () => {
    await act(async () => useSidechatStore.getState().setSidechatDraft(sessionKey, "待发送 🙂"));
    const input = container.querySelector("aside textarea") as HTMLTextAreaElement;
    await act(async () => input.focus());
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(resolveSideLaunch).not.toHaveBeenCalled();
    const submit = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(resolveSideLaunch).toHaveBeenCalledOnce();
  });
});
