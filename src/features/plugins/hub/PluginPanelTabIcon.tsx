import type { ComponentType } from "react";
import { cx } from "@/utils/cx";
import { usePluginsStore } from "@/features/plugins/manager/usePlugins";
import { pluginIdFromRegistryKey, type PanelTabDef } from "@ccgui/plugin-sdk";
import { useLocalArtwork } from "./artwork";
import { pluginAvatarGradient, pluginInitial } from "./catalog";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/**
 * Leading glyph of an icon-only plugin panel tab (see ChatPanelHeader). The
 * plugin's registered `icon` wins; without one the pill falls back to the
 * plugin's own artwork — the manifest `icon` read through
 * `plugin_read_artwork` — and then to the same deterministic gradient letter
 * tile `PluginAvatar` uses, so the icon slot is never empty.
 */

/** One stable component per def: PillTab only forwards `className`, and a
 *  fresh wrapper each render would read as a new component type — React would
 *  remount the subtree and restart `useLocalArtwork`'s read on every parent
 *  render. */
const fallbackGlyphs = new WeakMap<PanelTabDef, IconComponent>();

/** PillTab `icon` for a plugin panel tab: registered icon or artwork tile. */
export function pluginPanelTabIcon(def: PanelTabDef): IconComponent {
  if (def.icon) return def.icon;
  let glyph = fallbackGlyphs.get(def);
  if (!glyph) {
    const pluginId = pluginIdFromRegistryKey(def.id);
    glyph = ({ className, "aria-hidden": ariaHidden }) => (
      <PluginPanelTabArtwork
        pluginId={pluginId}
        fallbackLabel={def.label()}
        className={className}
        aria-hidden={ariaHidden}
      />
    );
    fallbackGlyphs.set(def, glyph);
  }
  return glyph;
}

function PluginPanelTabArtwork({
  pluginId,
  fallbackLabel,
  className,
  "aria-hidden": ariaHidden,
}: {
  pluginId: string;
  /** Label used for the letter tile when no artwork resolves. */
  fallbackLabel: string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  // Primitive selector: re-renders tie to the declared path, not to every
  // installed-list refresh. Community plugins usually ship square artwork.
  const artworkPath = usePluginsStore(
    (s) => s.installed.find((p) => p.id === pluginId)?.icon ?? null,
  );
  const artwork = useLocalArtwork(pluginId, artworkPath);
  const { from, to } = pluginAvatarGradient(pluginId);
  return (
    <span
      aria-hidden={ariaHidden}
      className={cx(
        className,
        "relative flex items-center justify-center overflow-hidden rounded-[3px] font-medium text-white",
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
        fontSize: 10,
        lineHeight: 1,
      }}
    >
      {pluginInitial(fallbackLabel)}
      {artwork && (
        <img
          src={artwork}
          alt=""
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
