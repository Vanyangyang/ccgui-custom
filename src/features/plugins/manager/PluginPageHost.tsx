import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import X from "lucide-react/dist/esm/icons/x";
import { pageRegistry, pluginIdFromRegistryKey, useRegistry } from "@ccgui/plugin-sdk";
import { PluginBoundary } from "../boundary/PluginBoundary";

/**
 * Plugin overlay page host (plan §4.2 #10): renders the pageRegistry entry
 * whose id matches the `/p/:pageId` route — the /settings overlay pattern
 * generalized. ChatPage stays mounted underneath (App mounts it on every
 * route), so closing the overlay never rebuilds the chat tree.
 *
 * Opening a page: navigate to `#/p/<id>` (hash navigation) or register a
 * palette command whose run() does the same. Pages are registered by plugins
 * via ctx.ui.registerPage; their ids are `plugin:<pluginId>` or
 * `plugin:<pluginId>:<key>`, and the pluginId segment scopes the
 * PluginBoundary so a render crash unmounts only the plugin subtree.
 *
 * Unknown ids (plugin unloaded, typo) fall back to the chat root.
 */
export default function PluginPageHost() {
  const { t } = useTranslation();
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const pages = useRegistry(pageRegistry);
  const entry = pages.find((page) => page.id === pageId);

  useEffect(() => {
    if (!entry) navigate("/", { replace: true });
  }, [entry, navigate]);

  if (!entry) return null;

  const pluginId = pluginIdFromRegistryKey(entry.id);
  const Component = entry.component;

  const close = () => {
    // Direct loads (fresh window on #/p/<id>) have no in-app history to go
    // back to; land on the chat root instead of navigating away from the app.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate("/");
  };

  return (
    <dialog
      open
      aria-label={entry.title()}
      className="fixed inset-0 z-100 m-0 flex h-full max-h-none w-full max-w-none flex-col bg-background-primary-default"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-separator-border px-4">
        <h1 className="truncate text-title-3-medium text-text-primary">{entry.title()}</h1>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={close}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <X className="size-4 text-foreground-icon-secondary" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PluginBoundary pluginId={pluginId}>
          <Component />
        </PluginBoundary>
      </div>
    </dialog>
  );
}
