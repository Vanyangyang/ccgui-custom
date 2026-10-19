import { useState } from "react";
import { useTranslation } from "react-i18next";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import type { RepoDragChrome } from "@/components/application/ai-chat/workspace-sortable-list";
import type { WorkspaceGroup } from "@/lib/ipc";
import { Badge, ROW } from "./CliChannelRow";

/** Ghost icon action button, same chrome as CliChannelRow's edit/delete. */
export const ROW_ACTION =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:opacity-40";

/**
 * Inline name field for both create and rename. Enter / the confirm button
 * commits — validation errors stay inline in the field and keep it open;
 * Escape or leaving the field cancels. The confirm button prevents default
 * on pointer-down so its click isn't pre-empted by the input's blur-cancel.
 */
export function GroupNameEditor({
  initial = "",
  placeholder,
  submitLabel,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  submitLabel: string;
  /** Returns a localized validation error, or null when the name was accepted. */
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [hint, setHint] = useState<string | null>(null);
  const commit = () => setHint(onCommit(value));
  return (
    <>
      <Input
        autoFocus
        size="small"
        className="min-w-0 flex-1"
        placeholder={placeholder}
        isInvalid={Boolean(hint)}
        hint={hint ?? undefined}
        value={value}
        onChange={(v) => {
          setValue(v);
          if (hint) setHint(null);
        }}
        onKeyDown={(e) => {
          // Enter/Escape during IME composition (e.g. picking a Chinese
          // candidate) belong to the IME — never submit or cancel.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={onCancel}
      />
      <Button
        variant="primary"
        size="small"
        className="shrink-0"
        disabled={!value.trim()}
        onPointerDown={(e) => e.preventDefault()}
        onClick={commit}
      >
        {submitLabel}
      </Button>
    </>
  );
}

/** One group row in the sortable list: drag grip, name + project count,
 *  rename/delete actions; swaps to the inline name editor while renaming. */
export function GroupRow({
  group,
  drag,
  renaming,
  memberCount,
  onRenameStart,
  onRenameCancel,
  onCommitRename,
  onDelete,
}: {
  group: WorkspaceGroup;
  drag: RepoDragChrome | null;
  renaming: boolean;
  memberCount: number;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onCommitRename: (name: string) => string | null;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  if (renaming) {
    return (
      <div className={ROW}>
        <GroupNameEditor
          initial={group.name}
          submitLabel={t("common.save")}
          onCommit={onCommitRename}
          onCancel={onRenameCancel}
        />
      </div>
    );
  }
  return (
    <div className={ROW}>
      {drag && (
        <button
          type="button"
          aria-label={t("settings.dragGroup")}
          title={t("settings.dragGroup")}
          {...(drag.dragHandleProps ?? {})}
          onClick={(e) => e.stopPropagation()}
          className={`${ROW_ACTION} cursor-grab touch-none`}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <p className="truncate text-body-regular text-text-primary">{group.name}</p>
        <Badge>{t("settings.groupProjectCount", { count: memberCount })}</Badge>
      </div>
      <button
        type="button"
        aria-label={t("settings.renameGroup")}
        title={t("settings.renameGroup")}
        onClick={onRenameStart}
        className={ROW_ACTION}
      >
        <Pencil className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("common.delete")}
        title={t("common.delete")}
        onClick={onDelete}
        className={`${ROW_ACTION} hover:text-text-error-primary`}
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}
