import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Folder from "lucide-react/dist/esm/icons/folder";
import { Select, SelectItem } from "@/components/base/select/select";
import { useChatStore } from "../store";
import { useHandoffStore, type PendingHandoffSession } from "../session-cleanup";

export function HandoffWorkspaceControl({
  workspacePath,
  entry,
}: {
  workspacePath: string;
  entry: PendingHandoffSession;
}) {
  const { t } = useTranslation();
  const workspaces = useChatStore((s) => s.workspaces);
  const archivedWorkspaces = useChatStore((s) => s.archivedWorkspaces);
  const moveHandoff = useHandoffStore((s) => s.moveHandoffToWorkspace);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [entry.id, workspacePath]);

  const paths = useMemo(() => Array.from(new Set([
    workspacePath,
    entry.workspacePath,
    ...workspaces.filter((w) => !archivedWorkspaces.includes(w.id)).map((w) => w.path),
  ])), [workspacePath, entry.workspacePath, workspaces, archivedWorkspaces]);
  const crossWorkspace = workspacePath !== entry.workspacePath;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="handoff-workspace-control">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="shrink-0 text-caption-1-medium text-text-secondary">
          {t("chat.handoffTargetWorkspace")}
        </span>
        <Select
          size="sm"
          aria-label={t("chat.handoffTargetWorkspace")}
          selectedKey={workspacePath}
          isDisabled={entry.sending === true}
          onSelectionChange={(key) => {
            if (key != null) setFailed(!moveHandoff(workspacePath, String(key)));
          }}
          className="min-w-0 max-w-full flex-1 sm:max-w-md"
          triggerClassName="py-0.5 text-caption-1-medium disabled:cursor-wait"
          popoverClassName="w-[min(32rem,calc(100vw-2rem))]"
          renderValue={<span className="flex min-w-0 items-center gap-1.5" title={entry.sending ? t("chat.handoffSendingLock") : workspacePath}>
            <Folder className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{workspacePath}</span>
          </span>}
        >
          {paths.map((path) => (
            <SelectItem key={path} id={path} textValue={path}>
              <span className="block break-all">{path}</span>
            </SelectItem>
          ))}
        </Select>
      </div>
      {crossWorkspace && (
        <p className="break-words text-caption-1-regular text-text-tertiary">
          {t("chat.handoffWorkspaceContext", { source: entry.workspacePath })}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-caption-1-regular text-text-warning-primary">
          {t("chat.handoffWorkspaceMoveFailed")}
        </p>
      )}
    </div>
  );
}
