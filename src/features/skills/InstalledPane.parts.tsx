/**
 * Presentation pieces for 我的 Skills (InstalledPane): toolbar, engine filter
 * chips, count line, skill row, list area and the destructive-confirm dialog.
 * Kept in a separate file so both this and the pane stay readable.
 */
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { ModalShell } from "@/components/dialogs";
import {
  ActionFeedbackIcon,
  type ActionFeedback,
} from "@/components/base/action-feedback";
import { Chip } from "@/components/base/chips/chip";
import { cx } from "@/utils/cx";
import { SourceBadge, TargetEngines } from "./components";
import type { SkillRow, SkillTargetId, SkillTargetInfo } from "./types";

/** The update map is keyed by skill id; local entries (unmanaged) never have
 * upstream updates. */
export type UpdateMap = Record<string, boolean>;

/** Engine toggle currently in flight: only that row's icon is disabled. */
export type BusyTarget = { skillId: string; targetId: string };

export type ConfirmState =
  | { kind: "uninstall"; skill: SkillRow }
  | { kind: "deleteLocal"; skill: SkillRow }
  | { kind: "overwrite"; skill: SkillRow };

/** Search + refresh + import toolbar. */
export function InstalledToolbar({
  query,
  onQueryChange,
  loading,
  refreshFeedback,
  onRefresh,
  onOpenImport,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  loading: boolean;
  refreshFeedback: ActionFeedback;
  onRefresh: () => void;
  onOpenImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t("skills.searchPlaceholder")}
        placeholder={t("skills.searchPlaceholder")}
        value={query}
        onChange={onQueryChange}
        leadingIcon={Search}
        size="small"
        className="flex-1"
      />
      <Button
        variant="secondary"
        size="small"
        disabled={loading || refreshFeedback === "running"}
        onClick={onRefresh}
      >
        <ActionFeedbackIcon icon={RefreshCw} feedback={refreshFeedback} spin />
        {t("skills.refresh")}
      </Button>
      <Button
        variant="secondary"
        size="small"
        leadingIcon={Plus}
        disabled={loading}
        onClick={onOpenImport}
      >
        {t("skills.actions.importLocal")}
      </Button>
    </div>
  );
}

/** Engine filter chips (installed engines plus engines with copies). */
export function EngineFilterChips({
  chips,
  value,
  onChange,
}: {
  chips: SkillTargetInfo[];
  value: SkillTargetId | "";
  onChange: (value: SkillTargetId | "") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip selected={value === ""} onClick={() => onChange("")}>
        {t("skills.filter.allEngines")}
      </Chip>
      {chips.map((target) => (
        <Chip
          key={target.id}
          selected={value === target.id}
          onClick={() => onChange(target.id as SkillTargetId)}
          title={target.path}
        >
          <span className="flex items-center gap-1">
            <EngineIcon engine={target.id} size={12} />
            {target.label}
          </span>
        </Chip>
      ))}
    </div>
  );
}

/** Result count with the pending-updates badge. */
export function InstalledCountLine({
  shown,
  total,
  updateCount,
}: {
  shown: number;
  total: number;
  updateCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-caption-1-regular text-text-tertiary">
        {t("skills.count", { count: shown, total })}
      </p>
      {updateCount > 0 ? (
        <p className="text-caption-1-regular text-accent-600">
          {t("skills.updatesAvailable", { count: updateCount })}
        </p>
      ) : null}
    </div>
  );
}

/** One installed skill row: open-detail button + engine strip + update. */
function SkillRowItem({
  skill,
  targets,
  pending,
  busyTarget,
  hasUpdate,
  onOpen,
  onToggleTarget,
  onUpdate,
}: {
  skill: SkillRow;
  targets: SkillTargetInfo[];
  pending: boolean;
  busyTarget: string | null;
  hasUpdate: boolean;
  onOpen: () => void;
  onToggleTarget: (skill: SkillRow, targetId: SkillTargetId, enabled: boolean) => void;
  onUpdate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <div
        className={cx(
          "flex w-full items-center gap-2 rounded-2lg border border-separator-border px-3 py-2 transition-colors",
          pending && "opacity-60",
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("skills.row.open", { name: skill.name })}
          className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <span className="flex w-full items-center gap-2">
            <span className="truncate text-body-regular text-text-primary" title={skill.name}>
              {skill.name}
            </span>
            <SourceBadge skill={skill} />
          </span>
          <span className="w-full truncate text-caption-1-regular text-text-secondary">
            {skill.description || skill.directory}
          </span>
        </button>
        <TargetEngines
          skill={skill}
          targets={targets}
          busyTarget={busyTarget}
          disabled={pending}
          onToggleTarget={onToggleTarget}
        />
        {hasUpdate ? (
          <Button variant="primary" size="xs" disabled={pending} onClick={onUpdate}>
            {t("skills.actions.update")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** List area: first-load spinner, error, empty state, or the rows. Error and
 *  loading win over the empty state so a failed refresh is never silent. */
export function InstalledListArea({
  loading,
  error,
  filtered,
  totalSkills,
  updates,
  busySkillId,
  busyTargetId,
  pendingIds,
  targets,
  onRefresh,
  onBrowse,
  onOpen,
  onToggleTarget,
  onUpdate,
}: {
  loading: boolean;
  error: string | null;
  filtered: SkillRow[];
  totalSkills: number;
  updates: UpdateMap;
  busySkillId: string | null;
  busyTargetId: string | null;
  pendingIds: ReadonlySet<string>;
  targets: SkillTargetInfo[];
  onRefresh: () => void;
  onBrowse: () => void;
  onOpen: (skill: SkillRow) => void;
  onToggleTarget: (skill: SkillRow, targetId: SkillTargetId, enabled: boolean) => void;
  onUpdate: (skill: SkillRow) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return <CenteredSpinner className="py-10" />;
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 py-6">
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {error}
        </p>
        <Button variant="secondary" size="small" onClick={onRefresh}>
          {t("common.refresh")}
        </Button>
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <EmptyState className="flex-col gap-2 py-10 text-center">
        <p className="text-body-2-regular">
          {totalSkills === 0 ? t("skills.empty.none") : t("skills.empty.filtered")}
        </p>
        {totalSkills === 0 ? (
          <Button variant="secondary" size="small" onClick={onBrowse}>
            {t("skills.empty.browse")}
          </Button>
        ) : null}
      </EmptyState>
    );
  }
  return (
    <ul className="flex w-full flex-col gap-1">
      {filtered.map((skill) => (
        <SkillRowItem
          key={skill.id}
          skill={skill}
          targets={targets}
          pending={pendingIds.has(skill.id) || pendingIds.has(skill.directory)}
          busyTarget={busySkillId === skill.id ? busyTargetId : null}
          hasUpdate={Boolean(updates[skill.id])}
          onOpen={() => onOpen(skill)}
          onToggleTarget={onToggleTarget}
          onUpdate={() => onUpdate(skill)}
        />
      ))}
    </ul>
  );
}

/** Bulk uninstall / local-delete / overwrite confirmation. */
export function SkillConfirmDialog({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: ConfirmState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell
      onClose={onCancel}
      label={t("skills.confirm.title")}
      className="w-[420px] max-w-[92vw]"
      dialogClassName="flex flex-col gap-3"
    >
      <h3 className="text-title-3-medium text-text-primary">
        {confirm.kind === "uninstall"
          ? t("skills.confirm.uninstallTitle", { name: confirm.skill.name })
          : confirm.kind === "deleteLocal"
            ? t("skills.confirm.deleteTitle", { name: confirm.skill.name })
            : t("skills.confirm.overwriteTitle", { name: confirm.skill.name })}
      </h3>
      <p className="text-body-2-regular text-text-secondary">
        {confirm.kind === "uninstall"
          ? t("skills.confirm.uninstallBody")
          : confirm.kind === "deleteLocal"
            ? t("skills.confirm.deleteBody")
            : t("skills.confirm.overwriteBody")}
      </p>
      {confirm.kind === "deleteLocal" && confirm.skill.targetPaths ? (
        <ul className="flex flex-col gap-1 rounded-2lg bg-background-tertiary-default p-2">
          {Object.values(confirm.skill.targetPaths).map((path) => (
            <li
              key={path}
              className="break-all font-mono text-caption-1-regular text-text-secondary"
            >
              {path}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="small" onClick={onConfirm}>
          {confirm.kind === "overwrite"
            ? t("skills.confirm.overwriteConfirm")
            : t("common.confirm")}
        </Button>
      </div>
    </ModalShell>
  );
}
