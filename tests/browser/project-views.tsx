import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ProjectViewsCard } from "../../src/features/projects/ProjectViewsCard";
import { AiChatSidebar } from "../../src/components/application/ai-chat/ai-chat-sidebar";
import { organizeSidebarProjects, projectLaunchTarget } from "../../src/features/projects/sidebar";
import { launchProjectPath } from "../../src/features/projects/launch";
import { FilesPanel } from "../../src/features/files/FilesPanel";
import { ChatImage } from "../../src/features/chat/components/ChatImage";
import { useChatStore } from "../../src/features/chat/store";
import { useProjectsStore } from "../../src/features/projects/store";
import { useFilesStore } from "../../src/features/files/store";
import { imagePreview } from "../../src/features/image-preview/api";
import type { WorkspaceProject } from "../../src/features/projects/types";

const host = window as unknown as Record<string, any>;
const external = "C:/external/screenshots/long-preview-filename.png";
const workspaces = [{ id: "game", name: "Game", path: "C:/fixture/game" }, { id: "research", name: "Research", path: "C:/fixture/research" }, { id: "other", name: "Other workspace", path: "C:/fixture/other" }];
let projects: WorkspaceProject[] = [{ id: "project", name: "Sample project", defaultPath: "C:/fixture/game", members: [
  { id: "game", path: "C:/fixture/game", label: "Game root", role: "development", status: "available" },
  { id: "plan", path: "C:/fixture/game/plan", label: "Nested planning", role: "reference", status: "available" },
  { id: "research", path: "C:/fixture/research", label: "Research reference", role: "reference", status: "available" },
] }];
const calls: { command: string; args: any }[] = [];
const launches: string[] = [];
let failSave = false, granted = false;
const canvas = document.createElement("canvas"); canvas.width=480; canvas.height=240;
const ctx=canvas.getContext("2d")!;ctx.fillStyle="#155e75";ctx.fillRect(0,0,480,240);ctx.fillStyle="white";ctx.font="26px sans-serif";ctx.fillText("Synthetic preview pixels",30,125);
const bytes=Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0));
host.__fixtureInvoke=async(command: string,args: any) => {
  calls.push({command,args});
  switch(command) {
    case "list_workspace_projects": return structuredClone(projects);
    case "save_workspace_project": {
      if(failSave) { failSave=false;throw new Error("Synthetic save failure: draft must remain"); }
      const project={...args.input,id:args.input.id || "created",members:args.input.members.map((m: any)=>({...m,status:"available"}))};
      projects=[...projects.filter(p=>p.id!==project.id),project];host.__fixtureEmit("workspace-projects://changed");return structuredClone(project);
    }
    case "remove_workspace_project": projects=projects.filter(p=>p.id!==args.id);host.__fixtureEmit("workspace-projects://changed");return null;
    case "plugin:dialog|open": return "C:/fixture/game/new-directory";
    case "add_workspace": if(!workspaces.some(w=>w.path===args.path)) workspaces.push({id:"new-directory",name:"New directory",path:args.path});return null;
    case "list_workspaces": return structuredClone(workspaces);
    case "list_dir": return [];
    case "git_tree_status": return { repositories: [], fileColors: {} };
    case "image_preview_scope": return [{path:external,scope:"file"},{path:"C:/external/screenshots",scope:"directory"}];
    case "grant_image_preview": if(args.path!==external || args.scope!=="file" || args.expectedPath!==external) throw new Error("Fixture rejects broad preview grant");granted=true;host.__fixtureEmit("image-preview-grants://changed");return {path:external,scope:"file"};
    case "revoke_image_preview_grant": granted=false;host.__fixtureEmit("image-preview-grants://changed");return null;
    case "read_preview_image_bytes": if(!granted) throw new Error("path is outside the registered workspaces: "+external);return bytes.buffer.slice(0);
    default: throw new Error("Fixture blocked unexpected IPC: "+command);
  }
};
useChatStore.setState({ workspaces, active:{engine:"claude",sessionId:"original",workspacePath:"C:/fixture/game"}, startNewChat:(path)=>{launches.push(path);} });
host.projectFixture={calls,launches, failNextSave:()=>{failSave=true;}, snapshot:()=>({ projects:useProjectsStore.getState().projects,roots:useFilesStore.getState().roots,active:useChatStore.getState().active,granted }), revoke:()=>imagePreview.revoke(external,"file")};
function Fixture() {
  const savedProjects = useProjectsStore((s) => s.projects);
  const registered = useChatStore((s) => s.workspaces);
  const repos = registered.map((w) => ({ id: w.id, path: w.path, label: w.name, threads: [] }));
  const sections = organizeSidebarProjects([{ id: null, name: "", repos }], savedProjects, registered, new Set(), {});
  return <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary">
    <h1 className="mb-4 text-heading-3">Project views browser fixture</h1>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside data-testid="project-sidebar" className="h-[560px] min-w-0 rounded-xl border border-border-secondary">
        <AiChatSidebar flat width={280} repos={repos} sections={sections} onNewSessionInWorkspace={(id) => {
          const target = projectLaunchTarget(savedProjects, id);
          const path = target?.path ?? registered.find((w) => w.id === id)?.path;
          if (path) void launchProjectPath(path);
        }} />
      </aside>
      <section data-testid="project-settings" className="min-w-0"><ProjectViewsCard workspaces={workspaces} /></section>
      <section data-testid="project-files" className="h-[300px] min-w-0 rounded-xl border border-border-secondary"><FilesPanel workspacePath="C:/fixture/game" /></section>
      <section data-testid="external-image" className="min-w-0"><h2 className="mb-2 text-body-medium">External file preview</h2><ChatImage src={external} alt="external preview" workspacePath="C:/fixture/game" /></section>
    </div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
