import { useMemo } from "react";
import { PluginBoundary } from "./PluginBoundary";
import type { ComposerSlotId } from "@ccgui/plugin-sdk";
import { compareByOrder, composerSlotRegistry, pluginIdFromRegistryKey, useRegistry } from "@ccgui/plugin-sdk";

/**
 * Extra composer-toolbar controls contributed by plugins (plan §4.2 #2).
 * Rendered beside the builtin control of one slot by composing into the
 * Composer's slot props from ConversationFooter, so the Composer's public
 * API stays unchanged. Each control renders inside a PluginBoundary keyed
 * by its plugin id (`plugin:<id>[:<key>]` registry id), so a render crash
 * unmounts only that plugin's control — never the composer.
 */
export function ComposerSlotExtras({ slot }: { slot: ComposerSlotId }) {
  const defs = useRegistry(composerSlotRegistry);
  const slotDefs = useMemo(
    () =>
      defs
        .filter((def) => def.slot === slot)
        // compareByOrder: undefined order sorts last, ties break by id.
        .sort(compareByOrder),
    [defs, slot],
  );
  if (slotDefs.length === 0) return null;
  return (
    <>
      {slotDefs.map((def) => {
        const Component = def.component;
        return (
          <PluginBoundary key={def.id} pluginId={pluginIdFromRegistryKey(def.id)}>
            <Component />
          </PluginBoundary>
        );
      })}
    </>
  );
}
