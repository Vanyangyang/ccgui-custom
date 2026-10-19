/**
 * Pure helpers for the Skills page: source classification, filtering and
 * per-target result summaries. Kept free of React and IPC so the rules are
 * unit-testable.
 */
import type {
  SkillRow,
  SkillSourceKind,
  SkillTargetId,
  SkillTargetInfo,
  SkillTargetResult,
  SkillUsageEntry,
  SkillUsageResult,
} from "./types";

/** Legacy payloads (and manage-only entries) carry `managed` but no
 *  `sourceKind`; never show `undefined` as a source badge. */
export function sourceKindOf(skill: Pick<SkillRow, "managed" | "sourceKind">): SkillSourceKind {
  if (skill.sourceKind) return skill.sourceKind;
  return skill.managed ? "managed" : "local";
}

export interface SkillFilter {
  query: string;
  /** "" = all engines. */
  target: SkillTargetId | "";
}

export function filterSkills(skills: SkillRow[], filter: SkillFilter): SkillRow[] {
  const needle = filter.query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filter.target) {
      const state = skill.targetStates?.[filter.target] ?? "off";
      if (state === "off") return false;
    }
    if (needle) {
      const haystack = `${skill.name}\n${skill.description}\n${skill.directory}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Managed entries first (the app owns them), then by name — stable across
 *  refreshes because the backend already sorts by name. */
export function sortSkills(skills: SkillRow[]): SkillRow[] {
  return [...skills].sort((a, b) => {
    const aManaged = sourceKindOf(a) === "managed" ? 0 : 1;
    const bManaged = sourceKindOf(b) === "managed" ? 0 : 1;
    if (aManaged !== bManaged) return aManaged - bManaged;
    return a.name.localeCompare(b.name);
  });
}

/** Engines the row icon strip shows: only the ones that actually hold a copy
 *  (or lost one). Adding an engine happens in the detail panel — a row stays a
 *  state readout, instead of painting 13 faded icons on every one of hundreds
 *  of rows. */
export function copiedTargets(
  skill: SkillRow,
  targets: SkillTargetInfo[],
): SkillTargetInfo[] {
  return targets.filter(
    (target) => (skill.targetStates?.[target.id] ?? "off") !== "off",
  );
}

/** Engines the detail panel's "同步到" list offers: installed CLIs plus any
 *  engine that already holds a copy (or a missing copy) — an uninstalled CLI
 *  must not hide the cleanup path for its stale copy. */
export function relevantTargets(
  skill: SkillRow,
  targets: SkillTargetInfo[],
): SkillTargetInfo[] {
  return targets.filter((target) => {
    if (target.available !== false) return true;
    return (skill.targetStates?.[target.id] ?? "off") !== "off";
  });
}

/** Engine filter chips: the same rule as the row strip, applied to the whole
 *  list, so filtering by an uninstalled CLI's leftovers still works. */
export function visibleEngines(
  skills: SkillRow[],
  targets: SkillTargetInfo[],
): SkillTargetInfo[] {
  const inUse = new Set<string>();
  for (const skill of skills) {
    for (const [targetId, state] of Object.entries(skill.targetStates ?? {})) {
      if (state !== "off") inUse.add(targetId);
    }
  }
  return targets.filter((target) => target.available !== false || inUse.has(target.id));
}

/** The next target list after toggling one engine. The backend only reports
 *  `synced` targets in `targets`, so an orphan engine is enabled by adding it
 *  back and disabled only when a copy actually exists. */
export function nextTargets(
  skill: SkillRow,
  targetId: SkillTargetId,
  enabled: boolean,
): SkillTargetId[] {
  const current = skill.targets ?? [];
  if (enabled) return [...new Set([...current, targetId])];
  return current.filter((target) => target !== targetId);
}

/** Usage stats for one skill: the hub already joins transcript names onto
 *  installed skills (`skillId` / `directory`), so re-join on those keys and
 *  only fall back to a unique directory leaf. Ambiguous names stay unmatched
 *  instead of attributing another skill's calls. */
export function usageForSkill(
  usage: SkillUsageResult | null,
  skill: SkillRow,
): SkillUsageEntry | null {
  if (!usage) return null;
  const byId = usage.skills.find((entry) => entry.skillId === skill.id);
  if (byId) return byId;
  const directory = skill.directory.trim().toLowerCase();
  const byDirectory = usage.skills.find(
    (entry) => (entry.directory ?? "").trim().toLowerCase() === directory,
  );
  if (byDirectory) return byDirectory;
  const leaf = directory.split("/").filter(Boolean).pop();
  if (!leaf) return null;
  const byName = usage.skills.filter((entry) => entry.skill.trim().toLowerCase() === leaf);
  return byName.length === 1 ? byName[0] : null;
}

/** Whole days since an ISO timestamp, or null when it is absent/unparsable. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

export interface TargetResultSummary {
  allOk: boolean;
  failed: { target: string; error: string | null }[];
}

/** "全部同步完成" only when every target succeeded; a partial failure keeps
 *  the failed target visible instead of collapsing into a generic error. */
export function summarizeTargetResults(
  results: SkillTargetResult[] | undefined,
): TargetResultSummary {
  const failed = (results ?? [])
    .filter((result) => !result.ok)
    .map((result) => ({ target: result.target, error: result.error }));
  return { allOk: failed.length === 0, failed };
}

/** Which engine copies exist right now (`synced` only). */
export function syncedTargets(skill: SkillRow): SkillTargetId[] {
  return (skill.targets ?? []).filter(
    (target) => (skill.targetStates?.[target] ?? "synced") === "synced",
  );
}

export function hasOrphanCopy(skill: SkillRow): boolean {
  return Object.values(skill.targetStates ?? {}).some((state) => state === "orphan");
}

/** Longest matching root wins, so a nested root never shadows its parent.
 *  Moves an absolute directory picked by the user onto a known skills root. */
export function relativeToRoot(
  picked: string,
  targets: SkillTargetInfo[],
): { directory: string; target: SkillTargetInfo } | null {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = normalize(picked);
  let best: { directory: string; target: SkillTargetInfo } | null = null;
  for (const target of targets) {
    const root = normalize(target.path);
    if (!root) continue;
    if (normalized === root) continue;
    if (normalized.startsWith(`${root}/`)) {
      const directory = normalized.slice(root.length + 1);
      if (!best || root.length > normalize(best.target.path).length) {
        best = { directory, target };
      }
    }
  }
  return best;
}

/** Pre-selected engines for the import dialog: the two CLIs the hub has always
 *  defaulted to when they are installed, otherwise whichever installed engines
 *  exist. */
export function defaultTargets(offered: SkillTargetInfo[]): SkillTargetId[] {
  const preferred = offered
    .filter((target) => target.id === "claude" || target.id === "codex")
    .map((target) => target.id as SkillTargetId);
  if (preferred.length > 0) return preferred;
  return offered.slice(0, 1).map((target) => target.id as SkillTargetId);
}

/** Compact token count for the usage table (12.3k / 1.2M). */
export function formatTokens(value: number | null | undefined): string {
  const tokens = value ?? 0;
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
