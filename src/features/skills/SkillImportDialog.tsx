/**
 * 导入本地技能: pick a directory (mapped back to a path relative to an engine
 * skills root), choose which engines get a managed copy, then import.
 *
 * The backend only accepts a relative directory inside a known skills root —
 * arbitrary filesystem paths never cross IPC. The picker maps an absolute
 * pick onto a root; anything else must be typed as a relative directory and
 * is still validated server-side.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { ModalShell } from "@/components/dialogs";
import { pickDirectory } from "@/lib/platform";
import type { SkillTargetId, SkillTargetInfo } from "./types";
import { defaultTargets, relativeToRoot } from "./utils";

export function SkillImportDialog({
  targets,
  busy,
  onClose,
  onImport,
}: {
  targets: SkillTargetInfo[];
  busy: boolean;
  onClose: () => void;
  onImport: (directory: string, engineTargets: SkillTargetId[]) => void;
}) {
  const { t } = useTranslation();
  // Installed CLI first: importing into an engine that is not installed would
  // write a copy nothing reads. A target that still holds a copy stays
  // selectable so its state can be corrected. (The backend accepts every id.)
  const offered = useMemo(
    () => targets.filter((target) => target.available !== false),
    [targets],
  );
  const offeredList = offered.length > 0 ? offered : targets;
  const [directory, setDirectory] = useState("");
  const [selected, setSelected] = useState<SkillTargetId[]>(() => defaultTargets(offeredList));
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const roots = useMemo(
    () => targets.map((target) => `${target.label}: ${target.path}`).join("\n"),
    [targets],
  );

  const pick = async () => {
    setPickerError(null);
    const picked = await pickDirectory(t("skills.import.pickTitle"));
    if (!picked) return;
    const mapped = relativeToRoot(picked, targets);
    if (!mapped) {
      setPickerError(t("skills.import.outsideRoots", { roots }));
      return;
    }
    setDirectory(mapped.directory);
  };

  const toggleTarget = (id: SkillTargetId, next: boolean) => {
    setSelected((previous) =>
      next
        ? [...new Set([...previous, id])]
        : previous.filter((target) => target !== id),
    );
  };

  const trimmed = directory.trim();
  const canImport = trimmed.length > 0 && selected.length > 0 && !busy;

  return (
    <ModalShell
      onClose={onClose}
      label={t("skills.import.title")}
      className="w-[420px] max-w-[92vw]"
      dialogClassName="flex flex-col gap-3"
    >
      <h3 className="text-title-3-medium text-text-primary">{t("skills.import.title")}</h3>
      <p className="text-body-2-regular text-text-secondary">{t("skills.import.desc")}</p>
      <div className="flex items-end gap-2">
        <Input
          aria-label={t("skills.import.directoryLabel")}
          label={t("skills.import.directoryLabel")}
          placeholder={t("skills.import.directoryPlaceholder")}
          value={directory}
          onChange={setDirectory}
          size="small"
          className="flex-1"
        />
        <Button variant="secondary" size="small" onClick={() => void pick()}>
          {t("skills.import.pick")}
        </Button>
      </div>
      {pickerError ? (
        <p role="alert" className="whitespace-pre-line text-caption-1-regular text-text-error-primary">
          {pickerError}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <p className="text-body-2-medium text-text-primary">{t("skills.import.targets")}</p>
        {offeredList.map((target) => (
          <Checkbox
            key={target.id}
            isSelected={selectedSet.has(target.id as SkillTargetId)}
            onChange={(next) => toggleTarget(target.id as SkillTargetId, next)}
          >
            <span className="flex items-center gap-2">
              <EngineIcon engine={target.id} size={16} />
              {target.label}
            </span>
          </Checkbox>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="small"
          disabled={!canImport}
          onClick={() => onImport(trimmed, selected)}
        >
          {busy ? t("skills.import.importing") : t("skills.import.confirm")}
        </Button>
      </div>
    </ModalShell>
  );
}
