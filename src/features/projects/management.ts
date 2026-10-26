import { invoke } from "@/lib/transport";

interface Request { requestId: string; method: string }

export function isWorkspaceOrganizationMethod(method: string): boolean {
  return method === "get_workspace_organization" || method === "save_workspace_project" ||
    method === "get_session_sidebar_workspaces" || method === "assign_session_sidebar_workspaces";
}

/** Native admission owns arguments and caller identity; the renderer forwards only
 * the live request capability, never a second independently supplied mutation. */
export async function handleWorkspaceOrganizationRequest(request: Request, isActive: () => boolean): Promise<unknown> {
  const assertActive = () => {
    if (!isActive() || window.location.hash.startsWith("#/p/")) throw new Error("Workspace organization main runtime is unavailable");
  };
  assertActive();
  if (!isWorkspaceOrganizationMethod(request.method)) throw new Error("Unknown workspace organization method");
  const command = `host_${request.method}`;
  const result = await invoke(command, { requestId: request.requestId });
  assertActive();
  return result;
}
