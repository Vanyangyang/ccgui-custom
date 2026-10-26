import { useProjectsStore } from "@/features/projects/store";
import { projectForPath, projectRoots } from "@/features/projects/paths";
import { resolveChatFileLink } from "./file-link-resolution";

/** Read project scope on the user action, without subscribing every Markdown
 * link in the transcript to project updates. The session cwd remains primary. */
export async function resolveChatProjectFileLink(rawPath: string, workspacePath: string) {
  if (!useProjectsStore.getState().loaded) await useProjectsStore.getState().load();
  const state = useProjectsStore.getState();
  const project = projectForPath(state.projects, workspacePath);
  const roots = project ? projectRoots(project).filter((root) => root.status === "available").map((root) => root.path) : [];
  return resolveChatFileLink(rawPath, workspacePath, roots);
}
