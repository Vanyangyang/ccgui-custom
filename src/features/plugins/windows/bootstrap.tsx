import * as React from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { AppCrashBoundary } from "@/components/crash/AppCrashBoundary";
import { installGlobalCrashHandlers } from "@/lib/crash";
import { installTauriUnlistenGuard } from "@/lib/tauri-unlisten-guard";
import { applyFontPreferences, readCachedFontPreferences } from "@/features/settings/font";
import i18n from "@/lib/i18n";
import { invoke } from "@/lib/transport";
import type { HostImagesApi, PluginDetachedRenderer, PluginDetachedSurfaceProps, PluginImageAttachment } from "@ccgui/plugin-sdk";
import { createDetachedSurfaceClient, type DetachedSurfaceClient } from "./client";
import { copyAction, type DetachedInit } from "./protocol";
import { ConversationSurface } from "../runtime/ConversationSurface";
import { DetachedRecoveryPanel } from "./RecoveryPanel";

export function createDetachedImagesApi(
  pluginId: string,
  invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> = invoke,
  isAvailable: () => boolean = () => true,
): HostImagesApi {
  return {
    async importImage(request) {
      if (!isAvailable()) throw new Error("Detached plugin window is unavailable");
      if (!request || typeof request !== "object") throw new Error("Invalid image import request");
      const dataBase64 = typeof request.dataBase64 === "string" ? request.dataBase64.trim() : "";
      const mimeType = typeof request.mimeType === "string" ? request.mimeType.trim() : "";
      const name = request.name === undefined ? undefined : typeof request.name === "string" ? request.name : "";
      if (!dataBase64 || !mimeType || (request.name !== undefined && typeof request.name !== "string")) {
        throw new Error("Invalid image import arguments");
      }
      const result = await invokeFn<PluginImageAttachment>("plugin_image_import", {
        pluginId,
        dataBase64,
        mimeType,
        ...(name !== undefined ? { name } : {}),
      });
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.id !== "string" ||
        typeof result.name !== "string" ||
        typeof result.mimeType !== "string" ||
        typeof result.size !== "number"
      ) {
        throw new Error("Invalid plugin image attachment response");
      }
      return { id: result.id, name: result.name, mimeType: result.mimeType, size: result.size };
    },
    async readPreview(imageId) {
      if (!isAvailable()) throw new Error("Detached plugin window is unavailable");
      const normalizedId = typeof imageId === "string" ? imageId.trim() : "";
      if (!normalizedId) throw new Error("Invalid plugin image id");
      const result = await invokeFn<{ dataUrl: string }>("plugin_image_preview", {
        pluginId,
        imageId: normalizedId,
      });
      if (!result || typeof result !== "object" || typeof result.dataUrl !== "string" || !result.dataUrl.startsWith("data:image/")) {
        throw new Error("Invalid plugin image preview response");
      }
      return { dataUrl: result.dataUrl };
    },
  };
}

class RenderBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

async function loadRenderer(info: DetachedInit, images: HostImagesApi) {
  if (!/^[A-Za-z_$][\w$]*$/.test(info.rendererExport) || info.rendererExport === "default") throw new Error("Invalid detached renderer export");
  if (/@import|url\(\s*['"]?https?:/i.test(info.css)) throw new Error("Detached stylesheet references remote resources");
  const url = URL.createObjectURL(new Blob([info.code], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ url) as Record<string, unknown>;
    const factory = module[info.rendererExport];
    if (typeof factory !== "function") throw new Error("Detached renderer export unavailable");
    // No PluginContext: activate and host capability factories never run here.
    const component = (factory as PluginDetachedRenderer)({ react: React, ConversationView: ConversationSurface, Images: images });
    if (typeof component !== "function") throw new Error("Detached renderer must return a component");
    return component;
  } finally { URL.revokeObjectURL(url); }
}

function PluginWindow({ client }: { client: DetachedSurfaceClient }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = React.useState<{ info: DetachedInit; component: React.ComponentType<PluginDetachedSurfaceProps> }>();
  const [loadFailed, setLoadFailed] = React.useState(false);
  const status = React.useSyncExternalStore(client.subscribe, client.getStatus, client.getStatus);
  const snapshot = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const dark = React.useSyncExternalStore(client.subscribe, client.getDark, client.getDark);
  const content = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => { if (content.current) content.current.inert = status.phase !== "detached"; }, [status.phase]);
  React.useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  React.useEffect(() => {
    let alive = true;
    let style: HTMLStyleElement | undefined;
    void client.init().then(async info => {
      const images = createDetachedImagesApi(info.pluginId, invoke, () => alive && client.getStatus().phase === "detached");
      const component = await loadRenderer(info, images);
      if (!alive) return;
      style = document.createElement("style"); style.dataset.plugin = info.pluginId;
      style.textContent = `@layer ccgui-plugins {\n${info.css}\n}`; document.head.appendChild(style);
      document.title = info.title;
      setLoaded({ info, component });
    }).catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; style?.remove(); };
  }, [client]);
  const dispatch = React.useCallback<PluginDetachedSurfaceProps["dispatch"]>((action) =>
    client.dispatch(copyAction(action as Parameters<typeof copyAction>[0])), [client]);
  const labels = loaded?.info.labels;
  const errorText = status.phase === "unavailable"
    ? labels?.ownerUnavailable ?? t("plugins.detached.ownerUnavailable")
    : labels?.actionFailed ?? t("plugins.detached.actionFailed");
  const Renderer = loaded?.component;
  const needsRecovery = ["recovering", "unavailable", "error"].includes(status.phase) || Boolean(status.returnBlocked);
  return <div className="flex h-screen min-h-0 min-w-0 flex-col bg-background-primary-default text-text-primary" data-plugin-window-root>
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border-primary px-4 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{loaded?.info.title ?? t("plugins.detached.loading")}</span>
      <Button variant="secondary" size="small" disabled={status.phase !== "detached"}
        onClick={() => void client.requestReturn().catch(() => {})}>{labels?.returnToMain ?? t("plugins.detached.returnToMain")}</Button>
    </header>
    {needsRecovery ? <DetachedRecoveryPanel client={client} status={status} getContent={() => content.current} />
      : (loadFailed || status.error) && <p role="alert" className="shrink-0 px-4 py-3 text-sm text-text-secondary">{errorText}</p>}
    <div ref={content} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {Renderer && snapshot
        ? <RenderBoundary fallback={<p role="alert" className="p-4 text-sm">{errorText}</p>}>
          <Renderer snapshot={snapshot.state} dispatch={dispatch} registerReturnGuard={client.registerReturnGuard} />
        </RenderBoundary>
        : !loadFailed && <p role="status" className="p-4 text-sm">{labels?.loading ?? t("plugins.detached.loading")}</p>}
    </div>
  </div>;
}

/** This document never starts chat, plugin activation or main live-update. */
export function startPluginWindowApp() {
  installTauriUnlistenGuard(); installGlobalCrashHandlers();
  applyFontPreferences(readCachedFontPreferences());
  const client = createDetachedSurfaceClient({ messages: { pending: i18n.t("plugins.detached.recovering"), notSent: i18n.t("plugins.detached.queuedNotSent") } });
  const root = createRoot(document.getElementById("root")!);
  root.render(<AppCrashBoundary><PluginWindow client={client} /></AppCrashBoundary>);
  let disposed = false;
  const stop = () => { if (disposed) return; disposed = true; client.dispose(); root.unmount(); };
  window.addEventListener("pagehide", stop, { once: true });
  if (import.meta.hot) import.meta.hot.dispose(stop);
  return stop;
}
