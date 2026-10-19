import i18n from "@/lib/i18n";
import { commandRegistry } from "@ccgui/plugin-sdk";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { useShortcutsStore } from "@/features/shortcuts/store";
import { usePluginHubStore } from "@/features/plugins/hub/store";
import { useReleaseNotesTabStore } from "@/features/update/notes-tab";

/**
 * Builtin palette commands, registered through the same commandRegistry the
 * plugins use (plan §4.2 #9 dogfood). Module-scope side effect, imported once
 * by CommandPalette; the registry's upsert semantics make HMR re-runs
 * harmless.
 *
 * Keywords are comma-separated i18n strings so aliases translate with the UI
 * language (e.g. an English UI still matches "shezhi" for 打开设置).
 */

/** Comma-separated i18n keyword list → lazy matcher array. Shared by the
 * builtin registrations below and ChatPage's layout-toggle commands. */
export const keywords = (key: string) => () =>
  i18n
    .t(key)
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

commandRegistry.register({
  id: "builtin:openSettings",
  title: () => i18n.t("commands.openSettings"),
  keywords: keywords("commands.openSettingsKeywords"),
  run: () => {
    window.location.hash = "#/settings";
  },
});

commandRegistry.register({
  id: "builtin:openPlugins",
  title: () => i18n.t("commands.openPlugins"),
  keywords: keywords("commands.openPluginsKeywords"),
  // The hub is a center tab on the chat route: leave the settings overlay
  // first (hash no-op when already there), then open the installed tab.
  run: () => {
    window.location.hash = "#/";
    // 其他中心面让位（与侧栏插件入口一致）：否则浏览器页签等还占着中心区，
    // 插件中心只在画面上层出现，页签高亮对不上。
    dismissCenterSurfaces();
    usePluginHubStore.getState().openHub("installed");
  },
});
commandRegistry.register({
  id: "builtin:openMarketplace",
  title: () => i18n.t("commands.openMarketplace"),
  keywords: keywords("commands.openMarketplaceKeywords"),
  run: () => {
    window.location.hash = "#/";
    dismissCenterSurfaces();
    usePluginHubStore.getState().openHub("market");
  },
});
commandRegistry.register({
  id: "builtin:openReleaseNotes",
  title: () => i18n.t("commands.openReleaseNotes"),
  keywords: keywords("commands.openReleaseNotesKeywords"),
  // 更新说明是聊天路由上的中心页签：先离开设置浮层，再让其他中心面让位
  // （同插件入口），否则页签高亮与画面不一致（见 center-surfaces.ts）。
  run: () => {
    window.location.hash = "#/";
    dismissCenterSurfaces();
    useReleaseNotesTabStore.getState().openTab();
  },
});
commandRegistry.register({
  id: "builtin:openShortcutsGuide",
  title: () => i18n.t("commands.openShortcutsGuide"),
  keywords: keywords("commands.openShortcutsGuideKeywords"),
  run: () => {
    useShortcutsStore.getState().setGuideOpen(true);
  },
});
