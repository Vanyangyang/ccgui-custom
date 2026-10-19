// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/i18n";
import { OnboardingEntryButton, OnboardingTourHost } from "./OnboardingTour";
import {
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_SHOW_ENTRY_KEY,
  ONBOARDING_TOPICS,
  useOnboardingStore,
} from "./store";

describe("OnboardingTour & OnboardingEntryButton", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement;
  let root: Root;

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
    localStorage.clear();
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

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
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
    expect(dialog()?.textContent).toContain("ccgui-custom");
    expect(dialog()?.textContent).toContain("构建并热更新");
    click(byTestId("onboarding-demo-stage-2"));
    expect(byTestId("onboarding-demo-self-dev-remove-guard")).toBeTruthy();

    click(byTestId("onboarding-topic-handoff"));
    expect(dialog()?.textContent).toContain("/handoff");

    click(byTestId("onboarding-topic-sidechat"));
    expect(dialog()?.textContent).toContain("/sidechat");
    expect(dialog()?.textContent).toContain("只读");

    click(byTestId("onboarding-topic-btw"));
    expect(dialog()?.textContent).toContain("/btw");

    click(byTestId("onboarding-topic-imageAnnotation"));
    expect(dialog()?.textContent).toContain("批注");
    expect(byTestId("onboarding-demo-image-annotation")).toBeTruthy();

    click(byTestId("onboarding-topic-assistantNotices"));
    expect(dialog()?.textContent).toContain("旁白");

    click(byTestId("onboarding-topic-intelligenceUi"));
    expect(dialog()?.textContent).toContain("Intelligence UI");
    expect(byTestId("onboarding-interactive-demo")).toBeTruthy();
    expect(byTestId("onboarding-iui-sandbox")).toBeTruthy();
    click(byTestId("onboarding-demo-stage-2"));
    click(byTestId("onboarding-iui-apply"));
    expect(byTestId("onboarding-iui-apply")?.textContent).toContain("已追加");
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
