import type { ComponentType } from "react";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import { pluginIdFromRegistryKey, type SettingsSectionDef } from "@ccgui/plugin-sdk";
import { usePluginsStore } from "@/features/plugins/manager/usePlugins";
import { cx } from "@/utils/cx";
import { useLocalArtwork } from "./artwork";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/**
 * Leading glyph of a settings rail row. A section that registered its own
 * `icon` wins; a plugin section without one falls back to the plugin's real
 * artwork — the manifest `icon` read through `plugin_read_artwork`, the same
 * chain the panel tab uses — and keeps the shared grid glyph only when the
 * plugin ships no artwork at all. A letter tile would paint color into a rail
 * whose every other row is a monochrome 16px lucide icon.
 */
export function pluginSettingsNavIcon(def: SettingsSectionDef): IconComponent {
  if (def.icon) return def.icon;
  if (!def.id.startsWith("plugin:")) return LayoutGrid;
  // One stable component per def: the rail's memoized group list re-renders,
  // and a fresh wrapper each time would read as a new component type — React
  // would remount the subtree and restart the artwork read.
  let glyph = fallbackGlyphs.get(def);
  if (!glyph) {
    const pluginId = pluginIdFromRegistryKey(def.id);
    glyph = ({ className, "aria-hidden": ariaHidden }) => (
      <PluginSettingsArtwork
        pluginId={pluginId}
        className={className}
        ariaHidden={ariaHidden}
      />
    );
    fallbackGlyphs.set(def, glyph);
  }
  return glyph;
}

const fallbackGlyphs = new WeakMap<SettingsSectionDef, IconComponent>();

function PluginSettingsArtwork({
  pluginId,
  className,
  ariaHidden,
}: {
  pluginId: string;
  className?: string;
  ariaHidden?: boolean | "true" | "false";
}) {
  // Primitive selector: re-renders tie to the declared path, not to every
  // installed-list refresh.
  const artworkPath = usePluginsStore(
    (s) => s.installed.find((p) => p.id === pluginId)?.icon ?? null,
  );
  const artwork = useLocalArtwork(pluginId, artworkPath);
  if (!artwork) return <LayoutGrid className={className} aria-hidden={ariaHidden} />;
  return (
    <img
      src={artwork}
      alt=""
      aria-hidden={ariaHidden}
      className={cx(className, "rounded-[3px] object-cover")}
    />
  );
}
