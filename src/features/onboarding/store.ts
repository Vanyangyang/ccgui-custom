import { create } from "zustand";
import { isWeb } from "@/lib/platform";

export const ONBOARDING_COMPLETED_KEY = "ccgui-next.onboardingCompleted:v1";
export const ONBOARDING_SHOW_ENTRY_KEY = "ccgui-next.onboardingShowEntry:v1";

export const ONBOARDING_TOPICS = [
  "proxy",
  "selfUpdate",
  "handoff",
  "sidechat",
  "btw",
  "imageAnnotation",
  "assistantNotices",
  "intelligenceUi",
] as const;

export type OnboardingTopicId = (typeof ONBOARDING_TOPICS)[number];

export interface OnboardingStepSpec {
  id: string;
  /** CSS selector for the spotlight cutout target; if absent or not mounted, bubble centers on screen. */
  targetSelector?: string;
  titleKey: string;
  bodyKey: string;
  tipKey?: string;
  action?:
    | { kind: "openSettings"; page: string; labelKey: string }
    | { kind: "closeSettings"; labelKey: string };
}

export const ONBOARDING_STEPS_BY_TOPIC: Record<OnboardingTopicId, OnboardingStepSpec[]> = {
  proxy: [
    {
      id: "proxy-config",
      targetSelector: '[data-setting-anchor="proxyAddress"], [data-onboarding-target="sidebar-settings"]',
      titleKey: "onboarding.steps.proxyConfigTitle",
      bodyKey: "onboarding.steps.proxyConfigBody",
      action: {
        kind: "openSettings",
        page: "proxy",
        labelKey: "onboarding.actions.openProxySettings",
      },
    },
  ],
  selfUpdate: [
    {
      id: "self-update-workspace",
      targetSelector: '[data-self-dev-workspace="true"], [data-onboarding-target="workspace-section"]',
      titleKey: "onboarding.steps.selfUpdateWorkspaceTitle",
      bodyKey: "onboarding.steps.selfUpdateWorkspaceBody",
      action: {
        kind: "openSettings",
        page: "workspaces",
        labelKey: "onboarding.actions.openWorkspacesSettings",
      },
    },
  ],
  handoff: [
    {
      id: "handoff-command",
      targetSelector: '[data-onboarding-target="composer-status"], [data-onboarding-target="composer"]',
      titleKey: "onboarding.steps.handoffCommandTitle",
      bodyKey: "onboarding.steps.handoffCommandBody",
    },
  ],
  sidechat: [
    {
      id: "sidechat-overview",
      targetSelector: '[data-onboarding-target="composer"]',
      titleKey: "onboarding.steps.sidechatTitle",
      bodyKey: "onboarding.steps.sidechatBody",
    },
  ],
  btw: [
    {
      id: "btw-overview",
      targetSelector: '[data-onboarding-target="composer"]',
      titleKey: "onboarding.steps.btwTitle",
      bodyKey: "onboarding.steps.btwBody",
    },
  ],
  imageAnnotation: [
    {
      id: "image-annotation-overview",
      targetSelector: '[data-onboarding-target="chat-center"]',
      titleKey: "onboarding.steps.imageAnnotationTitle",
      bodyKey: "onboarding.steps.imageAnnotationBody",
    },
  ],
  assistantNotices: [
    {
      id: "assistant-notices-overview",
      targetSelector: '[data-onboarding-target="assistant-notices"]',
      titleKey: "onboarding.steps.assistantNoticesTitle",
      bodyKey: "onboarding.steps.assistantNoticesBody",
      action: {
        kind: "openSettings",
        page: "assistantNotices",
        labelKey: "onboarding.actions.openAssistantNoticesSettings",
      },
    },
  ],
  intelligenceUi: [
    {
      id: "intelligence-ui-overview",
      targetSelector: '[data-onboarding-target="chat-center"]',
      titleKey: "onboarding.steps.intelligenceUiTitle",
      bodyKey: "onboarding.steps.intelligenceUiBody",
    },
  ],
};

function readBoolStorage(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function writeBoolStorage(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore storage errors
  }
}

export interface OnboardingState {
  open: boolean;
  topic: OnboardingTopicId;
  stepIndex: number;
  showEntry: boolean;
  completed: boolean;
  openTour: (topic?: OnboardingTopicId) => void;
  closeTour: () => void;
  selectTopic: (topic: OnboardingTopicId) => void;
  nextStep: () => void;
  prevStep: () => void;
  setShowEntry: (show: boolean) => void;
  autoStartIfFirstInstall: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  open: false,
  topic: "proxy",
  stepIndex: 0,
  showEntry: readBoolStorage(ONBOARDING_SHOW_ENTRY_KEY, true),
  completed: readBoolStorage(ONBOARDING_COMPLETED_KEY, false),

  openTour: (topic) => {
    set((state) => ({
      open: true,
      topic: topic ?? state.topic ?? "proxy",
      stepIndex: 0,
    }));
  },

  closeTour: () => {
    writeBoolStorage(ONBOARDING_COMPLETED_KEY, true);
    set({ open: false, completed: true });
  },

  selectTopic: (topic) => {
    set({ open: true, topic, stepIndex: 0 });
  },

  nextStep: () => {
    const { topic, stepIndex } = get();
    const steps = ONBOARDING_STEPS_BY_TOPIC[topic];
    if (stepIndex + 1 < steps.length) {
      set({ stepIndex: stepIndex + 1 });
      return;
    }
    const topicIdx = ONBOARDING_TOPICS.indexOf(topic);
    if (topicIdx >= 0 && topicIdx + 1 < ONBOARDING_TOPICS.length) {
      set({
        topic: ONBOARDING_TOPICS[topicIdx + 1],
        stepIndex: 0,
      });
    } else {
      get().closeTour();
    }
  },

  prevStep: () => {
    const { topic, stepIndex } = get();
    if (stepIndex > 0) {
      set({ stepIndex: stepIndex - 1 });
      return;
    }
    const topicIdx = ONBOARDING_TOPICS.indexOf(topic);
    if (topicIdx > 0) {
      const prevTopic = ONBOARDING_TOPICS[topicIdx - 1];
      const prevSteps = ONBOARDING_STEPS_BY_TOPIC[prevTopic];
      set({
        topic: prevTopic,
        stepIndex: Math.max(0, prevSteps.length - 1),
      });
    }
  },

  setShowEntry: (show) => {
    writeBoolStorage(ONBOARDING_SHOW_ENTRY_KEY, show);
    set({ showEntry: show });
  },

  autoStartIfFirstInstall: () => {
    if (isWeb) return;
    const completed = readBoolStorage(ONBOARDING_COMPLETED_KEY, false);
    if (!completed) {
      set({ open: true, topic: "proxy", stepIndex: 0 });
    }
  },
}));
