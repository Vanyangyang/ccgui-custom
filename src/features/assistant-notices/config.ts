import type { CSSProperties } from "react";
import type { AssistantNoticesConfig } from "./types";

export const defaultNoticeConfig: AssistantNoticesConfig = {
  enabled: true, observerEnabled: false, paused: false, focusMode: false,
  voiceEnabled: true, displayTarget: { mode: "active" },
  bodyTextPercent: 100, titleTextPercent: 100, interfaceTextPercent: 100,
  observerEngine: "agy_vertex", observerModel: "gemini-4-argon", observerEffort: "medium",
};

/** Explicitly exclude status metadata from writes. */
export function noticeConfig(value: AssistantNoticesConfig): AssistantNoticesConfig {
  const { enabled, observerEnabled, paused, focusMode, voiceEnabled, displayTarget,
    bodyTextPercent, titleTextPercent, interfaceTextPercent, observerEngine, observerModel, observerEffort } = value;
  return { enabled, observerEnabled, paused, focusMode, voiceEnabled, displayTarget,
    bodyTextPercent, titleTextPercent, interfaceTextPercent, observerEngine, observerModel, observerEffort };
}

type NoticeStyle = CSSProperties & Record<"--notice-body-scale" | "--notice-title-scale" | "--notice-interface-scale", number>;
export function noticeTextStyle(config: AssistantNoticesConfig | null): NoticeStyle {
  const scale = (value: number | undefined, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(80, value!)) / 100 : 1;
  return { "--notice-body-scale": scale(config?.bodyTextPercent, 300), "--notice-title-scale": scale(config?.titleTextPercent, 200), "--notice-interface-scale": scale(config?.interfaceTextPercent, 200) };
}

export function noticeConfigError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);
  return code.includes("config_conflict") ? "assistantNotices.configConflict" : "assistantNotices.settingsError";
}
