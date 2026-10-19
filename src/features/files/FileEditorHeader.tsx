import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import Save from "lucide-react/dist/esm/icons/save";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

export function FileEditorHeader({
  path,
  name,
  dirty,
  readOnly,
  isMarkdown,
  mdMode,
  onMdModeChange,
  saving,
  onSave,
}: {
  path: string;
  name: string;
  dirty: boolean;
  readOnly: boolean;
  isMarkdown: boolean;
  mdMode: "edit" | "preview";
  onMdModeChange: (mode: "edit" | "preview") => void;
  saving: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-button-default px-3">
      <span className="truncate text-body-medium text-text-primary" title={path}>
        {name}
      </span>
      {dirty && (
        <span className="shrink-0 rounded-sm bg-badge-neutral-background px-1.5 py-0.5 text-caption-1-medium text-text-secondary">
          {t("files.unsavedChanges")}
        </span>
      )}
      {readOnly && (
        <span className="shrink-0 text-caption-1-regular text-text-tertiary">
          {t("files.fileTruncated")}
        </span>
      )}
      <div className="flex-1" />
      {isMarkdown && (
        <div className="flex shrink-0 items-center rounded-lg border border-border-button-default">
          <button
            type="button"
            onClick={() => onMdModeChange("edit")}
            className={cx(
              "flex h-6 items-center gap-1 rounded-l-lg px-2 text-caption-1-medium",
              mdMode === "edit"
                ? "bg-background-tertiary-default text-text-primary"
                : "text-text-tertiary hover:text-text-primary",
            )}
          >
            <PencilLine className="size-3" aria-hidden />
            {t("files.editMode")}
          </button>
          <button
            type="button"
            onClick={() => onMdModeChange("preview")}
            className={cx(
              "flex h-6 items-center gap-1 rounded-r-lg px-2 text-caption-1-medium",
              mdMode === "preview"
                ? "bg-background-tertiary-default text-text-primary"
                : "text-text-tertiary hover:text-text-primary",
            )}
          >
            <Eye className="size-3" aria-hidden />
            {t("files.preview")}
          </button>
        </div>
      )}
      {!readOnly && (
        <Button
          variant="secondary"
          size="xs"
          leadingIcon={Save}
          disabled={!dirty || saving}
          onClick={() => void onSave()}
        >
          {t("files.saveFile")}
        </Button>
      )}
    </div>
  );
}
