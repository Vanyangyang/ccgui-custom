/**
 * Shared bits for the Skills panes: source/sync badges, feedback banner and
 * small formatting helpers. Pure display — no data loading here.
 */
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Check from "lucide-react/dist/esm/icons/check";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import type { SkillRow, SkillSourceKind, SkillTargetId, SkillTargetInfo } from "./types";
import { hasOrphanCopy, copiedTargets, sourceKindOf } from "./utils";

const BADGE_BASE =
  "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1";

const SOURCE_TONE: Record<SkillSourceKind, string> = {
  managed: "bg-accent-50 text-accent-700 ring-accent-200 dark:bg-accent-950/40 dark:text-accent-300 dark:ring-accent-800/60",
  local: "bg-background-tertiary-default text-text-secondary ring-separator-border",
  builtin: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/60",
  system: "bg-background-tertiary-default text-text-secondary ring-separator-border",
  plugin: "bg-background-tertiary-default text-text-secondary ring-separator-border",
};

export function SourceBadge({ skill }: { skill: SkillRow }) {
  const { t } = useTranslation();
  const kind = sourceKindOf(skill);
  return (
    <span className={cx(BADGE_BASE, SOURCE_TONE[kind])} data-source-kind={kind}>
      {t(`skills.source.${kind}`)}
    </span>
  );
}

/** One clickable engine icon for a target that holds a copy: full color =
 *  present, amber corner badge = the copy is missing (orphan, clicking
 *  re-syncs it). Clicking a synced icon removes that engine's copy (a local
 *  skill's own directory is adopted first instead, and cannot be removed).
 *  These buttons are siblings of the row button, so opening the detail panel
 *  stays a separate gesture.
 *
 *  A locked copy (a local skill's own directory) is disabled without dimming:
 *  the icon still means "a copy lives here", and a half-transparent mark reads
 *  as missing/broken instead. The cursor and `title` carry the "can't toggle"
 *  part; opacity is reserved for in-flight work. */
function TargetEngineButton({
  skill,
  target,
  busy,
  disabled,
  onToggleTarget,
}: {
  skill: SkillRow;
  target: SkillTargetInfo;
  busy: boolean;
  disabled: boolean;
  onToggleTarget?: (skill: SkillRow, targetId: SkillTargetId, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const state = skill.targetStates?.[target.id] ?? "off";
  const label = t(`skills.targetState.${state}`, { engine: target.label });
  // 未纳管的本地技能：已有副本是用户自己的目录，应用不会删除它。禁用“取消”
  // 比先报成功、刷新后又看到副本更诚实（后端也不会删它）。
  const locked = skill.managed !== true && state === "synced";
  return (
    <button
      type="button"
      title={locked ? `${label} · ${t("skills.row.localCopyLocked")}` : label}
      aria-label={label}
      aria-pressed={state === "synced"}
      data-target={target.id}
      data-target-state={state}
      disabled={disabled || busy || locked || !onToggleTarget}
      onClick={() => onToggleTarget?.(skill, target.id as SkillTargetId, state !== "synced")}
      className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-background-tertiary-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <span className="flex size-4 items-center justify-center" aria-hidden>
          <EngineIcon engine={target.id} size={16} />
        </span>
      )}
      {state === "orphan" && !busy ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-text-error-primary ring-2 ring-background-primary"
          aria-hidden
        />
      ) : null}
    </button>
  );
}

export function TargetEngines({
  skill,
  targets,
  busyTarget,
  disabled,
  onToggleTarget,
}: {
  skill: SkillRow;
  targets: SkillTargetInfo[];
  /** Target id whose toggle is in flight for *this* skill. */
  busyTarget?: string | null;
  /** Row-level in-flight state (another action on the same row). */
  disabled?: boolean;
  onToggleTarget?: (skill: SkillRow, targetId: SkillTargetId, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  // 只展示真有副本（含副本丢失）的引擎：加引擎在详情面板里做，行内不铺一地
  // 淡图标。
  const relevant = copiedTargets(skill, targets);
  if (relevant.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center justify-end gap-0.5">
      <span
        role="group"
        aria-label={t("skills.row.engines", { name: skill.name })}
        className="flex flex-wrap items-center justify-end gap-0.5"
      >
        {relevant.map((target) => (
          <TargetEngineButton
            key={target.id}
            skill={skill}
            target={target}
            busy={busyTarget === target.id}
            disabled={disabled === true || skill.readonly === true}
            onToggleTarget={onToggleTarget}
          />
        ))}
      </span>
      {hasOrphanCopy(skill) ? (
        <span className="text-[10px] text-text-error-primary">{t("skills.orphanHint")}</span>
      ) : null}
    </span>
  );
}

export type Feedback = { tone: "success" | "error" | "pending"; text: string } | null;

/** Inline status line under a pane header: spinner / check / alert + text. */
export function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  const Icon =
    feedback.tone === "pending" ? Loader2 : feedback.tone === "success" ? Check : TriangleAlert;
  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={cx(
        "flex items-center gap-1.5 text-body-2-regular",
        feedback.tone === "error" ? "text-text-error-primary" : "text-text-secondary",
      )}
    >
      <Icon
        className={cx("size-4 shrink-0", feedback.tone === "pending" && "animate-spin")}
        aria-hidden
      />
      {feedback.text}
    </p>
  );
}


