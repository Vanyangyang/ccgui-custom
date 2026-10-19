import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { SidechatPanel } from "./SidechatPanel";
import { useSidechatStore } from "./store";
import { SIDECHAT_WIDTH_KEY } from "./use-sidechat-resize";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));
vi.mock("@/features/chat/store", () => ({ useChatStore: Object.assign((selector: (state: { engines: unknown[] }) => unknown) => selector({ engines: [] }), { getState: vi.fn() }) }));
vi.mock("./launch", () => ({ resolveSideLaunch: vi.fn() }));
vi.mock("./insert-answer", () => ({ insertSideAnswer: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Sidechat panel resize integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  const sessionKey = "codex:resize-parent";
  const open = () => useSidechatStore.getState().openSidechat({
    sessionKey, engine: "codex", workspacePath: "C:/fixture", parentSessionId: "resize-parent",
  });
  beforeEach(() => {
    localStorage.clear();
    useSidechatStore.setState({ sidechatBySession: {}, btwBySession: {} });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", (media: string) => ({
      media, matches: media === "(min-width: 768px)",
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200 } as DOMRect);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { language: "zh", title: "旁聊", placeholder: "继续追问…", close: "收起" },
    { language: "en", title: "Sidechat", placeholder: "Ask a follow-up…", close: "Collapse" },
  ])("renders translated controls, resizes and preserves draft/width on reopen ($language)", async ({ language, title, placeholder, close }) => {
    await i18n.changeLanguage(language);
    await open();
    useSidechatStore.getState().setSidechatDraft(sessionKey, "保留草稿 🙂");
    await act(async () => root.render(<div><SidechatPanel active={null} sessionKey={sessionKey} /></div>));
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("aria-label")).toBe(title);
    expect(aside.textContent).not.toContain("sidechat.");
    expect(container.querySelector("textarea")?.placeholder).toBe(placeholder);
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator).not.toBeNull();
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-label")).not.toContain("sidechat.");
    expect(separator.tabIndex).toBe(0);
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(aside.style.getPropertyValue("--sidechat-width")).toBe("432px");
    expect(separator.getAttribute("aria-valuenow")).toBe("432");
    expect(localStorage.getItem(SIDECHAT_WIDTH_KEY)).toBe("432");
    const closeButton = container.querySelector<HTMLButtonElement>(`button[aria-label="${close}"]`)!;
    await act(async () => closeButton.click());
    expect(container.querySelector("aside")).toBeNull();
    await act(async () => { await open(); });
    expect(container.querySelector("aside")?.style.getPropertyValue("--sidechat-width")).toBe("432px");
    expect(container.querySelector("textarea")?.value).toBe("保留草稿 🙂");
  });

  it("keeps run feedback visible during answer streaming and removes it on settlement", async () => {
    await i18n.changeLanguage("zh");
    await open();
    useSidechatStore.setState((s) => ({ sidechatBySession: { ...s.sidechatBySession, [sessionKey]: {
      ...s.sidechatBySession[sessionKey], streaming: true, runId: "sidechat-progress", startedAt: Date.now() - 75_000,
      progress: { phase: "responding", lastEventAt: Date.now() - 65_000 },
      messages: [{ seq: 1, role: "assistant", text: "已有回答 中文 🙂", ts: null, live: true }],
    } } }));
    await act(async () => root.render(<div><SidechatPanel active={null} sessionKey={sessionKey} /></div>));
    expect(container.querySelector("[data-side-run-status]")?.textContent).toContain("暂无新活动");
    expect(container.textContent).toContain("已有回答 中文 🙂");
    expect(container.textContent).not.toContain("正在回答…");
    await act(async () => useSidechatStore.setState((s) => ({ sidechatBySession: { ...s.sidechatBySession, [sessionKey]: {
      ...s.sidechatBySession[sessionKey], streaming: false, runId: null, error: "connection lost",
    } } })));
    expect(container.querySelector("[data-side-run-status]")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("connection lost");
  });
});
