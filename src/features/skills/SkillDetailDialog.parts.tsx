/**
 * Presentation pieces for the skill detail dialog: header, properties,
 * activity stats, per-engine sync switches, SKILL.md area and the footer
 * actions. The dialog itself only owns the content fetch and composition.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { MarkdownPreview } from "@/features/files/MarkdownPreview";
import { openExternal } from "@/lib/platform";
import { cx } from "@/utils/cx";
import { SourceBadge } from "./components";
import type {
  SkillRow,
  SkillSourceKind,
  SkillTargetId,
  SkillTargetInfo,
  SkillUsageEntry,
} from "./types";
import { daysSince } from "./utils";

export interface SkillContentState {
  path: string;
  markdown: string;
  truncated: boolean;
}

function PropertyRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-body-2-regular text-text-secondary">{label}</span>
      <span className="min-w-0 text-right text-body-2-regular text-text-primary">{children}</span>
    </div>
  );
}

/** Recency dot for "上次使用": fresh (≤7d) accent, fading (≤30d) warning,
 *  never / stale neutral — at-a-glance "do I still use this", always with the
 *  relative text next to it so the color is not the only signal. */
function freshnessTone(days: number | null): string {
  if (days == null) return "bg-background-tertiary-hover ring-1 ring-separator-border";
  if (days <= 7) return "bg-accent-500";
  if (days <= 30) return "bg-status-warning-background";
  return "bg-background-tertiary-hover ring-1 ring-separator-border";
}

/** "上次使用" copy: never used, today, N days ago, or N months ago. */
function lastUsedLabel(t: TFunction, usage?: SkillUsageEntry | null): string {
  if (usage?.lastUsedAt == null) return t("skills.detail.neverUsed");
  const days = daysSince(usage.lastUsedAt);
  if (days == null) return t("skills.detail.neverUsed");
  if (days <= 0) return t("skills.usage.today");
  if (days < 30) return t("skills.usage.daysAgo", { days });
  return t("skills.usage.monthsAgo", { months: Math.max(1, Math.floor(days / 30)) });
}

/** Name, source badge and directory. */
export function DetailHeader({ skill }: { skill: SkillRow }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-title-3-medium text-text-primary" title={skill.name}>
          {skill.name}
        </h3>
        <div className="mt-1 flex items-center gap-2">
          <SourceBadge skill={skill} />
          <span
            className="truncate text-caption-1-regular text-text-tertiary"
            title={skill.directory}
          >
            {skill.directory}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Repository link, directory and per-engine copy paths. */
export function DetailProperties({ skill }: { skill: SkillRow }) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 rounded-2lg border border-separator-border px-3 py-1">
      {skill.repoOwner && skill.repoName ? (
        <PropertyRow label={t("skills.detail.repository")}>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent-600 hover:underline"
            onClick={() =>
              skill.readmeUrl ? openExternal(skill.readmeUrl) : undefined
            }
          >
            {skill.repoOwner}/{skill.repoName}
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        </PropertyRow>
      ) : null}
      <PropertyRow label={t("skills.detail.directory")}>
        <span className="break-all font-mono text-caption-1-regular">{skill.directory}</span>
      </PropertyRow>
      {skill.targetPaths && Object.keys(skill.targetPaths).length > 0 ? (
        <PropertyRow label={t("skills.detail.paths")}>
          <span className="flex flex-col gap-0.5">
            {Object.entries(skill.targetPaths).map(([key, value]) => (
              <span key={`${key}:${value}`} className="break-all font-mono text-caption-1-regular">
                {value}
              </span>
            ))}
          </span>
        </PropertyRow>
      ) : null}
    </div>
  );
}

/** Invocation count + last-used recency; a failed stats load is shown as "—"
 *  with a note, never as a fabricated "never used". */
export function SkillActivitySection({
  usage,
  usageLoading,
  usageError,
}: {
  usage?: SkillUsageEntry | null;
  usageLoading?: boolean;
  usageError?: string | null;
}) {
  const { t } = useTranslation();
  const usageUnavailable = Boolean(usageError);
  const invocations = usage?.invocations ?? 0;
  const lastUsedDays = daysSince(usage?.lastUsedAt);
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <p className="text-body-2-medium text-text-primary">{t("skills.detail.activity")}</p>
      <div className="rounded-2lg border border-separator-border px-3 py-1">
        <PropertyRow label={t("skills.detail.invocations")}>
          <span className="tabular-nums">
            {usageLoading || usageUnavailable ? "—" : invocations}
          </span>
        </PropertyRow>
        <PropertyRow label={t("skills.detail.lastUsed")}>
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cx("size-1.5 rounded-full", freshnessTone(lastUsedDays))}
              aria-hidden
            />
            {usageLoading
              ? t("skills.detail.activityLoading")
              : usageUnavailable
                ? "—"
                : lastUsedLabel(t, usage)}
          </span>
        </PropertyRow>
      </div>
      {usageUnavailable ? (
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.detail.usageUnavailable")}
        </p>
      ) : !usageLoading && invocations === 0 ? (
        <p className="text-caption-1-regular text-text-tertiary">{t("skills.detail.unusedHint")}</p>
      ) : null}
      <p className="text-caption-1-regular text-text-tertiary">{t("skills.usage.scope")}</p>
    </div>
  );
}

/** Per-engine sync switches ("同步到"). */
export function SkillTargetsSection({
  skill,
  engineTargets,
  hiddenEngineCount,
  readonly,
  kind,
  pending,
  busyTarget,
  onToggleTarget,
}: {
  skill: SkillRow;
  engineTargets: SkillTargetInfo[];
  hiddenEngineCount: number;
  readonly: boolean;
  kind: SkillSourceKind;
  pending: boolean;
  busyTarget?: string | null;
  onToggleTarget: (targetId: SkillTargetId, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <p className="text-body-2-medium text-text-primary">{t("skills.detail.syncTo")}</p>
      {/* 13 targets × 2rem would push the footer out of the dialog on its own;
          the list scrolls in place instead. */}
      <div className="flex max-h-[13rem] flex-col gap-0.5 overflow-y-auto pr-1">
        {engineTargets.map((target) => {
          const state = skill.targetStates?.[target.id] ?? "off";
          const busy = busyTarget === target.id;
          // 未纳管的本地技能：已存在的副本是用户自己的目录，不能在这里取消。
          const locked = !skill.managed && state === "synced";
          return (
            <label
              key={target.id}
              title={locked ? t("skills.row.localCopyLocked") : undefined}
              className={cx(
                "flex items-center gap-2 rounded-md px-1 py-0.5",
                !readonly && !pending && !locked && "cursor-pointer hover:bg-background-tertiary-default",
              )}
            >
              <Checkbox
                size="sm"
                isSelected={state === "synced"}
                isDisabled={readonly || pending || busy || locked}
                onChange={(next) => onToggleTarget(target.id as SkillTargetId, next)}
              >
                <span className="flex items-center gap-2">
                  <EngineIcon engine={target.id} size={16} />
                  {target.label}
                </span>
              </Checkbox>
              <span className="ml-auto flex items-center gap-1.5 text-caption-1-regular text-text-tertiary">
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {t(`skills.targetStateShort.${state}`)}
              </span>
            </label>
          );
        })}
      </div>
      {hiddenEngineCount > 0 ? (
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.detail.hiddenEngines", { count: hiddenEngineCount })}
        </p>
      ) : null}
      {readonly ? (
        <p className="text-caption-1-regular text-text-tertiary">
          {t(`skills.readonly.${kind}`)}
        </p>
      ) : null}
      {!skill.managed && !readonly ? (
        <p className="text-caption-1-regular text-text-tertiary">
          {t("skills.detail.promoteHint")}
        </p>
      ) : null}
    </div>
  );
}

/** SKILL.md area: its own bounded scroll so one long file cannot push the
 *  sync switches out of sight. */
export function SkillContentSection({
  loading,
  contentError,
  content,
  onReload,
}: {
  loading: boolean;
  contentError: string | null;
  content: SkillContentState | null;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-h-[6rem] max-h-[20rem] shrink-0 overflow-y-auto rounded-2lg border border-separator-border p-3">
      {loading ? (
        <p className="flex items-center gap-2 text-body-2-regular text-text-secondary">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("skills.detail.contentLoading")}
        </p>
      ) : contentError ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-body-2-regular text-text-error-primary">
            {contentError}
          </p>
          <Button variant="secondary" size="xs" onClick={onReload}>
            {t("common.refresh")}
          </Button>
        </div>
      ) : content ? (
        <div className="text-body-2-regular">
          <MarkdownPreview path={content.path} draft={content.markdown} />
          {content.truncated ? (
            <p className="mt-2 text-caption-1-regular text-text-tertiary">
              {t("skills.detail.contentTruncated")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Destructive + update + import actions pinned under the scroll body. */
export function DetailFooter({
  skill,
  readonly,
  pending,
  hasUpdate,
  onUninstall,
  onDeleteLocal,
  onImport,
  onTriggerUpdate,
  onClose,
}: {
  skill: SkillRow;
  readonly: boolean;
  pending: boolean;
  hasUpdate: boolean;
  onUninstall: (skill: SkillRow) => void;
  onDeleteLocal: (skill: SkillRow) => void;
  onImport: (skill: SkillRow) => void;
  onTriggerUpdate: (skill: SkillRow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div>
        {skill.managed ? (
          <Button
            variant="secondary"
            size="small"
            leadingIcon={Trash2}
            className="w-full justify-center text-text-error-primary"
            disabled={pending}
            onClick={() => onUninstall(skill)}
          >
            {t("skills.detail.removeAll")}
          </Button>
        ) : !readonly ? (
          <Button
            variant="secondary"
            size="small"
            leadingIcon={Trash2}
            className="w-full justify-center text-text-error-primary"
            disabled={pending}
            onClick={() => onDeleteLocal(skill)}
          >
            {t("skills.detail.removeAll")}
          </Button>
        ) : null}
        {!readonly ? (
          <p className="mt-1 text-center text-caption-1-regular text-text-tertiary">
            {t("skills.detail.removeAllHint")}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          {!skill.managed && !readonly ? (
            <Button
              variant="secondary"
              size="small"
              disabled={pending}
              onClick={() => onImport(skill)}
            >
              {t("skills.actions.import")}
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          {hasUpdate ? (
            <Button
              variant="primary"
              size="small"
              disabled={pending}
              onClick={() => onTriggerUpdate(skill)}
            >
              {t("skills.actions.update")}
            </Button>
          ) : null}
          <Button variant="secondary" size="small" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
