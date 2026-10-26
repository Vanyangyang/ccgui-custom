import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { listen } from "@/lib/transport";
import { projectsApi } from "./api";
import { projectContainsPath, projectForPath, projectRoots } from "./paths";
import type { ProjectInput, ProjectRoot, WorkspaceProject } from "./types";
interface ProjectsState {
  projects: WorkspaceProject[]; loaded: boolean; error: string | null;
  load(): Promise<void>;
  save(input: ProjectInput): Promise<WorkspaceProject>; remove(id: string): Promise<void>;
}
let revision = 0;
export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [], loaded: false, error: null,
  async load() {
    const request = ++revision;
    try {
      const projects = await projectsApi.list();
      if (request !== revision) return;
      set({ projects, loaded: true, error: null });
    } catch (error) { if (request === revision) set({ loaded: true, error: String(error) }); }
  },
  async save(input) {
    const project = await projectsApi.save(input);
    ++revision;
    set((state) => ({ projects: [...state.projects.filter((p) => p.id !== project.id), project], error: null }));
    return project;
  },
  async remove(id) {
    await projectsApi.remove(id);
    ++revision;
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id), error: null }));
  },
}));
/** One shared subscription, including late listen resolution after the last consumer leaves. */
let consumers = 0;
let release: (() => void) | undefined;
export function useProjectsSubscription() {
  useEffect(() => {
    if (++consumers === 1) {
      let disposed = false;
      const cleanups: (() => void)[] = [];
      const reload = () => { if (!disposed) void useProjectsStore.getState().load(); };
      for (const event of ["workspace-projects://changed", "workspace-roots://changed", "transport://connected"]) {
        void listen(event, reload).then((off) => { if (disposed) off(); else { cleanups.push(off); reload(); } }).catch((error) => { if (!disposed) useProjectsStore.setState({ error: String(error) }); });
      }
      reload();
      release = () => { disposed = true; ++revision; cleanups.forEach((off) => off()); };
    }
    return () => { if (--consumers === 0) { release?.(); release = undefined; } };
  }, []);
}
export function useProjectContext(workspacePath: string): { project: WorkspaceProject | null; roots: ProjectRoot[]; ambiguous: boolean } {
  useProjectsSubscription();
  const projects = useProjectsStore((s) => s.projects);
  return useMemo(() => {
    const project = projectForPath(projects, workspacePath);
    return { project, ambiguous: !project && projects.some((p) => projectContainsPath(p, workspacePath)), roots: project ? projectRoots(project) : [{ id: "cwd", path: workspacePath, label: workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath, role: "development", status: "available" }] };
  }, [projects, workspacePath]);
}
