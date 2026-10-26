import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ add: vi.fn(), refresh: vi.fn(), start: vi.fn(), dismiss: vi.fn(), state: { workspaces: [] as { path: string }[], active: { workspacePath: "G:/original", sessionId: "existing" } } }));
vi.mock("@/lib/ipc", () => ({ ipc: { addWorkspace: mocks.add } }));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => ({ ...mocks.state, refreshWorkspaces: mocks.refresh, startNewChat: mocks.start }) } }));
vi.mock("@/features/chat/center-surfaces", () => ({ dismissCenterSurfaces: mocks.dismiss }));
vi.mock("./api", () => ({ projectsApi: {} }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn() }));
import { launchProjectPath } from "./launch";
beforeEach(() => { vi.clearAllMocks(); mocks.state.workspaces = []; });
describe("project navigation", () => {
  it("does not start a chat when registration fails", async () => {
    mocks.add.mockRejectedValue(new Error("outside workspace"));
    await expect(launchProjectPath("G:/unregistered")).rejects.toThrow("outside workspace");
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.dismiss).not.toHaveBeenCalled();
  });
  it("verifies registration before launching a member", async () => {
    mocks.add.mockResolvedValue(undefined);
    mocks.refresh.mockImplementation(async () => { mocks.state.workspaces = [{ path: "G:/game/plan" }]; });
    await launchProjectPath("G:/game/plan");
    expect(mocks.add).toHaveBeenCalledWith("G:/game/plan"); expect(mocks.start).toHaveBeenCalledWith("G:/game/plan");
    expect(mocks.state.active.workspacePath).toBe("G:/original");
  });
});
