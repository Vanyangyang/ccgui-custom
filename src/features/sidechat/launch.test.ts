import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type ActiveSession } from "@/features/chat/store";
import { resolveSideLaunch } from "./launch";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));

const parent: ActiveSession = { engine: "codex", sessionId: "parent", workspacePath: "C:/fixture" };

beforeEach(() => {
  useChatStore.setState({ openTabs: [parent], engines: [], bySession: {}, permission: "auto", models: {}, efforts: {}, providers: {} });
});

describe("Sidechat parent launch permission", () => {
  it("reads the current parent permission for every send without keeping a separate preference", () => {
    for (const permission of ["auto", "manual", "plan", "bypass"] as const) {
      useChatStore.setState({ permission });
      expect(resolveSideLaunch(parent)?.parentPermission).toBe(permission);
    }
  });

  it("uses the same engine-supported fallback as the parent conversation", () => {
    useChatStore.setState({ permission: "manual", engines: [{ id: "agy", permissions: ["auto", "plan", "bypass"] } as ReturnType<typeof useChatStore.getState>["engines"][number]] });
    expect(resolveSideLaunch({ ...parent, engine: "agy" })?.parentPermission).toBe("auto");
    expect(resolveSideLaunch(null)).toBeNull();
  });
});
