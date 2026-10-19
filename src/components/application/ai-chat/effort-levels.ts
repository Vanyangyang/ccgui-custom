export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** The six effort choices, in Codex Astra catalog order. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const CLAUDE_EFFORT_LEVELS: readonly EffortLevel[] = [
  "low", "medium", "high", "xhigh", "max",
];

const AGY_EFFORT_LEVELS: readonly EffortLevel[] = [
  "low", "medium", "high",
];

export function getEffortLevels(engineId: string): readonly EffortLevel[] {
  if (engineId === "claude") return CLAUDE_EFFORT_LEVELS;
  if (engineId === "agy") return AGY_EFFORT_LEVELS;
  return EFFORT_LEVELS;
}

export function getDefaultEffort(engineId: string): EffortLevel {
  return engineId === "claude" ? "xhigh" : "medium";
}

/** Older Claude selections used ultra for the highest effort stop; AGY models only support low/medium/high. */
export function normalizeEffortLevel<T extends string | null | undefined>(
  engineId: string,
  effort: T,
): T | "max" | "high" {
  if (engineId === "claude" && effort === "ultra") return "max";
  if (engineId === "agy" && (effort === "xhigh" || effort === "max" || effort === "ultra")) return "high";
  return effort;
}

/** i18n label key per effort stop. */
export const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
  ultra: "chat.effortUltra",
};

/** Engines known to support reasoning effort configuration (all supported engines). */
export const EFFORT_SUPPORTED_ENGINES: Record<string, boolean> = {
  claude: true,
  codex: true,
  omp: true,
  pi: true,
  agy: true,
  qoder: true,
  "qoder-cn": true,
  cursor: false,
  grok: true,
  opencode: true,
  kimi: true,
  dsh: true,
};

export function supportsEffort(
  engineId: string,
  engines?: { id: string; supportsEffort?: boolean }[],
): boolean {
  const found = engines?.find((e) => e.id === engineId);
  if (found && typeof found.supportsEffort === "boolean") {
    return found.supportsEffort;
  }
  return Boolean(EFFORT_SUPPORTED_ENGINES[engineId] ?? true);
}
