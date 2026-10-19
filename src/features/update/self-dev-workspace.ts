import { useSyncExternalStore } from "react";
import type { Workspace } from "@/lib/ipc";
import { isWindowsWorkspacePath } from "@/features/leader/workspace-path";
import { IS_CUSTOM_DISTRIBUTION } from "@/version/distribution";
import type { LiveUpdateChannel } from "./live-update";

export const SELF_DEV_WORKSPACE_STORAGE_KEY = "ccgui-next.selfDevWorkspacePath:v1";

const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeStoredSelfDevWorkspacePath(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Normalize a workspace path for case- and separator-insensitive comparison on Windows. */
export function normalizeSelfDevPathKey(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return "";
  if (isWindowsWorkspacePath(trimmed)) {
    const slashNormalized = trimmed.replace(/[\\/]+/g, "/");
    const withoutTrailing =
      /^[A-Za-z]:\/$/.test(slashNormalized)
        ? slashNormalized
        : slashNormalized.replace(/\/+$/, "");
    return withoutTrailing.toLowerCase();
  }
  return trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "");
}

export function sameSelfDevPath(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const keyA = normalizeSelfDevPathKey(a);
  const keyB = normalizeSelfDevPathKey(b);
  return keyA.length > 0 && keyA === keyB;
}

export function extractChannelSourceRoot(
  channel: LiveUpdateChannel | null | undefined,
): string | null {
  const candidates = [
    channel?.batch?.sourceRoot,
    channel?.updateRequest?.sourceRoot,
    channel?.ready?.[0]?.sourceRoot,
    channel?.working?.[0]?.sourceRoot,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function readStoredSelfDevWorkspacePath(): string | null {
  try {
    const raw = localStorage.getItem(SELF_DEV_WORKSPACE_STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function writeStoredSelfDevWorkspacePath(
  path: string | null | undefined,
): void {
  const trimmed = path?.trim() ?? "";
  const current = readStoredSelfDevWorkspacePath();
  if ((trimmed || null) === current) return;
  try {
    if (trimmed) {
      localStorage.setItem(SELF_DEV_WORKSPACE_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(SELF_DEV_WORKSPACE_STORAGE_KEY);
    }
  } catch {
    // Storage full or unavailable is non-fatal.
  }
  notifyListeners();
}

function workspaceBasename(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function hasWorktreeMeta(workspace: Workspace): boolean {
  const wt = (workspace.meta as { worktree?: { branch?: unknown } } | null | undefined)?.worktree;
  return Boolean(wt && typeof wt.branch === "string" && wt.branch.length > 0);
}

export function isTopLevelWorkspace(workspace: Workspace): boolean {
  return (
    !workspace.parentId &&
    workspace.kind !== "worktree" &&
    !hasWorktreeMeta(workspace)
  );
}

export function isTopLevelSelfDevCandidate(workspace: Workspace): boolean {
  if (!isTopLevelWorkspace(workspace)) return false;
  const meta = workspace.meta as { selfDev?: unknown } | null | undefined;
  if (meta?.selfDev === true) return true;
  if (workspace.name.trim().toLowerCase() === "ccgui-custom") return true;
  return workspaceBasename(workspace.path).toLowerCase() === "ccgui-custom";
}

export interface ResolvedSelfDevWorkspace {
  workspace: Workspace | undefined;
  path: string | null;
  inWorkspaces: boolean;
}

export function resolveSelfDevWorkspace(
  workspaces: Workspace[],
  channel?: LiveUpdateChannel | null,
  storedPath?: string | null,
  isCustom = IS_CUSTOM_DISTRIBUTION,
): ResolvedSelfDevWorkspace {
  if (!isCustom) {
    return { workspace: undefined, path: null, inWorkspaces: false };
  }
  const topLevel = workspaces.filter(isTopLevelWorkspace);
  const channelRoot = extractChannelSourceRoot(channel);
  const persisted =
    storedPath !== undefined ? storedPath : readStoredSelfDevWorkspacePath();

  let workspace: Workspace | undefined;
  if (channelRoot) {
    workspace = topLevel.find((w) => sameSelfDevPath(w.path, channelRoot));
  }
  if (!workspace && persisted) {
    workspace = topLevel.find((w) => sameSelfDevPath(w.path, persisted));
  }
  if (!workspace && !channelRoot && !persisted) {
    workspace = topLevel.find(isTopLevelSelfDevCandidate);
  }
  if (!workspace && (channelRoot || persisted)) {
    workspace = topLevel.find(
      (w) => (w.meta as { selfDev?: unknown } | null | undefined)?.selfDev === true,
    );
  }

  const resolvedPath =
    workspace?.path ??
    (persisted && channelRoot && sameSelfDevPath(persisted, channelRoot)
      ? persisted
      : channelRoot ?? persisted ?? topLevel.find(isTopLevelSelfDevCandidate)?.path ?? null);

  return {
    workspace,
    path: resolvedPath,
    inWorkspaces: Boolean(workspace),
  };
}

export function isSelfDevWorkspace(
  workspace: Workspace | undefined,
  workspaces: Workspace[],
  channel?: LiveUpdateChannel | null,
  storedPath?: string | null,
): boolean {
  if (!workspace) return false;
  const resolved = resolveSelfDevWorkspace(workspaces, channel, storedPath);
  return resolved.workspace?.id === workspace.id;
}

export function useStoredSelfDevWorkspacePath(): string | null {
  return useSyncExternalStore(
    subscribeStoredSelfDevWorkspacePath,
    readStoredSelfDevWorkspacePath,
    () => null,
  );
}
