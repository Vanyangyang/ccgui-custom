import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { Select, SelectItem } from "@/components/base/select/select";
import { ModalShell } from "@/components/dialogs";
import type { CustomPromptEntry, PromptScope } from "@/lib/ipc";

export interface PromptEditorValue {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  /** Create mode only — edits keep the file's scope (moved via the row menu). */
  scope: PromptScope;
}

/**
 * Create/edit one custom prompt (.md with frontmatter). The parent owns the
 * store mutation; this dialog collects fields and calls onSubmit with trimmed
 * values. Scope is only choosable on create — afterwards the row's 移动 menu
 * moves the file between the workspace and global directories.
 */
export function PromptEditorDialog({
  initial,
  initialScope,
  onSubmit,
  onCancel,
}: {
  /** Present in edit mode; absent creates a new prompt. */
  initial?: CustomPromptEntry;
  /** Preselected scope for create mode (follows the pane's scope filter). */
  initialScope: PromptScope;
  onSubmit: (value: PromptEditorValue) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentHint, setArgumentHint] = useState(initial?.argumentHint ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [scope, setScope] = useState<PromptScope>(initial?.scope ?? initialScope);

  const trimmedName = name.trim();
  const valid = trimmedName.length > 0 && content.trim().length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: trimmedName,
      description: description.trim() || undefined,
      argumentHint: argumentHint.trim() || undefined,
      content,
      scope,
    });
  };

  return (
    <ModalShell
      onClose={onCancel}
      label={initial ? t("settings.promptDialogEdit") : t("settings.promptDialogNew")}
      className="w-[520px]"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            label={t("settings.promptName")}
            placeholder={t("settings.promptNamePlaceholder")}
            value={name}
            onChange={setName}
            size="small"
            className="flex-1"
            autoFocus
          />
          {!initial && (
            <div className="flex w-36 flex-col">
              <span className="mb-1 text-body-2-medium text-text-secondary">
                {t("settings.promptScope")}
              </span>
              <Select
                aria-label={t("settings.promptScope")}
                selectedKey={scope}
                onSelectionChange={(key) => setScope(key === "global" ? "global" : "workspace")}
                size="sm"
              >
                <SelectItem id="workspace">{t("settings.promptScopeWorkspace")}</SelectItem>
                <SelectItem id="global">{t("settings.promptScopeGlobal")}</SelectItem>
              </Select>
            </div>
          )}
        </div>
        <Input
          label={t("settings.promptDesc")}
          placeholder={t("settings.promptDescPlaceholder")}
          value={description}
          onChange={setDescription}
          size="small"
        />
        <Input
          label={t("settings.promptArgHint")}
          placeholder={t("settings.promptArgHintPlaceholder")}
          value={argumentHint}
          onChange={setArgumentHint}
          size="small"
        />
        <TextArea
          label={t("settings.promptContent")}
          placeholder={t("settings.promptContentPlaceholder")}
          value={content}
          onChange={setContent}
          rows={10}
        />
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" size="small" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="small" disabled={!valid}>
            {initial ? t("common.confirm") : t("common.create")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
