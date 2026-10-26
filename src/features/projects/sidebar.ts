import type { AiChatRepo, AiChatRepoSection } from "@/components/application/ai-chat/sidebar-types";
import type { Workspace } from "@/lib/ipc";
import { normalizeProjectPath, projectForPath } from "./paths";
import type { ProjectMember, WorkspaceProject } from "./types";

export const projectRowId = (id: string) => `project:${id}`;
export const projectMemberRowId = (projectId: string, memberId: string) => `project-member:${projectId}:${memberId}`;

export function projectLaunchTarget(projects: WorkspaceProject[], rowId: string): ProjectMember | undefined {
  for (const project of projects) {
    if (rowId === projectRowId(project.id)) {
      return project.members.find((m) => normalizeProjectPath(m.path) === normalizeProjectPath(project.defaultPath));
    }
    const member = project.members.find((m) => rowId === projectMemberRowId(project.id, m.id));
    if (member) return member;
  }
  return undefined;
}

/** Display-only organization: no workspace/session is moved, registered or copied.
 * Ambiguous shared roots remain in the ordinary list instead of duplicating chats.
 * Worktree parent/child relationships are retained as an indivisible repo tree. */
export function organizeSidebarProjects(
  sections: AiChatRepoSection[],
  projects: WorkspaceProject[],
  workspaces: Workspace[],
  archivedIds: Set<string>,
  aliases: Record<string, string>,
): AiChatRepoSection[] | undefined {
  if (!projects.length) return sections.some((s) => s.id !== null) ? sections : undefined;
  const repos = sections.flatMap((s) => s.repos);
  const assigned = new Map<AiChatRepo, string>();
  for (const repo of repos) {
    if (!repo.path || repo.isSelfDev) continue;
    const project = projectForPath(projects, repo.path);
    if (project) assigned.set(repo, project.id);
  }
  const projectSections = projects.map((project): AiChatRepoSection => {
    const grouped: AiChatRepo[] = [];
    const included = new Set<AiChatRepo>();
    for (const member of project.members) {
      const path = normalizeProjectPath(member.path);
      const registered = workspaces.find((w) => normalizeProjectPath(w.path) === path);
      // An archived member must not reappear as an unregistered shortcut.
      if (registered && archivedIds.has(registered.id)) continue;
      const exact = repos.find((r) => r.path && normalizeProjectPath(r.path) === path && assigned.get(r) === project.id);
      if (exact) {
        grouped.push({ ...exact, label: (project.sourcePluginId ? aliases[exact.id ?? ""]?.trim() : undefined) || member.label,
          originalLabel: member.path, unavailable: member.status === "available" ? undefined : member.status });
        included.add(exact);
      } else if (!registered) {
        grouped.push({ id: projectMemberRowId(project.id, member.id), path: member.path,
          label: member.label, originalLabel: member.path, threads: [], directoryOnly: true,
          unavailable: member.status === "available" ? undefined : member.status });
      }
    }
    // Registered descendants not explicitly listed as members retain their own
    // names and exact chat ownership; a nested member never absorbs parent chats.
    grouped.push(...repos.filter((r) => assigned.get(r) === project.id && !included.has(r)));
    const defaultMember = projectLaunchTarget([project], projectRowId(project.id));
    const defaultArchived = workspaces.some((w) => archivedIds.has(w.id) && normalizeProjectPath(w.path) === normalizeProjectPath(project.defaultPath));
    return { id: projectRowId(project.id), name: project.name, repos: grouped,
      project: { launchId: projectRowId(project.id), canLaunch: defaultMember?.status === "available" && !defaultArchived } };
  });
  const ordinary = sections.map((section) => ({ ...section, repos: section.repos.filter((r) => !assigned.has(r)) }))
    .filter((section) => section.id !== null || section.repos.length);
  return [...projectSections, ...ordinary];
}
