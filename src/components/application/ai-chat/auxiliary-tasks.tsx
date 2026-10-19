import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { RecentThreadList, SidebarDisclosure } from "./repo-tree";
import { recentThreadsByActivity } from "./recent-threads";
import type { AiChatRepo, AiChatThread } from "./sidebar-types";
import type { ComponentProps } from "react";

export const AUXILIARY_TASKS_KEY = "ccgui-next.sidebarAuxiliaryTasks:v1";
type Preferences = { expanded: boolean; overrides: Record<string, boolean> };

function readPreferences(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(AUXILIARY_TASKS_KEY) ?? "null");
    const overrides: Record<string, boolean> = {};
    if (raw?.overrides && typeof raw.overrides === "object") {
      for (const [id, value] of Object.entries(raw.overrides)) {
        if (id.includes("/") && typeof value === "boolean") overrides[id] = value;
      }
    }
    return { expanded: raw?.expanded === true, overrides };
  } catch {
    return { expanded: false, overrides: {} };
  }
}

/** Managed trees take precedence over display classification. */
export function canClassifyAuxiliary(thread: AiChatThread): boolean {
  return !!thread.id && (thread.auxiliaryKind === "cursor_cce" || thread.auxiliaryKind === "cursor_do")
    && !thread.isDraft && !thread.isLeader && !thread.leaderBranch
    && !thread.leaderParentFallback && !thread.children?.length && !thread.protectedFromDeletion;
}

export function partitionAuxiliaryRepos(repos: AiChatRepo[], overrides: Record<string, boolean>) {
  const auxiliaryRepos: AiChatRepo[] = [];
  const visit = (repo: AiChatRepo): AiChatRepo => {
    const auxiliary: AiChatThread[] = [];
    const threads = repo.threads.filter((thread) => {
      const classified = canClassifyAuxiliary(thread) && (overrides[thread.id!] ?? true);
      if (classified) auxiliary.push(thread);
      return !classified;
    });
    if (auxiliary.length) auxiliaryRepos.push({ ...repo, threads: auxiliary, worktrees: undefined });
    return { ...repo, threads, worktrees: repo.worktrees?.map(visit) };
  };
  const mainRepos = repos.map(visit);
  return { mainRepos, auxiliaryThreads: recentThreadsByActivity(auxiliaryRepos) };
}

export function useAuxiliaryTasks(repos: AiChatRepo[], activeThreadId?: string) {
  const [preferences, setPreferences] = useState(readPreferences);
  const partition = useMemo(() => partitionAuxiliaryRepos(repos, preferences.overrides), [repos, preferences.overrides]);
  useEffect(() => {
    try { localStorage.setItem(AUXILIARY_TASKS_KEY, JSON.stringify(preferences)); } catch { /* Session-only when storage is unavailable. */ }
  }, [preferences]);
  const activeIsAuxiliary = partition.auxiliaryThreads.some((thread) => thread.id === activeThreadId);
  const [revealed, setRevealed] = useState<{ id?: string; auxiliary: boolean }>({ auxiliary: false });
  // Also reveal when metadata arrives after the active tab was restored.
  if (activeThreadId !== revealed.id || activeIsAuxiliary !== revealed.auxiliary) {
    setRevealed({ id: activeThreadId, auxiliary: activeIsAuxiliary });
    if (!preferences.expanded && activeIsAuxiliary) {
      setPreferences((current) => ({ ...current, expanded: true }));
    }
  }
  const toggle = useCallback(() => setPreferences((current) => ({ ...current, expanded: !current.expanded })), []);
  const setAuxiliary = useCallback((id: string, auxiliary: boolean) => {
    setPreferences((current) => ({ ...current, overrides: { ...current.overrides, [id]: auxiliary } }));
  }, []);
  return { ...partition, expanded: preferences.expanded, toggle, setAuxiliary };
}

export function AuxiliaryTaskSection({ expanded, onToggle, ...listProps }: ComponentProps<typeof RecentThreadList> & {
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (!listProps.threads.length) return null;
  return <section className="flex w-full flex-col gap-1" data-auxiliary-tasks>
    <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-body-2-medium text-text-secondary transition-colors duration-150 hover:bg-background-secondary-hover">
      <ChevronRight aria-hidden className={`size-4 transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
      <span>{t("chat.auxiliaryTasks", { count: listProps.threads.length })}</span>
    </button>
    <SidebarDisclosure expanded={expanded}><RecentThreadList {...listProps} /></SidebarDisclosure>
  </section>;
}
