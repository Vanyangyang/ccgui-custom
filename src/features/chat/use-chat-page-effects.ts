import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { commandRegistry } from "@ccgui/plugin-sdk";
import { keywords } from "@/features/commands/builtins";
import { registerShortcutHandler } from "@/features/shortcuts/runtime";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";

/** Mount-time store init, the focus-driven session rescan, and git status
 * tracking the active workspace. */
export function useChatPageLifecycle(
  init: () => Promise<void>,
  gitRefresh: (workspacePath: string) => Promise<void>,
  activeWorkspacePath: string | undefined,
) {
  useEffect(() => {
    void init();
  }, [init]);

  // Refocus rescan: 5min TTL, aligned with TokenTracker tier-1.
  useEffect(() => {
    let lastScan = Date.now();
    const onFocus = () => {
      if (Date.now() - lastScan > 5 * 60_000) {
        lastScan = Date.now();
        void ipc.rescanSessions().catch(() => {});
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Git status follows the active workspace (30s TTL inside the store).
  useEffect(() => {
    if (activeWorkspacePath) void gitRefresh(activeWorkspacePath);
  }, [activeWorkspacePath, gitRefresh]);
}

/** Terminal toggle + new-session + interrupt keys live in the shortcut
 * runtime (defaults ⌘J / ⌘N / ⌃C, configurable in Settings → Shortcuts). */
export function useChatShortcutHandlers(
  activeWorkspacePath: string | undefined,
  toggleTerminal: (workspacePath: string) => void,
  handleNewSession: () => void,
) {
  useEffect(
    () =>
      registerShortcutHandler("toggleTerminal", () => {
        if (activeWorkspacePath) toggleTerminal(activeWorkspacePath);
      }),
    [activeWorkspacePath, toggleTerminal],
  );
  useEffect(
    () => registerShortcutHandler("newSession", handleNewSession),
    [handleNewSession],
  );
  useEffect(
    () =>
      registerShortcutHandler("interrupt", () => {
        void useChatStore.getState().interrupt();
      }),
    [],
  );
}

/** Layout toggles registered as palette commands (plan §4.2 #9): the toggles
 * live in the ChatPage hook instance, so registration happens where they're
 * in scope. ChatPage stays mounted for the app's lifetime; the cleanup keeps
 * the registry honest under HMR. */
export function useLayoutCommands(
  handleTogglePanel: () => void,
  toggleSidebarCollapsed: () => void,
) {
  const { t } = useTranslation();
  useEffect(() => {
    const disposers = [
      commandRegistry.register({
        id: "builtin:toggleSidePanel",
        title: () => t("commands.toggleSidePanel"),
        keywords: keywords("commands.toggleSidePanelKeywords"),
        run: handleTogglePanel,
      }),
      commandRegistry.register({
        id: "builtin:toggleSidebar",
        title: () => t("commands.toggleSidebar"),
        keywords: keywords("commands.toggleSidebarKeywords"),
        run: toggleSidebarCollapsed,
      }),
    ];
    return () => disposers.forEach((d) => d());
  }, [t, handleTogglePanel, toggleSidebarCollapsed]);
}
