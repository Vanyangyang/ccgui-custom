/**
 * Workspace UI bridge (window.__ccguiWorkspaceUI, same-webview global
 * contract as __ccguiFiles): plugins may decorate workspace UI without the
 * host knowing plugin-specific meta shapes. Two optional hooks, both keyed
 * by workspace path:
 *  - allowedEngines: engine ids allowed in the composer CLI menu for this
 *    workspace (null = no filtering — host falls back to local probes and
 *    per-binary availability);
 *  - labelSuffix: suffix appended to the sidebar workspace label
 *    (null = none).
 * The shape of any workspace meta (e.g. { wsl: … }) stays private to the
 * registering plugin — the host never interprets meta contents.
 */

import { useSyncExternalStore } from "react";

export interface WorkspaceUIHooks {
  allowedEngines(workspacePath: string): string[] | null;
  labelSuffix(workspacePath: string): string | null;
}

export interface CcguiWorkspaceUIBridge {
  registerHooks(hooks: WorkspaceUIHooks | null): void;
}

declare global {
  interface Window {
    __ccguiWorkspaceUI?: CcguiWorkspaceUIBridge;
  }
}

let hooks: WorkspaceUIHooks | null = null;
const listeners = new Set<() => void>();

// Self-installing: module scope runs on first import (files store pattern).
window.__ccguiWorkspaceUI = {
  registerHooks(h) {
    hooks = h;
    // 插件 activate / 热重载换 hooks:通知订阅方重算(此前读模块级变量
    // 的调用方会永远停在旧值,徽标/引擎允许表间歇性不生效)。
    for (const listener of listeners) listener();
  },
};

function subscribeHooks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前注册的插件 hooks(响应式):registerHooks 替换后触发重渲染。 */
export function useWorkspaceUIHooks(): WorkspaceUIHooks | null {
  return useSyncExternalStore(subscribeHooks, () => hooks);
}

/** Plugin-registered engine allow-list for a workspace; null = no filter. */
export function workspaceAllowedEngines(
  workspacePath: string | undefined,
): string[] | null {
  if (!workspacePath || !hooks) return null;
  try {
    return hooks.allowedEngines(workspacePath);
  } catch {
    return null; // 插件侧异常不拖垮 composer 菜单
  }
}

/** Plugin-registered sidebar label suffix; null = none. */
export function workspaceLabelSuffix(workspacePath: string): string | null {
  if (!hooks) return null;
  try {
    return hooks.labelSuffix(workspacePath);
  } catch {
    return null;
  }
}
