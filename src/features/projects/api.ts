import { invoke } from "@/lib/transport";
import type { ProjectInput, WorkspaceProject } from "./types";
export const projectsApi = {
  list: () => invoke<WorkspaceProject[]>("list_workspace_projects"),
  save: (input: ProjectInput) => invoke<WorkspaceProject>("save_workspace_project", { input }),
  remove: (id: string) => invoke<void>("remove_workspace_project", { id }),
};
