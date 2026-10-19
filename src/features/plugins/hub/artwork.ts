import { useEffect, useState } from "react";
import { ipc, type MarketPlugin, type PluginInfo } from "@/lib/ipc";

const REMOTE = /^https:\/\//i;

/**
 * Artwork for the plugin hub. Market entries carry absolute URLs already
 * resolved by the backend; installed-only plugins declare repo-relative paths
 * in their own manifest, which are read through `plugin_read_artwork` as data
 * URLs — the webview never touches the filesystem, and `~/.ccgui-next` stays
 * behind the asset protocol's deny list. Both sources are optional: null
 * means "no artwork here", the caller keeps its deterministic letter tile.
 */

/** One installed-manifest artwork URL; null while loading or when unreadable. */
export function useLocalArtwork(pluginId: string | null, path: string | null): string | null {
  const remote = path && REMOTE.test(path) ? path : null;
  const localKey = !remote && pluginId && path ? `${pluginId}\n${path}` : null;
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!localKey || !pluginId || !path) return;
    let cancelled = false;
    ipc
      .pluginReadArtwork(pluginId, path)
      .then((url) => {
        if (!cancelled) setResolved({ key: localKey, url });
      })
      .catch(() => {
        // Unreadable artwork is not an error state — the tile stays.
      });
    return () => {
      cancelled = true;
    };
  }, [localKey, pluginId, path]);
  if (remote) return remote;
  return resolved?.key === localKey ? resolved.url : null;
}

/** Gallery variant: remote URLs pass through, local paths load in parallel. */
export function useLocalArtworkList(pluginId: string | null, paths: string[]): string[] {
  const key = pluginId && paths.length > 0 ? `${pluginId}\n${paths.join("\n")}` : null;
  const [resolved, setResolved] = useState<{ key: string; urls: string[] } | null>(null);
  useEffect(() => {
    if (!key || !pluginId) return;
    let cancelled = false;
    Promise.all(
      paths.map((path) =>
        REMOTE.test(path)
          ? Promise.resolve(path)
          : ipc.pluginReadArtwork(pluginId, path).catch(() => null),
      ),
    ).then((urls) => {
      if (!cancelled) {
        setResolved({ key, urls: urls.filter((url): url is string => url !== null) });
      }
    });
    return () => {
      cancelled = true;
    };
    // `key` folds id + paths into one primitive; `paths` feeds that string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return resolved?.key === key ? resolved.urls : [];
}

/**
 * Detail-page artwork with market-first fallback: the index wins while it has
 * the entry, and the locally installed manifest fills the gap (a plugin that
 * is not on the market, or artwork landed in the repo before a release).
 */
export function usePluginArtwork(entry?: MarketPlugin, installed?: PluginInfo) {
  const marketIcon = entry?.icon ?? null;
  const marketShots = entry?.screenshots ?? [];
  const localIcon = useLocalArtwork(
    marketIcon ? null : (installed?.id ?? null),
    marketIcon ? null : (installed?.icon ?? null),
  );
  const localShots = useLocalArtworkList(
    marketShots.length > 0 ? null : (installed?.id ?? null),
    marketShots.length > 0 ? [] : (installed?.screenshots ?? []),
  );
  return {
    icon: marketIcon ?? localIcon,
    screenshots: marketShots.length > 0 ? marketShots : localShots,
  };
}
