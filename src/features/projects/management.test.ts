import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/transport", () => ({ invoke }));
import { handleWorkspaceOrganizationRequest as handle, isWorkspaceOrganizationMethod } from "./management";

describe("workspace organization host routing", () => {
  beforeEach(() => { invoke.mockReset(); window.location.hash = ""; });
  it("routes only read/save and forwards only the admitted request capability", async () => {
    const result = { projects: [{ id: "p", expectedCurrent: "hash" }] };
    invoke.mockResolvedValue(result);
    for (const [method, command] of [["get_workspace_organization", "host_get_workspace_organization"], ["save_workspace_project", "host_save_workspace_project"], ["get_session_sidebar_workspaces", "host_get_session_sidebar_workspaces"], ["assign_session_sidebar_workspaces", "host_assign_session_sidebar_workspaces"]]) {
      expect(isWorkspaceOrganizationMethod(method)).toBe(true);
      const request = { requestId: "native-request", method, arguments: { name: "forged" }, sender: { sessionId: "forged" } };
      expect(await handle(request, () => true)).toBe(result);
      expect(invoke).toHaveBeenLastCalledWith(command, { requestId: "native-request" });
    }
    expect(isWorkspaceOrganizationMethod("remove_workspace_project")).toBe(false);
    await expect(handle({ requestId: "r", method: "remove_workspace_project" }, () => true)).rejects.toThrow("Unknown");
    expect(invoke).toHaveBeenCalledTimes(4);
  });
  it("rejects disposed and detached runtimes without a native call", async () => {
    const request = { requestId: "r", method: "save_workspace_project" };
    await expect(handle(request, () => false)).rejects.toThrow("unavailable");
    window.location.hash = "#/p/plugin";
    await expect(handle(request, () => true)).rejects.toThrow("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("propagates expired-request and concurrency failures without retry", async () => {
    for (const error of ["request is no longer live", "project changed since read"]) {
      invoke.mockRejectedValueOnce(new Error(error));
      await expect(handle({ requestId: "r", method: "save_workspace_project" }, () => true)).rejects.toThrow(error);
    }
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("does not report success if the runtime was disposed while native work settled", async () => {
    let active = true;
    invoke.mockImplementation(async () => { active = false; return { id: "saved" }; });
    await expect(handle({ requestId: "r", method: "save_workspace_project" }, () => active)).rejects.toThrow("unavailable");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
