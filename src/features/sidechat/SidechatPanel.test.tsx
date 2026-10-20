import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { SidechatPanel } from "./SidechatPanel";
import { useSidechatStore } from "./store";
import { SIDECHAT_WIDTH_KEY } from "./use-sidechat-resize";

const chat = vi.hoisted(() => ({
  refreshSessions: vi.fn(), selectSession: vi.fn(), setState: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { promoteSideSession: vi.fn() } }));
vi.mock("@/features/chat/store", () => ({ useChatStore: Object.assign((selector: (state: { engines: unknown[] }) => unknown) => selector({ engines: [] }), { getState: () => chat, setState: chat.setState }) }));
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
    vi.clearAllMocks();
    chat.refreshSessions.mockResolvedValue(undefined);
    chat.selectSession.mockResolvedValue(undefined);
    vi.mocked(ipc.promoteSideSession).mockResolvedValue(undefined);
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

  it("explains why promotion is unavailable before a native session exists or while running", async () => {
    await i18n.changeLanguage("zh");
    await open();
    await act(async () => root.render(<SidechatPanel active={null} sessionKey={sessionKey} />));
    const button = () => container.querySelector<HTMLButtonElement>('button[aria-label="转为独立对话"]')!;
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("旁聊取得可恢复的会话后才能转为独立对话。");
    await act(async () => useSidechatStore.setState((s) => ({ sidechatBySession: { [sessionKey]: {
      ...s.sidechatBySession[sessionKey], sideSessionId: "side-ready", streaming: true,
    } } })));
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("请先等待旁聊结束或停止，再转为独立对话。");
    expect(ipc.promoteSideSession).not.toHaveBeenCalled();
  });

  async function renderPromotable() {
    await i18n.changeLanguage("zh");
    await open();
    useSidechatStore.setState((s) => ({ sidechatBySession: { [sessionKey]: {
      ...s.sidechatBySession[sessionKey], sideSessionId: "side-ready",
      messages: [{ seq: 1, role: "user", text: "保留旁聊 中文🙂", ts: null }],
    } } }));
    await act(async () => root.render(<SidechatPanel active={null} sessionKey={sessionKey} />));
    return container.querySelector<HTMLButtonElement>('button[aria-label="转为独立对话"]')!;
  }

  it("waits for promotion, prevents repeated clicks and opens the indexed conversation", async () => {
    let finish!: () => void;
    vi.mocked(ipc.promoteSideSession).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const button = await renderPromotable();
    await act(async () => button.click());
    try {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("正在转为独立对话…");
      expect(chat.selectSession).not.toHaveBeenCalled();
      expect(container.textContent).toContain("保留旁聊 中文🙂");
      await act(async () => button.click());
      expect(ipc.promoteSideSession).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finish());
    }
    expect(ipc.promoteSideSession).toHaveBeenCalledWith("codex", "side-ready", "C:/fixture", "resize-parent");
    expect(chat.refreshSessions).toHaveBeenCalledTimes(1);
    expect(chat.selectSession).toHaveBeenCalledWith("codex", "side-ready", "C:/fixture");
    expect(container.querySelector("aside")).toBeNull();
  });

  it("keeps the branch visible and allows retry when native indexing fails", async () => {
    const button = await renderPromotable();
    vi.mocked(ipc.promoteSideSession).mockRejectedValueOnce(new Error("Sidechat history is not available yet"));
    await act(async () => button.click());
    expect(container.textContent).toContain("保留旁聊 中文🙂");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Sidechat history is not available yet");
    expect(button.disabled).toBe(false);
    expect(chat.selectSession).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(chat.selectSession).toHaveBeenCalledWith("codex", "side-ready", "C:/fixture");
  });

  it("reports tab-opening failures after native promotion instead of dropping the error", async () => {
    const button = await renderPromotable();
    chat.selectSession.mockRejectedValueOnce(new Error("tab unavailable"));
    await act(async () => button.click());
    expect(chat.setState).toHaveBeenCalledWith({ actionError: "tab unavailable" });
  });

  it.each([
    { language: "zh", readOnly: "只读", execute: "可执行" },
    { language: "en", readOnly: "Read-only", execute: "Executable" },
  ])("switches mode with accessible controls and locks them during a run ($language)", async ({ language, readOnly, execute }) => {
    await i18n.changeLanguage(language);
    await open();
    await act(async () => root.render(<SidechatPanel active={null} sessionKey={sessionKey} />));
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons().map(b => b.textContent)).toEqual([readOnly, execute]);
    expect(buttons().map(b => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(buttons()[0].className).toContain("bg-button-primary");
    expect(buttons()[1].className).toContain("bg-transparent");
    expect(buttons()[1].className).not.toContain("bg-button-ghost-background");
    await act(async () => buttons()[1].click());
    expect(useSidechatStore.getState().sidechatBySession[sessionKey].mode).toBe("execute");
    expect(buttons().map(b => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(buttons()[1].className).toContain("bg-button-primary");
    expect(buttons()[0].className).toContain("bg-transparent");
    await act(async () => useSidechatStore.setState((s) => ({ sidechatBySession: { ...s.sidechatBySession, [sessionKey]: {
      ...s.sidechatBySession[sessionKey], streaming: true, runId: "sidechat-mode", startedAt: Date.now(),
    } } })));
    expect(buttons().every(b => b.disabled && b.title.length > 0)).toBe(true);
    await act(async () => buttons()[0].click());
    expect(useSidechatStore.getState().sidechatBySession[sessionKey].mode).toBe("execute");
  });
});
