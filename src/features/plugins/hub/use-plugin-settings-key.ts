import { pluginIdFromRegistryKey, settingsRegistry, useRegistry } from "@ccgui/plugin-sdk";

/** The settings page a plugin registered (first section wins), or null.
 *  Drives the "插件设置" shortcut on installed rows and in the detail dialog. */
export function usePluginSettingsKey(pluginId: string): string | null {
  const sections = useRegistry(settingsRegistry);
  const section = sections.find(
    (item) => item.key.startsWith("plugin:") && pluginIdFromRegistryKey(item.key) === pluginId,
  );
  return section?.key ?? null;
}
