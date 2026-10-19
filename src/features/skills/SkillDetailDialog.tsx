/**
 * Skill detail: metadata, per-engine sync ("同步到"), invocation activity and
 * the destructive actions. SKILL.md is fetched on open (never with the list),
 * so browsing hundreds of skills stays cheap; usage is passed in from the pane,
 * which loads it once per open panel.
 *
 * Presentation lives in `SkillDetailDialog.parts.tsx`; this file owns the
 * content fetch and the section composition.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { skillsHubApi } from "./api";
import {
  DetailFooter,
  DetailHeader,
  DetailProperties,
  SkillActivitySection,
  SkillContentSection,
  SkillTargetsSection,
  type SkillContentState,
} from "./SkillDetailDialog.parts";
import type {
  SkillRow,
  SkillTargetId,
  SkillTargetInfo,
  SkillUsageEntry,
} from "./types";
import { relevantTargets, sourceKindOf } from "./utils";

export function SkillDetailDialog({
  skill,
  targets,
  pending,
  busyTarget,
  usage,
  usageLoading,
  usageError,
  hasUpdate,
  onClose,
  onToggleTarget,
  onTriggerUpdate,
  onUninstall,
  onDeleteLocal,
  onImport,
}: {
  skill: SkillRow;
  targets: SkillTargetInfo[];
  pending: boolean;
  busyTarget?: string | null;
  usage?: SkillUsageEntry | null;
  usageLoading?: boolean;
  usageError?: string | null;
  hasUpdate: boolean;
  onClose: () => void;
  onToggleTarget: (skill: SkillRow, targetId: SkillTargetId, enabled: boolean) => void;
  onTriggerUpdate: (skill: SkillRow) => void;
  onUninstall: (skill: SkillRow) => void;
  onDeleteLocal: (skill: SkillRow) => void;
  onImport: (skill: SkillRow) => void;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<SkillContentState | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadContent = useCallback(async () => {
    const current = sequence.current + 1;
    sequence.current = current;
    const canCommit = () => mounted.current && sequence.current === current;
    setLoading(true);
    setContentError(null);
    try {
      const payload = await skillsHubApi.content(skill.directory);
      if (!canCommit()) return;
      setContent({
        path: payload.path,
        markdown: payload.markdown,
        truncated: payload.truncated,
      });
    } catch (error) {
      if (!canCommit()) return;
      setContent(null);
      setContentError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading((value) => (canCommit() ? false : value));
    }
  }, [skill.directory]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const readonly = skill.readonly === true;
  const kind = sourceKindOf(skill);
  // Only engines that are installed, or that already hold a copy, are offered.
  const engineTargets = relevantTargets(skill, targets);
  const hiddenEngineCount = targets.length - engineTargets.length;

  return (
    <ModalShell
      onClose={onClose}
      label={t("skills.detail.title", { name: skill.name })}
      className="flex max-h-[80vh] w-[560px] max-w-[94vw] flex-col"
      dialogClassName="flex min-h-0 flex-col gap-3"
    >
      <DetailHeader skill={skill} />

      {/* One scroll body for description → properties → activity → sync list:
          with a target list this long the sections must scroll together, or the
          footer (remove / update / close) ends up outside the dialog. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {skill.description ? (
          <p className="shrink-0 text-body-2-regular text-text-secondary">{skill.description}</p>
        ) : null}

        <DetailProperties skill={skill} />

        <SkillActivitySection
          usage={usage}
          usageLoading={usageLoading}
          usageError={usageError}
        />

        <SkillTargetsSection
          skill={skill}
          engineTargets={engineTargets}
          hiddenEngineCount={hiddenEngineCount}
          readonly={readonly}
          kind={kind}
          pending={pending}
          busyTarget={busyTarget}
          onToggleTarget={(targetId, enabled) => onToggleTarget(skill, targetId, enabled)}
        />

        <SkillContentSection
          loading={loading}
          contentError={contentError}
          content={content}
          onReload={() => void loadContent()}
        />
      </div>

      <DetailFooter
        skill={skill}
        readonly={readonly}
        pending={pending}
        hasUpdate={hasUpdate}
        onUninstall={onUninstall}
        onDeleteLocal={onDeleteLocal}
        onImport={onImport}
        onTriggerUpdate={onTriggerUpdate}
        onClose={onClose}
      />
    </ModalShell>
  );
}
