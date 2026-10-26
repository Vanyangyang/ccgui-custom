export type ProjectRole = "development" | "reference";
export type ProjectStatus = "available" | "missing" | "changed";
export interface ProjectMember { id: string; path: string; label: string; role: ProjectRole; status: ProjectStatus }
export interface WorkspaceProject { id: string; name: string; defaultPath: string; members: ProjectMember[]; sourcePluginId?: string | null; sourceKey?: string | null }
export interface ProjectInput { id?: string; name: string; defaultPath: string; members: Omit<ProjectMember, "status">[] }
export type ProjectRoot = ProjectMember;
