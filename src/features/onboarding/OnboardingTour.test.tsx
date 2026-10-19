// @vitest-environment jsdom
import { act, type FormEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { OnboardingEntryButton, OnboardingTourHost } from "./OnboardingTour";
import { SidechatToggle } from "@/features/sidechat/SidechatToggle";
import { useSidechatStore } from "@/features/sidechat/store";
import {
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_SHOW_ENTRY_KEY,
  ONBOARDING_TOPICS,
  ONBOARDING_STEPS_BY_TOPIC,
  useOnboardingStore,
} from "./store";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));
vi.mock("@/features/chat/store", () => ({
  sessionKey: (engine: string, id: string) => `${engine}:${id}`,
  useChatStore: { getState: vi.fn() },
}));
vi.mock("@/features/sidechat/launch", () => ({ resolveSideLaunch: vi.fn() }));
vi.mock("@/features/sidechat/insert-answer", () => ({ insertSideAnswer: vi.fn() }));

describe("OnboardingTour & OnboardingEntryButton", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement;
  let root: Root;
  let originalLanguage: string;
  let originalHash: string;

  function mockControlRects() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const compact = this.matches('input, button[data-onboarding-target], [data-onboarding-target="composer-input"]');
      return { top: 500, left: compact ? 200 : 10, width: compact ? 180 : 900, height: compact ? 32 : 400 } as DOMRect;
    });
  }

  async function flushTargetChanges() {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  }

  function renderUI(node: ReactNode) {
    act(() => {
      root.render(node);
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  function click(el: HTMLElement | null) {
    expect(el).toBeTruthy();
    act(() => {
      el!.click();
    });
  }

  beforeEach(() => {
    originalLanguage = i18n.language;
    originalHash = window.location.hash;
    localStorage.clear();
    useSidechatStore.setState({ sidechatBySession: {}, btwBySession: {} });
    useOnboardingStore.setState({
      open: false,
      topic: "proxy",
      stepIndex: 0,
      showEntry: true,
      completed: false,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.location.hash = originalHash;
    await i18n.changeLanguage(originalLanguage);
  });

  it("renders the top-bar guide button and allows hiding and re-enabling it", () => {
    renderUI(
      <div>
        <OnboardingEntryButton />
        <OnboardingTourHost />
      </div>,
    );

    const openBtn = byTestId("onboarding-open-button");
    expect(openBtn).toBeTruthy();

    // Click to open the tour
    click(openBtn);
    expect(byTestId("onboarding-tour-overlay")).toBeTruthy();

    // Hide the top-bar entry from inside the tour bubble
    click(byTestId("onboarding-hide-entry-button"));
    expect(useOnboardingStore.getState().showEntry).toBe(false);
    expect(localStorage.getItem(ONBOARDING_SHOW_ENTRY_KEY)).toBe("0");
    expect(byTestId("onboarding-open-button")).toBeNull();

    // Re-enable as Settings → General → Appearance does
    act(() => {
      useOnboardingStore.getState().setShowEntry(true);
    });
    expect(useOnboardingStore.getState().showEntry).toBe(true);
    expect(localStorage.getItem(ONBOARDING_SHOW_ENTRY_KEY)).toBe("1");
    expect(byTestId("onboarding-open-button")).toBeTruthy();
  });

  it("allows freely selecting and viewing all 8 feature guides (proxy, selfUpdate, handoff, sidechat, btw, imageAnnotation, assistantNotices, intelligenceUi)", () => {
    act(() => {
      useOnboardingStore.getState().openTour("proxy");
    });
    renderUI(<OnboardingTourHost />);

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

    // 1. Proxy guide includes AI screenshot tip
    expect(dialog()?.textContent).toContain("截图");

    // 2. Switch to each of the 8 topics and verify content renders
    expect(ONBOARDING_TOPICS).toHaveLength(8);
    for (const topic of ONBOARDING_TOPICS) {
      const tab = byTestId(`onboarding-topic-${topic}`);
      click(tab);
      expect(useOnboardingStore.getState().topic).toBe(topic);
      expect(tab?.getAttribute("aria-selected")).toBe("true");
    }

    // Verify specific topics
    click(byTestId("onboarding-topic-selfUpdate"));
    expect(dialog()?.textContent).toContain("右下角");
    expect(byTestId("onboarding-step-count")?.textContent).toContain("1 / 3");
    click(byTestId("onboarding-next-button"));
    expect(dialog()?.textContent).toContain("决定更新");
    click(byTestId("onboarding-next-button"));
    expect(byTestId("onboarding-step-count")?.textContent).toContain("3 / 3");
    expect(dialog()?.textContent).toContain("ccgui-custom");
    expect(dialog()?.textContent).toContain("构建并热更新");

    click(byTestId("onboarding-topic-handoff"));
    expect(dialog()?.textContent).toContain("/handoff");

    click(byTestId("onboarding-topic-sidechat"));
    expect(dialog()?.textContent).toContain("/sidechat");
    expect(dialog()?.textContent).toContain("只读");

    click(byTestId("onboarding-topic-btw"));
    expect(dialog()?.textContent).toContain("/btw");

    click(byTestId("onboarding-topic-imageAnnotation"));
    expect(dialog()?.textContent).toContain("批注");

    click(byTestId("onboarding-topic-assistantNotices"));
    expect(dialog()?.textContent).toContain("旁白");

    click(byTestId("onboarding-topic-intelligenceUi"));
    expect(dialog()?.textContent).toContain("Intelligence UI");
    expect(byTestId("onboarding-interactive-demo")).toBeNull();
    expect(byTestId("onboarding-instruction")?.textContent).toContain("滑杆");
    expect(byTestId("onboarding-result")?.textContent).toContain("参数");
  });

  it("keeps each guide still instead of automatically changing demonstrations", () => {
    vi.useFakeTimers();
    act(() => useOnboardingStore.getState().openTour("sidechat"));
    renderUI(<OnboardingTourHost />);
    const before = document.querySelector('[role="dialog"]')!.textContent;
    act(() => vi.advanceTimersByTime(12_000));
    expect(document.querySelector('[role="dialog"]')!.textContent).toBe(before);
    expect(before).toContain("怎么操作");
    expect(before).toContain("会有什么效果");
    expect(before).not.toContain("自动演练");
  });

  it.each([false, true])("spotlights the real branch button and opens Sidechat without collapsing it (already open: %s)", (alreadyOpen) => {
    const active = { engine: "codex" as const, sessionId: "guide-parent", workspacePath: "C:/fixture" };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const button = this.dataset.onboardingTarget === "sidechat-toggle";
      return { top: button ? 600 : 0, left: button ? 350 : 0, width: button ? 28 : 800, height: button ? 24 : 200 } as DOMRect;
    });
    if (alreadyOpen) {
      useSidechatStore.getState().toggleSidechat({ sessionKey: "codex:guide-parent", ...active, parentSessionId: active.sessionId });
      useSidechatStore.getState().setSidechatDraft("codex:guide-parent", "保留草稿 🙂");
    }
    act(() => useOnboardingStore.getState().openTour("sidechat"));
    renderUI(<><div data-onboarding-target="composer"><SidechatToggle active={active} /></div><OnboardingTourHost /></>);
    const ring = byTestId("onboarding-spotlight-ring")!;
    expect(ring.style.left).toBe("344px");
    expect(ring.style.width).toBe("40px");
    expect(byTestId("onboarding-instruction")?.textContent).toContain("分叉图标");
    if (alreadyOpen) {
      click(byTestId("onboarding-step-action-sidechat-overview"));
    } else {
      // A single click on the highlighted icon opens the real panel.
      act(() => byTestId("onboarding-spotlight-backdrop")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 364, clientY: 612 }),
      ));
    }
    expect(useOnboardingStore.getState().open).toBe(false);
    const sidechat = useSidechatStore.getState().sidechatBySession["codex:guide-parent"];
    expect(sidechat.open).toBe(true);
    expect(sidechat.runId).toBeNull();
    expect(sidechat.messages).toEqual([]);
    if (alreadyOpen) expect(sidechat.draft).toBe("保留草稿 🙂");
    const toggle = host.querySelector<HTMLElement>('[data-onboarding-target="sidechat-toggle"]');
    expect(document.activeElement).toBe(toggle);
    click(toggle);
    expect(useSidechatStore.getState().sidechatBySession["codex:guide-parent"].open).toBe(false);
    if (alreadyOpen) expect(useSidechatStore.getState().sidechatBySession["codex:guide-parent"].draft).toBe("保留草稿 🙂");
  });

  it("explains a missing Sidechat entry without highlighting the entire composer or offering a dead action", () => {
    act(() => useOnboardingStore.getState().openTour("sidechat"));
    renderUI(<OnboardingTourHost />);
    expect(byTestId("onboarding-spotlight-ring")).toBeNull();
    expect(byTestId("onboarding-step-action-sidechat-overview")).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("请先打开");
  });

  it.each([
    ["handoff", "handoff-command", "/handoff 继续完成剩余任务", "发送快捷键"],
    ["btw", "btw-overview", "/btw 这段报错是什么意思？", "发送快捷键"],
    ["intelligenceUi", "intelligence-ui-overview", "请用交互卡比较两种方案", "发送"],
  ] as const)("focuses the actual %s input without changing or submitting its draft", (topic, step, example, submitInstruction) => {
    mockControlRects();
    const onInput = vi.fn();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const draft = "保留中文草稿 👩‍💻🙂\n下一行";
    act(() => useOnboardingStore.getState().openTour(topic));
    renderUI(<><form onSubmit={onSubmit} data-onboarding-target="composer">
      <div contentEditable suppressContentEditableWarning tabIndex={0} data-onboarding-target="composer-input" onInput={onInput}>{draft}</div>
    </form><OnboardingTourHost /></>);
    expect(byTestId("onboarding-spotlight-ring")?.style.width).toBe("192px");
    expect(byTestId("onboarding-spotlight-ring")?.style.left).toBe("194px");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(example);
    expect(byTestId("onboarding-instruction")?.textContent).toContain(submitInstruction);
    click(byTestId(`onboarding-step-action-${step}`));
    const input = host.querySelector('[data-onboarding-target="composer-input"]');
    expect(document.activeElement).toBe(input);
    expect(input?.textContent).toBe(draft);
    expect(useOnboardingStore.getState().open).toBe(false);
    expect(onInput).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("tracks a proxy input mounted after settings navigation and clears its removed highlight", async () => {
    vi.useFakeTimers();
    mockControlRects();
    act(() => useOnboardingStore.getState().openTour("proxy"));
    renderUI(<><div data-onboarding-target="composer" /><div data-onboarding-target="chat-center" /><OnboardingTourHost /></>);
    expect(byTestId("onboarding-spotlight-ring")).toBeNull();
    click(byTestId("onboarding-step-action-proxy-config"));
    expect(window.location.hash).toBe("#/settings?page=proxy");
    expect(useOnboardingStore.getState().open).toBe(true);
    const row = document.createElement("div");
    row.dataset.settingAnchor = "proxyAddress";
    const input = document.createElement("input");
    row.append(input);
    host.append(row);
    await flushTargetChanges();
    expect(byTestId("onboarding-spotlight-ring")?.style.width).toBe("192px");
    expect(byTestId("onboarding-spotlight-ring")?.style.left).toBe("194px");
    row.remove();
    await flushTargetChanges();
    expect(byTestId("onboarding-spotlight-ring")).toBeNull();
    expect(useOnboardingStore.getState().open).toBe(true);
  });

  it.each([false, true])("never starts a build from the guide (disabled: %s)", (disabled) => {
    mockControlRects();
    const build = vi.fn();
    act(() => {
      useOnboardingStore.getState().openTour("selfUpdate");
      useOnboardingStore.getState().nextStep();
      useOnboardingStore.getState().nextStep();
    });
    renderUI(<><button disabled={disabled} data-onboarding-target="self-update-build" onClick={build}>构建并热更新</button><OnboardingTourHost /></>);
    const action = byTestId("onboarding-step-action-self-update-workspace") as HTMLButtonElement;
    expect(action.disabled).toBe(disabled);
    click(action);
    expect(build).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().open).toBe(disabled);
    if (!disabled) expect(document.activeElement).toBe(host.querySelector('[data-onboarding-target="self-update-build"]'));
  });

  it.each([false, true])("opens a visible image preview, or focuses the composer when none exists (preview: %s)", (hasPreview) => {
    mockControlRects();
    const openPreview = vi.fn();
    const hiddenPreview = vi.fn();
    act(() => useOnboardingStore.getState().openTour("imageAnnotation"));
    renderUI(<><div data-onboarding-target="composer">
      <div contentEditable tabIndex={0} data-onboarding-target="composer-input" />
      <button hidden data-onboarding-target="image-preview" onClick={hiddenPreview}>隐藏图片</button>
      {hasPreview && <button data-onboarding-target="image-preview" onClick={openPreview}>图片缩略图</button>}
    </div><OnboardingTourHost /></>);
    expect(byTestId("onboarding-spotlight-ring")?.style.width).toBe("192px");
    const instructions = byTestId("onboarding-instruction")?.textContent;
    for (const phrase of ["粘贴", "批注图片", "添加到草稿", "再发送"]) expect(instructions).toContain(phrase);
    click(byTestId("onboarding-step-action-image-annotation-overview"));
    expect(document.activeElement).toBe(host.querySelector(hasPreview ? 'button:not([hidden])[data-onboarding-target="image-preview"]' : '[data-onboarding-target="composer-input"]'));
    expect(openPreview).toHaveBeenCalledTimes(hasPreview ? 1 : 0);
    expect(hiddenPreview).not.toHaveBeenCalled();
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it.each(["zh", "en"])("renders translated instructions and results for all eight topics in %s", async (language) => {
    await act(async () => { await i18n.changeLanguage(language); });
    act(() => useOnboardingStore.getState().openTour("proxy"));
    renderUI(<OnboardingTourHost />);
    for (const topic of ONBOARDING_TOPICS) {
      click(byTestId(`onboarding-topic-${topic}`));
      for (let step = 0; step < ONBOARDING_STEPS_BY_TOPIC[topic].length; step++) {
        for (const id of ["onboarding-instruction", "onboarding-result"]) {
          const text = byTestId(id)?.textContent;
          expect(text?.trim()).toBeTruthy();
          expect(text).not.toMatch(/onboarding\.(steps|examples|missing)/);
          if (language === "en") expect(text).not.toMatch(/[\u4e00-\u9fff]/);
          else expect(text).toMatch(/[\u4e00-\u9fff]/);
        }
        if (step + 1 < ONBOARDING_STEPS_BY_TOPIC[topic].length) click(byTestId("onboarding-next-button"));
      }
    }
  });

  it.each(["input", "textarea", "contenteditable"])("closes with Escape from a focused %s while preserving editing keys", (kind) => {
    act(() => useOnboardingStore.getState().openTour("selfUpdate"));
    renderUI(<>{kind === "input" ? <input /> : kind === "textarea" ? <textarea /> : <div contentEditable tabIndex={0} />}<OnboardingTourHost /></>);
    const input = host.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]')!;
    input.focus();
    for (const options of [{ key: "ArrowRight" }, { key: "ArrowLeft" },
      { key: "Escape", isComposing: true }, { key: "Escape", ctrlKey: true },
      { key: "Escape", metaKey: true }, { key: "Escape", altKey: true }]) {
      const event = new KeyboardEvent("keydown", { ...options, bubbles: true, cancelable: true });
      act(() => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(useOnboardingStore.getState().open).toBe(true);
      expect(useOnboardingStore.getState().stepIndex).toBe(0);
    }
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(useOnboardingStore.getState().open).toBe(false);
    expect(useOnboardingStore.getState().completed).toBe(true);
  });

  it("can be closed at any time via close button or Escape key and records completion", () => {
    act(() => {
      useOnboardingStore.getState().openTour("proxy");
    });
    renderUI(<OnboardingTourHost />);

    expect(byTestId("onboarding-tour-overlay")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(useOnboardingStore.getState().open).toBe(false);
    expect(useOnboardingStore.getState().completed).toBe(true);
    expect(localStorage.getItem(ONBOARDING_COMPLETED_KEY)).toBe("1");
  });
});
