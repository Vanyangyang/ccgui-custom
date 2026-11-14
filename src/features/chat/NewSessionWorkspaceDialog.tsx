import { useTranslation } from "react-i18next";
import Folder from "lucide-react/dist/esm/icons/folder";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import type { AiChatRepo } from "@/components/application/ai-chat/sidebar-types";

/** Pick an explicit registered directory before creating a draft. */
export function NewSessionWorkspaceDialog({ repos, workspaceId, onSelect, onClose }: {
  repos: AiChatRepo[];
  workspaceId: string;
  onSelect: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const options: AiChatRepo[] = [];
  const seen = new Set<string>();
  const visit = (repo: AiChatRepo) => {
    if (repo.id && repo.path && !repo.directoryOnly && !seen.has(repo.id)) {
      seen.add(repo.id);
      options.push(repo);
    }
    repo.worktrees?.forEach(visit);
  };
  repos.forEach(visit);
  return (
    <ModalShell label={t("chat.newSessionWorkspace")} onClose={onClose} className="w-[28rem] max-w-[calc(100vw-2rem)]">
      <h2 className="text-body-medium font-semibold text-text-primary">{t("chat.newSessionWorkspace")}</h2>
      <div className="mt-3 flex max-h-[min(24rem,60dvh)] flex-col gap-1 overflow-y-auto">
        {options.map((repo) => (
          <button
            key={repo.id}
            type="button"
            autoFocus={repo.id === workspaceId && !repo.unavailable}
            disabled={!!repo.unavailable}
            title={repo.unavailable ? `${repo.path}\n${t("projects.unavailable")}` : repo.path}
            onClick={() => { onClose(); onSelect(repo.id!); }}
            className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg p-2 text-left outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-background-secondary-hover focus-visible:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Folder aria-hidden className="mt-0.5 size-4 shrink-0 text-foreground-icon-secondary" />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-body-2-medium text-text-primary">{repo.label}</span>
              <span className="block break-all text-caption-1-regular text-text-tertiary">{repo.path}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" size="small" onClick={onClose}>{t("common.cancel")}</Button>
      </div>
    </ModalShell>
  );
}
