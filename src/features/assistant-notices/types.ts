export interface AssistantNoticeSource {
  engine: string;
  sessionId: string;
  workspacePath: string;
  label: string;
}

export interface AssistantNoticeObserver {
  engine: string;
  model: string;
  effort: string;
}

export interface AssistantNotice {
  id: string;
  kind: "completion" | "aside";
  source: AssistantNoticeSource;
  observer?: AssistantNoticeObserver;
  turnId: string;
  createdAtMs: number;
  startedAtMs: number;
  tease: string;
  body: string;
  pinned: boolean;
  expiresAtMs: number | null;
  read: boolean;
}

export interface AssistantNoticesConfig {
  enabled: boolean;
  observerEnabled: boolean;
  paused: boolean;
  focusMode: boolean;
  voiceEnabled: boolean;
  displayTarget: { mode: "active" } | { mode: "fixed"; id: string; label: string };
  bodyTextPercent: number;
  titleTextPercent: number;
  interfaceTextPercent: number;
  observerEngine: string;
  observerModel: string;
  observerEffort: string;
}

export interface AssistantNoticeDisplay { id: string; label: string; width: number; height: number; primary: boolean }

export interface AssistantNoticesStatus extends AssistantNoticesConfig {
  available: boolean;
  observerAvailable: boolean;
  reason: string;
  model: string;
  effort: string;
  provider: string;
  voiceAvailable: boolean;
  sourceEngines: string[];
  revision: number;
}
