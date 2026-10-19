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

export interface OnboardingTargetSpec {
  selector: string;
  labelKey: string;
  /** Only focus inputs or open an existing UI. Never submit, save, or build. */
  interaction?: "focus" | "open";
  actionLabelKey?: string;
}

export interface OnboardingStepSpec {
  id: string;
  /** Prefer the first visible, specific control; never substitute an entire pane. */
  targets: OnboardingTargetSpec[];
  titleKey: string;
  instructionKeys: string[];
  resultKey: string;
  missingTargetKey: string;
  exampleKey?: string;
  noteKey?: string;
  action?: { kind: "openSettings"; page: string; labelKey: string };
}

const COMPOSER_INPUT: OnboardingTargetSpec = {
  selector: '[data-onboarding-target="composer-input"]',
  labelKey: "onboarding.targets.composerInput",
  interaction: "focus",
  actionLabelKey: "onboarding.actions.focusInput",
};

export const ONBOARDING_STEPS_BY_TOPIC: Record<OnboardingTopicId, OnboardingStepSpec[]> = {
  proxy: [
    {
      id: "proxy-config",
      targets: [
        { selector: '[data-setting-anchor="proxyAddress"] input', labelKey: "onboarding.targets.proxyAddress", interaction: "focus", actionLabelKey: "onboarding.actions.focusProxyAddress" },
        { selector: '[data-onboarding-target="sidebar-settings"]', labelKey: "onboarding.targets.settings" },
      ],
      titleKey: "onboarding.steps.proxyConfigTitle",
      instructionKeys: ["onboarding.steps.proxyConfigBody", "onboarding.steps.proxySaveInstruction"],
      resultKey: "onboarding.steps.proxyConfigResult",
      missingTargetKey: "onboarding.missing.proxy",
      exampleKey: "onboarding.examples.proxy",
      action: {
        kind: "openSettings",
        page: "proxy",
        labelKey: "onboarding.actions.openProxySettings",
      },
    },
  ],
  selfUpdate: [
    {
      id: "self-update-review",
      targets: [
        { selector: '[data-onboarding-target="self-update-details"]', labelKey: "onboarding.targets.selfUpdateDetails", interaction: "open", actionLabelKey: "onboarding.actions.reviewUpdate" },
        { selector: '[data-onboarding-target="self-update-status"]', labelKey: "onboarding.targets.selfUpdateStatus", interaction: "focus", actionLabelKey: "onboarding.actions.goToUpdate" },
      ],
      titleKey: "onboarding.steps.selfUpdateReviewTitle",
      instructionKeys: ["onboarding.steps.selfUpdateReviewBody"],
      resultKey: "onboarding.steps.selfUpdateReviewResult",
      missingTargetKey: "onboarding.missing.selfUpdateStatus",
      action: { kind: "openSettings", page: "update", labelKey: "onboarding.actions.openLiveUpdateSettings" },
    },
    {
      id: "self-update-request",
      targets: [{ selector: '[data-onboarding-target="self-update-status"]', labelKey: "onboarding.targets.selfUpdateStatus", interaction: "focus", actionLabelKey: "onboarding.actions.goToUpdate" }],
      titleKey: "onboarding.steps.selfUpdateRequestTitle",
      instructionKeys: ["onboarding.steps.selfUpdateRequestBody", "onboarding.steps.selfUpdateProgressInstruction"],
      resultKey: "onboarding.steps.selfUpdateRequestResult",
      missingTargetKey: "onboarding.missing.selfUpdateStatus",
      noteKey: "onboarding.steps.selfUpdateStatusRequirement",
      action: { kind: "openSettings", page: "update", labelKey: "onboarding.actions.openLiveUpdateSettings" },
    },
    {
      id: "self-update-workspace",
      targets: [{ selector: '[data-onboarding-target="self-update-build"]', labelKey: "onboarding.targets.selfUpdateBuild", interaction: "focus", actionLabelKey: "onboarding.actions.goToBuild" }],
      titleKey: "onboarding.steps.selfUpdateWorkspaceTitle",
      instructionKeys: ["onboarding.steps.selfUpdateWorkspaceBody", "onboarding.steps.selfUpdateTriggerInstruction"],
      resultKey: "onboarding.steps.selfUpdateWorkspaceResult",
      missingTargetKey: "onboarding.missing.selfUpdate",
      noteKey: "onboarding.steps.selfUpdateRequirement",
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
      targets: [COMPOSER_INPUT],
      titleKey: "onboarding.steps.handoffCommandTitle",
      instructionKeys: ["onboarding.steps.handoffCommandBody", "onboarding.steps.handoffSendInstruction"],
      resultKey: "onboarding.steps.handoffCommandResult",
      missingTargetKey: "onboarding.missing.composer",
      exampleKey: "onboarding.examples.handoff",
      noteKey: "onboarding.steps.handoffRequirement",
    },
  ],
  sidechat: [
    {
      id: "sidechat-overview",
      targets: [{ selector: '[data-onboarding-target="sidechat-toggle"]', labelKey: "onboarding.targets.sidechat", interaction: "open", actionLabelKey: "onboarding.actions.openSidechat" }],
      titleKey: "onboarding.steps.sidechatTitle",
      instructionKeys: ["onboarding.steps.sidechatBody", "onboarding.steps.sidechatSendInstruction"],
      resultKey: "onboarding.steps.sidechatResult",
      missingTargetKey: "onboarding.sidechatUnavailable",
    },
  ],
  btw: [
    {
      id: "btw-overview",
      targets: [COMPOSER_INPUT],
      titleKey: "onboarding.steps.btwTitle",
      instructionKeys: ["onboarding.steps.btwBody"],
      resultKey: "onboarding.steps.btwResult",
      missingTargetKey: "onboarding.missing.composer",
      exampleKey: "onboarding.examples.btw",
      noteKey: "onboarding.steps.btwRequirement",
    },
  ],
  imageAnnotation: [
    {
      id: "image-annotation-overview",
      targets: [
        { selector: '[data-onboarding-target="image-preview"]', labelKey: "onboarding.targets.imagePreview", interaction: "open", actionLabelKey: "onboarding.actions.openImage" },
        COMPOSER_INPUT,
      ],
      titleKey: "onboarding.steps.imageAnnotationTitle",
      instructionKeys: ["onboarding.steps.imageAnnotationBody", "onboarding.steps.imageAnnotationDrawInstruction", "onboarding.steps.imageAnnotationSendInstruction"],
      resultKey: "onboarding.steps.imageAnnotationResult",
      missingTargetKey: "onboarding.missing.composer",
    },
  ],
  assistantNotices: [
    {
      id: "assistant-notices-overview",
      targets: [{ selector: '[data-onboarding-target="assistant-notices"]', labelKey: "onboarding.targets.notices", interaction: "open", actionLabelKey: "onboarding.actions.openNotices" }],
      titleKey: "onboarding.steps.assistantNoticesTitle",
      instructionKeys: ["onboarding.steps.assistantNoticesBody", "onboarding.steps.assistantNoticesSaveInstruction"],
      resultKey: "onboarding.steps.assistantNoticesResult",
      missingTargetKey: "onboarding.missing.notices",
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
      targets: [COMPOSER_INPUT],
      titleKey: "onboarding.steps.intelligenceUiTitle",
      instructionKeys: ["onboarding.steps.intelligenceUiBody", "onboarding.steps.intelligenceUiContinueInstruction"],
      resultKey: "onboarding.steps.intelligenceUiResult",
      missingTargetKey: "onboarding.missing.composer",
      exampleKey: "onboarding.examples.intelligenceUi",
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
