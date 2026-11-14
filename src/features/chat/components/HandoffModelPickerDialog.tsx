import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import type { HandoffCompressionSelection } from "@/lib/ipc";
import { HandoffModelPicker } from "./HandoffCompressionControls";

export interface HandoffModelPickerDialogProps {
  workspacePath: string;
  selection: HandoffCompressionSelection;
  onClose: (selection: HandoffCompressionSelection | null) => void;
}

export function HandoffModelPickerDialog({ workspacePath, selection, onClose }: HandoffModelPickerDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => ({ ...selection }));
  return <ModalShell label={t("chat.handoffCompressionModel")} onClose={() => onClose(null)}
    className="w-[32rem] max-w-[calc(100vw-2rem)]">
    <h2 className="mb-4 text-body-medium font-semibold">{t("chat.handoffCompressionModel")}</h2>
    <HandoffModelPicker workspacePath={workspacePath} selection={draft} onSelectionChange={setDraft} />
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="secondary" size="small" onClick={() => onClose(null)}>{t("common.cancel")}</Button>
      <Button variant="primary" size="small" onClick={() => onClose({ ...draft })}>{t("common.confirm")}</Button>
    </div>
  </ModalShell>;
}
