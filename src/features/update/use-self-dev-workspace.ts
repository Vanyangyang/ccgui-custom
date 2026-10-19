import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/features/chat/store";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { useLiveUpdateStore } from "./live-update";
import {
  isTopLevelWorkspace,
  resolveSelfDevWorkspace,
  sameSelfDevPath,
  useStoredSelfDevWorkspacePath,
  writeStoredSelfDevWorkspacePath,
} from "./self-dev-workspace";

export async function reopenSelfDevWorkspaceInChat(targetPath: string): Promise<boolean> {
  const trimmed = targetPath.trim();
  if (!trimmed) return false;
  writeStoredSelfDevWorkspacePath(trimmed);

  const currentState = useChatStore.getState();
  const existing = currentState.workspaces.find(
    (w) => isTopLevelWorkspace(w) && sameSelfDevPath(w.path, trimmed),
  );
  if (!existing) {
    await currentState.addWorkspace(trimmed);
  }
  const afterAdd = useChatStore
    .getState()
    .workspaces.find(
      (w) => isTopLevelWorkspace(w) && sameSelfDevPath(w.path, trimmed),
    );
  if (
    afterAdd &&
    useChatStore.getState().archivedWorkspaces.includes(afterAdd.id)
  ) {
    await useChatStore.getState().setWorkspaceArchived(afterAdd.id, false);
  }
  const finalPath = afterAdd?.path ?? trimmed;
  dismissCenterSurfaces();
  useChatStore.getState().startNewChat(finalPath);
  if (typeof window !== "undefined" && window.location.hash.startsWith("#/settings")) {
    window.location.hash = "#/";
  }
  return true;
}

export function useSelfDevWorkspace() {
  const {
    workspaces,
    archivedWorkspaces,
    addWorkspace,
    setWorkspaceArchived,
    startNewChat,
  } = useChatStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      archivedWorkspaces: s.archivedWorkspaces,
      addWorkspace: s.addWorkspace,
      setWorkspaceArchived: s.setWorkspaceArchived,
      startNewChat: s.startNewChat,
    })),
  );
  const channel = useLiveUpdateStore((s) => s.channel);
  const storedPath = useStoredSelfDevWorkspacePath();

  const resolved = useMemo(
    () => resolveSelfDevWorkspace(workspaces, channel, storedPath),
    [workspaces, channel, storedPath],
  );

  useEffect(() => {
    if (resolved.path && resolved.path !== storedPath) {
      writeStoredSelfDevWorkspacePath(resolved.path);
    }
  }, [resolved.path, storedPath]);

  const isArchived = Boolean(
    resolved.workspace && archivedWorkspaces.includes(resolved.workspace.id),
  );

  const reopenInWorkspaces = useCallback(
    async (overridePath?: string): Promise<string | null> => {
      const targetPath = (overridePath ?? resolved.path)?.trim() ?? "";
      if (!targetPath) return null;
      writeStoredSelfDevWorkspacePath(targetPath);

      const currentState = useChatStore.getState();
      const existing = currentState.workspaces.find(
        (w) => isTopLevelWorkspace(w) && sameSelfDevPath(w.path, targetPath),
      );
      if (!existing) {
        await addWorkspace(targetPath);
      }
      const afterAdd = useChatStore
        .getState()
        .workspaces.find(
          (w) => isTopLevelWorkspace(w) && sameSelfDevPath(w.path, targetPath),
        );
      if (
        afterAdd &&
        useChatStore.getState().archivedWorkspaces.includes(afterAdd.id)
      ) {
        await setWorkspaceArchived(afterAdd.id, false);
      }
      return afterAdd?.path ?? targetPath;
    },
    [resolved.path, addWorkspace, setWorkspaceArchived],
  );

  const openAndFocusInChat = useCallback(
    async (overridePath?: string): Promise<boolean> => {
      const openedPath = await reopenInWorkspaces(overridePath);
      if (!openedPath) return false;
      dismissCenterSurfaces();
      startNewChat(openedPath);
      if (typeof window !== "undefined" && window.location.hash.startsWith("#/settings")) {
        window.location.hash = "#/";
      }
      return true;
    },
    [reopenInWorkspaces, startNewChat],
  );

  return {
    workspace: resolved.workspace,
    path: resolved.path,
    inWorkspaces: resolved.inWorkspaces,
    archived: isArchived,
    isArchived,
    reopenInWorkspaces,
    openAndFocusInChat,
  };
}
