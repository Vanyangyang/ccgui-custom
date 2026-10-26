import * as React from "react";
import i18n from "@/lib/i18n";
import { isWeb } from "@/lib/transport";
import { runtimeCheckpoint, whenRuntimeSubmissionResumed } from "@/lib/runtime-checkpoint";
import {
  SDK_VERSION,
  addMenuRegistry,
  commandRegistry,
  composerSlotRegistry,
  execGrantAllows,
  markdownRegistry,
  networkGrantAllows,
  pageRegistry,
  panelTabRegistry,
  scopedPluginId,
  sessionMenuRegistry,
  settingsRegistry,
  statusBarRegistry,
  composerStatusRegistry,
  timelineRowRegistry,
  sidebarNavRegistry,
  centerTabRegistry,
  conversationModeRegistry,
} from "@ccgui/plugin-sdk";
import type {
  Disposer,
  PluginAgentCatalogEntry,
  MarkdownRendererDef,
  PluginContext,
  PluginManifest,
} from "@ccgui/plugin-sdk";
import { assertPluginEmitTopic, pluginBus } from "./events";
import { setActiveComposerDraft } from "./composer-draft";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { addPluginWorkspace, openPluginSession } from "./workspace-bridge";
import { registerSessionSource } from "./session-source";
import { usePluginTabsStore } from "./center-tabs";
import { runAsPlugin } from "./hardening";
import { createHostChatBridge } from "./chat-bridge";
import { createHostConversationBridge, HOST_CONVERSATIONS_KEY_PREFIX } from "./conversation-bridge";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createHostTaskBridge, HOST_TASKS_KEY_PREFIX } from "./task-bridge";
import { createMemoryExtractionBridge } from "./memory-extraction-bridge";
import { createDetachedSurfaceOwner, type DetachedSurfaceOwner } from "../windows/owner";
import { assertPluginViewsCanOpen, registerPluginDetachedOwner, registerPluginUpdateCloseHandler } from "./update-close";
import { copyJson, type DetachedLabels } from "../windows/protocol";
import { DetachedCenterTabSurface } from "../windows/CenterTabSurface";
import { ConversationSurface } from "./ConversationSurface";

/** Storage transport the context talks to; the loader binds the IPC-backed
 *  implementation, tests bind fakes. */
export interface PluginStorageBackend {
  get(id: string, key: string): Promise<unknown>;
  set(id: string, key: string, value: unknown): Promise<void>;
  delete(id: string, key: string): Promise<void>;
}

/** Full backend seam the context needs: KV storage plus the bridge invoke
 *  (grant-checked below, then routed through the host's transport by the
 *  loader's IPC-backed implementation). */
export interface PluginContextBackend extends PluginStorageBackend {
  agentCatalog?(workspacePath: string): Promise<PluginAgentCatalogEntry[]>;
  bridgeInvoke(command: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface PluginHandle {
  manifest: PluginManifest;
  ctx: PluginContext;
  /** Registrations made through the context, in registration order. Unload
   *  order (loader): the activate-returned cleanup first, then this stack
   *  reversed — outermost effects unwind before the registrations they were
   *  built on. */
  disposers: Disposer[];
}

const REMOTE_CSS = /@import|url\(\s*['"]?https?:/i;

/** Shared stylesheet mount: tagged `<style data-plugin=id>` in <head>,
 *  disposer removes it. Remote references rejected (plan §8 gate rule).
 *
 *  `layered` wraps the css in `@layer ccgui-plugins` — declared between
 *  Tailwind's base and components layers in index.css (after base, so
 *  preflight resets can't erase plugin borders/paddings/backgrounds) — so
 *  host component and utility rules still win every specificity tie
 *  against bundle CSS. Without it, a bundle that
 *  accidentally ships its own Tailwind build lands after the host
 *  stylesheet, and its later, equal-specificity `.w-full`/`.hidden` defeat
 *  host responsive variants like `md:w-[254px]` (the settings modal once
 *  collapsed to a full-width nav rail with no content pane this way).
 *  Theme-API CSS stays unlayered on purpose: token overrides must beat the
 *  host's unlayered :root/.dark token definitions.
 */
function mountPluginCss(id: string, css: string, opts?: { layered?: boolean }): Disposer {
  if (REMOTE_CSS.test(css)) {
    throw new Error(`[plugins] "${id}" css references remote resources (@import/url http)`);
  }
  const style = document.createElement("style");
  style.dataset.plugin = id;
  style.textContent = opts?.layered ? `@layer ccgui-plugins {\n${css}\n}` : css;
  document.head.appendChild(style);
  return () => style.remove();
}

/**
 * Inject a bundle's `styles.css` at load time (Obsidian convention: the
 * stylesheet is one of the three bundle files, reviewed at install). This is
 * host behavior, not a plugin API call, so it bypasses the `theme`
 * permission gate — that gate exists for runtime-arbitrary CSS, not for the
 * shipped artifact. The remote-reference rule still applies.
 */
export function injectBundleCss(handle: PluginHandle, css: string): void {
  handle.disposers.push(mountPluginCss(handle.manifest.id, css, { layered: true }));
}

function tokenBlock(selector: string, tokens: Record<string, string> | undefined): string {
  if (!tokens) return "";
  const lines = Object.entries(tokens).map(([k, v]) => {
    if (!k.startsWith("--")) throw new Error(`[plugins] token key "${k}" must start with --`);
    return `${k}: ${v};`;
  });
  return lines.length ? `${selector} { ${lines.join(" ")} }` : "";
}

/**
 * Builds the host implementation of the SDK's PluginContext contract
 * (@ccgui/plugin-sdk). Every registration returns a Disposer and is also
 * pushed onto the plugin's disposer stack, so unload reverses everything
 * even when the plugin forgot to return its own cleanup. Capability groups
 * are trimmed by the manifest's declared permissions (门面裁剪).
 */
export function createPluginContext(
  manifest: PluginManifest,
  backend: PluginContextBackend,
  hostInfo: { appVersion: string; detachedBundle?: () => { code: string; css: string; rendererExports: Set<string> } | undefined },
): PluginHandle {
  const disposers: Disposer[] = [];
  const id = manifest.id;
  const detachedOwners = new Map<string, DetachedSurfaceOwner>();

  /** Missing-permission failures throw: a plugin probing beyond its manifest
   *  is a bug the developer should see, not a silent no-op. Unknown
   *  permissions never reach here — validateManifest rejects them at load. */
  const requirePermission = (capability: string) => {
    if (!manifest.permissions.includes(capability)) {
      throw new Error(`[plugins] "${id}" used ${capability} without declaring it in permissions`);
    }
  };
  const track = (d: Disposer): Disposer => {
    disposers.push(d);
    return d;
  };

  let chatBridge: ReturnType<typeof createHostChatBridge> | undefined;
  let conversationBridge: ReturnType<typeof createHostConversationBridge> | undefined;
  const conversations = () => {
    if (isWeb || (typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) && getCurrentWindow().label.startsWith("plugin-window-"))) {
      throw new Error("host conversations are available only in the desktop owner");
    }
    if (!conversationBridge) {
      conversationBridge = createHostConversationBridge(id, backend);
      track(conversationBridge.dispose);
    }
    return conversationBridge;
  };
  const chat = () => {
    if (isWeb) throw new Error("host:chat is available only in the desktop host");
    if (!chatBridge) {
      chatBridge = createHostChatBridge(id, backend);
      track(chatBridge.dispose);
    }
    return chatBridge;
  };
  let taskBridge: ReturnType<typeof createHostTaskBridge> | undefined;
  const tasks = () => {
    if (isWeb) throw new Error("host:tasks is available only in the desktop host");
    if (!taskBridge) {
      taskBridge = createHostTaskBridge(id, backend, {
        invoke: (command, args) => backend.bridgeInvoke(command, args),
        loadClaims: () => backend.bridgeInvoke("plugin_task_pending_claims", { pluginId: id }),
      });
      track(taskBridge.dispose);
    }
    return taskBridge;
  };
  let memoryExtractionBridge: ReturnType<typeof createMemoryExtractionBridge> | undefined;
  const memoryExtraction = () => {
    if (isWeb || (typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) && getCurrentWindow().label !== "main")) {
      throw new Error("host:memory is available only in the desktop owner");
    }
    if (!memoryExtractionBridge) {
      memoryExtractionBridge = createMemoryExtractionBridge(id, {
        invoke: (command, args) => backend.bridgeInvoke(command, args),
        conversation: async threadId => { requirePermission("host:chat"); return conversations().inspect(threadId); },
        coordination: async requestId => { requirePermission("host:tasks"); return tasks().conversation(requestId); },
        paused: runtimeCheckpoint.isPaused,
      });
      track(memoryExtractionBridge.dispose);
    }
    return memoryExtractionBridge;
  };
  /** The task ledger shares this plugin's KV; its keys are host-owned. */
  const assertPluginStorageKey = (key: string) => {
    if (typeof key === "string" && key.startsWith(HOST_CONVERSATIONS_KEY_PREFIX)) {
      throw new Error("Conversation storage keys are reserved for the host");
    }
    if (typeof key === "string" && key.startsWith(HOST_TASKS_KEY_PREFIX)) {
      throw new Error(`[plugins] "${id}" storage key prefix ${HOST_TASKS_KEY_PREFIX} is reserved for the host`);
    }
  };

  const ctx: PluginContext = {
    pluginId: id,
    version: manifest.version,
    react: React,
    ui: {
      registerConversationMode(def) {
        requirePermission("ui:conversation-mode");
        return track(conversationModeRegistry.register({
          id: scopedPluginId(id, def.key),
          label: () => runAsPlugin(def.label),
          component: def.component,
        }));
      },
      registerSettingsSection(def) {
        requirePermission("ui:settings-section");
        const key = scopedPluginId(id, def.key);
        return track(
          settingsRegistry.register({
            id: key,
            key,
            label: def.label,
            icon: def.icon,
            group: "plugins",
            order: 1000,
            component: def.component,
          }),
        );
      },
      registerAddMenuRow(def) {
        requirePermission("ui:add-menu");
        const rowId = scopedPluginId(id, def.key);
        return track(
          addMenuRegistry.register({
            id: rowId,
            label: def.label,
            description: def.description,
            icon: def.icon,
            onSelect: () => runAsPlugin(def.onSelect),
          }),
        );
      },
      registerComposerSlot(def) {
        requirePermission("ui:composer-status");
        return track(
          composerSlotRegistry.register({
            id: scopedPluginId(id, def.key),
            slot: def.slot,
            component: def.component,
            order: def.order,
          }),
        );
      },
      registerPanelTab(def) {
        requirePermission("ui:panel-tab");
        return track(
          panelTabRegistry.register({
            id: scopedPluginId(id, def.key),
            label: def.label,
            icon: def.icon,
            component: def.component,
            order: def.order,
          }),
        );
      },
      registerStatusBarItem(def) {
        requirePermission("ui:status-bar");
        return track(
          statusBarRegistry.register({
            id: scopedPluginId(id, def.key),
            component: def.component,
            order: def.order,
            zone: def.zone,
          }),
        );
      },
      registerComposerStatusItem(def) {
        requirePermission("ui:composer-status");
        return track(
          composerStatusRegistry.register({
            id: scopedPluginId(id, def.key),
            component: def.component,
            order: def.order,
          }),
        );
      },
      registerCommand(def) {
        requirePermission("ui:command");
        return track(
          commandRegistry.register({
            id: scopedPluginId(id, def.key),
            title: def.title,
            keywords: def.keywords,
            run: () => runAsPlugin(def.run),
          }),
        );
      },
      registerSessionMenuItem(def) {
        requirePermission("ui:session-menu");
        return track(
          sessionMenuRegistry.register({
            id: scopedPluginId(id, def.key),
            label: def.label,
            icon: def.icon,
            danger: def.danger,
            run: (target) => runAsPlugin(() => def.run(target)),
          }),
        );
      },
      openSettings(key) {
        requirePermission("ui:settings-section");
        // 宿主是 hash 路由（见 features/commands/builtins.ts 的设置命令）。
        window.location.hash = `#/settings?page=${scopedPluginId(id, key)}`;
      },
      registerMarkdownRenderer(def) {
        requirePermission("ui:markdown");
        return track(
          markdownRegistry.register({
            id: scopedPluginId(id, def.key),
            remarkPlugins: def.remarkPlugins,
            rehypePlugins: def.rehypePlugins,
            components: def.components as MarkdownRendererDef["components"],
          }),
        );
      },
      registerPage(def) {
        requirePermission("ui:page");
        return track(
          pageRegistry.register({
            id: scopedPluginId(id, def.key),
            title: def.title,
            component: def.component,
          }),
        );
      },
      registerTimelineRowRenderer(def) {
        requirePermission("ui:timeline-row");
        return track(
          timelineRowRegistry.register({
            id: scopedPluginId(id, def.key),
            kind: def.kind,
            component: def.component,
          }),
        );
      },
      registerSidebarNav(def) {
        requirePermission("ui:sidebar-entry");
        return track(
          sidebarNavRegistry.register({
            id: scopedPluginId(id, def.key),
            label: def.label,
            icon: def.icon,
            order: def.order,
            onOpen: () => runAsPlugin(def.onOpen),
          }),
        );
      },
      registerCenterTab(def) {
        requirePermission("ui:center-tab");
        const tabId = scopedPluginId(id, def.key);
        let component = def.component;
        let restore: (() => void) | undefined;
        let disposeOwner: Disposer | undefined;
        if (def.detached) {
          requirePermission("ui:detached-window");
          if (!isWeb) {
            const assets = hostInfo.detachedBundle?.();
            if (!assets || !assets.rendererExports.has(def.detached.rendererExport)) {
              throw new Error(`[plugins] "${id}" registered an unavailable detached renderer`);
            }
            const definition = def.detached;
            if (definition.defaultPresentation !== undefined && !["docked", "detached"].includes(definition.defaultPresentation)) {
              throw new Error("Invalid detached default presentation");
            }
            const labels: DetachedLabels = {
              returnToMain: i18n.t("plugins.detached.returnToMain"),
              ownerUnavailable: i18n.t("plugins.detached.ownerUnavailable"),
              actionFailed: i18n.t("plugins.detached.actionFailed"),
              loading: i18n.t("plugins.detached.loading"),
            };
            const owner = createDetachedSurfaceOwner({
              assertCanOpen: () => assertPluginViewsCanOpen(id),
              pluginId: id, tabId, title: def.title, rendererExport: definition.rendererExport,
              defaultPresentation: definition.defaultPresentation,
              assets: { code: assets.code, css: assets.css }, getSnapshot: () => copyJson(definition.getSnapshot()), subscribe: definition.subscribe,
              dispatch: async (action) => {
                const value = await definition.dispatch(action);
                return value === undefined ? null : copyJson(value);
              },
              dark: () => document.documentElement.classList.contains("dark"), labels,
              onReturn: (reason) => {
                // The owner only invokes this for its live window generation.
                if (!centerTabRegistry.get(tabId)) return;
                if (reason === "closed") {
                  usePluginTabsStore.getState().closeTab(tabId, "presentation");
                } else {
                  dismissCenterSurfaces();
                  usePluginTabsStore.getState().openTab(tabId, { reason: "presentation" });
                }
              },
            });
            const unregisterOwner = registerPluginDetachedOwner(id, owner, () => restore?.());
            detachedOwners.set(tabId, owner);
            const abort = new AbortController();
            disposeOwner = () => { abort.abort(); if (detachedOwners.get(tabId) === owner) detachedOwners.delete(tabId); unregisterOwner(); owner.dispose(); };
            restore = () => {
              void whenRuntimeSubmissionResumed(abort.signal).then(() => owner.restore()).then(mode => {
                if (mode && !abort.signal.aborted && detachedOwners.get(tabId) === owner && centerTabRegistry.get(tabId)) {
                  assertPluginViewsCanOpen(id);
                  usePluginTabsStore.getState().openTab(tabId, { activate: false, reason: "presentation" });
                }
              }).catch(() => {
                if (!abort.signal.aborted) console.warn("[plugins] detached presentation could not be restored", { pluginId: id, tabId });
              });
            };
            const Component = def.component;
            component = () => React.createElement(DetachedCenterTabSurface, { owner, component: Component });
          }
        }
        let unregister: Disposer;
        try {
          unregister = centerTabRegistry.register({
            id: tabId,
            title: def.title,
            icon: def.icon,
            component,
            order: def.order,
          });
        } catch (error) { disposeOwner?.(); throw error; }
        let registered = true;
        const dispose = track(() => { if (!registered) return; registered = false; unregister(); disposeOwner?.(); });
        restore?.();
        return dispose;
      },
      openCenterTab(key) {
        requirePermission("ui:center-tab");
        assertPluginViewsCanOpen(id);
        const tabId = scopedPluginId(id, key);
        if (!centerTabRegistry.get(tabId)) {
          throw new Error(`[plugins] "${id}" opened unregistered center tab ${tabId}`);
        }
        const owner = detachedOwners.get(tabId);
        if (owner) {
          void owner.present().then(mode => {
            if (detachedOwners.get(tabId) !== owner || !centerTabRegistry.get(tabId)) return;
            assertPluginViewsCanOpen(id);
            if (mode === "docked") dismissCenterSurfaces();
            usePluginTabsStore.getState().openTab(tabId, { activate: mode === "docked", reason: "presentation" });
          }).catch(() => {
            if (detachedOwners.get(tabId) !== owner || !centerTabRegistry.get(tabId)) return;
            try { assertPluginViewsCanOpen(id); } catch { return; }
            // The owner's status renders the native open failure and retry action.
            dismissCenterSurfaces();
            usePluginTabsStore.getState().openTab(tabId, { reason: "presentation" });
          });
          return;
        }
        // 插件页签置前：其他中心面（浏览器/文件/插件中心/工作台/差异）让位；
        // 否则经由插件侧栏入口打开时，页签开了、画面还停在原地。
        dismissCenterSurfaces();
        usePluginTabsStore.getState().openTab(tabId);
      },
      registerUpdateCloseHandler(handler) {
        requirePermission("ui:center-tab");
        if (!handler || typeof handler.prepare !== "function" || typeof handler.resume !== "function") throw new Error("Invalid update close handler");
        return track(registerPluginUpdateCloseHandler(id, {
          prepare: (signal) => runAsPlugin(() => handler.prepare(signal)),
          resume: () => runAsPlugin(() => handler.resume()),
        }));
      },
    },
    theme: {
      injectCss(css) {
        requirePermission("theme");
        return track(mountPluginCss(id, css));
      },
      setTokens(tokens) {
        const css = `${tokenBlock(":root", tokens.light)}\n${tokenBlock(".dark", tokens.dark)}`;
        return ctx.theme.injectCss(css);
      },
    },
    i18n: {
      addBundle(lang, ns, resources) {
        requirePermission("i18n");
        i18n.addResourceBundle(lang, ns, resources, true, true);
        return track(() => {
          // i18next ≥19.10; absence means the bundle stays until reload —
          // acceptable residual state, logged rather than thrown.
          if (typeof i18n.removeResourceBundle === "function") i18n.removeResourceBundle(lang, ns);
        });
      },
    },
    storage: {
      async get<T>(key: string): Promise<T | null> {
        requirePermission("storage");
        const value = await backend.get(id, key);
        return (value ?? null) as T | null;
      },
      async set(key, value) {
        requirePermission("storage");
        assertPluginStorageKey(key);
        await backend.set(id, key, value);
      },
      async delete(key) {
        requirePermission("storage");
        assertPluginStorageKey(key);
        await backend.delete(id, key);
      },
    },
    events: {
      on(topic, cb) {
        requirePermission("events");
        return track(pluginBus.on(topic, (data) => runAsPlugin(() => cb(data))));
      },
      emit(topic, data) {
        requirePermission("events");
        assertPluginEmitTopic(id, topic);
        pluginBus.emit(topic, data);
      },
    },
    composer: {
      setDraft(text) {
        requirePermission("composer:draft");
        setActiveComposerDraft(id, text);
      },
    },
    workspaces: {
      async publishProject(sourceKey, definition) {
        requirePermission("host:workspace");
        // The source identity is bound to this plugin, never supplied by it.
        const result = await backend.bridgeInvoke("plugin_publish_workspace_project", {
          pluginId: id,
          sourceKey,
          input: { name: definition.name, defaultPath: definition.defaultPath, members: definition.members },
        });
        if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string") {
          throw new Error("Invalid project publication response");
        }
        return { id: result.id };
      },
      add(path, meta) {
        requirePermission("host:workspace");
        // meta 带 wsl 键 = 远程工作区(会话流量经 ssh 导向插件指定主机),
        // 需要独立的 host:workspace:remote 授权;判定在 workspace-bridge。
        return addPluginWorkspace(id, path, meta, () =>
          requirePermission("host:workspace:remote"),
        );
      },
    },
    sessions: {
      selectSession(engine, sessionId, workspacePath) {
        requirePermission("host:session");
        // 契约返回 Promise:校验失败走 rejection 而不是同步抛,与
        // workspaces.add 一致(插件可用 .catch 链式处理)。
        return Promise.resolve().then(() =>
          openPluginSession(id, engine, sessionId, workspacePath),
        );
      },
      refresh() {
        requirePermission("host:session");
        // 插件直写会话数据后的可见性补偿：走与宿主自身重命名/置顶一致的
        // refreshSessions，侧栏与标签页立即反映。动态引入避免与 chat store
        // 的模块环（store → plugins/runtime/session-source）。
        return import("@/features/chat/store").then((m) =>
          m.useChatStore.getState().refreshSessions(),
        );
      },
      setEffort(engine, sessionId, workspacePath, effort) {
        requirePermission("host:session");
        // 校验失败走 rejection（与 selectSession 一致）。store 侧拒绝未知
        // 会话键——错误的 workspacePath 不得经 patchSession 造出幽灵条目。
        return Promise.resolve().then(() =>
          import("@/features/chat/store").then((m) =>
            m.setPluginSessionEffort(engine, sessionId, workspacePath, effort),
          ),
        );
      },
      registerSource(def) {
        requirePermission("host:session");
        // 入口校验:不合规 def 同步抛回插件(登记期 bug 应当即暴露),
        // 否则非函数 list 会在每次会话刷新时才炸,且连累其他源。
        if (
          typeof def?.id !== "string" ||
          !def.id ||
          typeof def.list !== "function"
        ) {
          throw new Error(
            `[plugins] "${id}" sessions.registerSource: def must be { id: non-empty string, list: () => Promise<ExternalSessionRow[]> }`,
          );
        }
        return track(
          registerSessionSource(id, def.id, () => runAsPlugin(def.list)),
        );
      },
    },
    conversations: {
      View: ConversationSurface,
      async catalog() { requirePermission("host:chat"); return conversations().catalog(); },
      async open(request) { requirePermission("host:chat"); return conversations().open(request); },
      async inspect(threadId) { requirePermission("host:chat"); return conversations().inspect(threadId); },
      async send(request) { requirePermission("host:chat"); return conversations().send(request); },
      async stop(threadId) { requirePermission("host:chat"); return conversations().stop(threadId); },
      async openFile(threadId, path) { requirePermission("host:chat"); return conversations().openFile(threadId, path); },
      onEvent(callback) {
        requirePermission("host:chat");
        return track(conversations().onEvent((snapshot) => runAsPlugin(() => callback(snapshot))));
      },
    },
    images: {
      async importImage(request) {
        if (manifest.permissions.includes("host:tasks") && !manifest.permissions.includes("host:chat")) {
          requirePermission("host:tasks");
        } else {
          requirePermission("host:chat");
        }
        if (isWeb || (typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) && getCurrentWindow().label.startsWith("plugin-window-"))) {
          throw new Error("host images on PluginContext are available only in the desktop owner");
        }
        if (!request || typeof request !== "object") {
          throw new Error("Invalid image import request");
        }
        const dataBase64 = typeof request.dataBase64 === "string" ? request.dataBase64.trim() : "";
        const mimeType = typeof request.mimeType === "string" ? request.mimeType.trim() : "";
        const name = request.name === undefined ? undefined : typeof request.name === "string" ? request.name : "";
        if (!dataBase64 || !mimeType || (request.name !== undefined && typeof request.name !== "string")) {
          throw new Error("Invalid image import arguments");
        }
        const result = await backend.bridgeInvoke("plugin_image_import", {
          pluginId: id,
          dataBase64,
          mimeType,
          ...(name !== undefined ? { name } : {}),
        });
        if (
          !result ||
          typeof result !== "object" ||
          typeof (result as { id?: unknown }).id !== "string" ||
          typeof (result as { name?: unknown }).name !== "string" ||
          typeof (result as { mimeType?: unknown }).mimeType !== "string" ||
          typeof (result as { size?: unknown }).size !== "number"
        ) {
          throw new Error("Invalid plugin image attachment response");
        }
        return {
          id: (result as { id: string }).id,
          name: (result as { name: string }).name,
          mimeType: (result as { mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }).mimeType,
          size: (result as { size: number }).size,
        };
      },
      async readPreview(imageId) {
        if (manifest.permissions.includes("host:tasks") && !manifest.permissions.includes("host:chat")) {
          requirePermission("host:tasks");
        } else {
          requirePermission("host:chat");
        }
        if (isWeb || (typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata) && getCurrentWindow().label.startsWith("plugin-window-"))) {
          throw new Error("host images on PluginContext are available only in the desktop owner");
        }
        const normalizedId = typeof imageId === "string" ? imageId.trim() : "";
        if (!normalizedId) {
          throw new Error("Invalid plugin image id");
        }
        const result = await backend.bridgeInvoke("plugin_image_preview", {
          pluginId: id,
          imageId: normalizedId,
        });
        if (
          !result ||
          typeof result !== "object" ||
          typeof (result as { dataUrl?: unknown }).dataUrl !== "string" ||
          !(result as { dataUrl: string }).dataUrl.startsWith("data:image/")
        ) {
          throw new Error("Invalid plugin image preview response");
        }
        return { dataUrl: (result as { dataUrl: string }).dataUrl };
      },
    },
    chat: {
      async identity() { requirePermission("host:chat"); return chat().identity(); },
      async current() { requirePermission("host:chat"); return chat().current(); },
      async inspect(target) { requirePermission("host:chat"); return chat().inspect(target); },
      async submit(request) { requirePermission("host:chat"); return chat().submit(request); },
      async receipt(requestId) { requirePermission("host:chat"); return chat().receipt(requestId); },
      onEvent(callback) {
        requirePermission("host:chat");
        return track(chat().onEvent((receipt) => runAsPlugin(() => callback(receipt))));
      },
    },
    tasks: {
      async conversation(id) { requirePermission("host:tasks"); return tasks().conversation(id); },
      async sendMessage(request) { requirePermission("host:tasks"); return tasks().sendMessage(request); },
      async messageReceipt(id, requestId) { requirePermission("host:tasks"); return tasks().messageReceipt(id, requestId); },
      async cancelMessage(id, requestId) { requirePermission("host:tasks"); return tasks().cancelMessage(id, requestId); },
      async stopConversation(id) { requirePermission("host:tasks"); return tasks().stopConversation(id); },
      async conversationAction(id, action) { requirePermission("host:tasks"); return tasks().conversationAction(id, action); },
      onConversationEvent(callback) {
        requirePermission("host:tasks");
        return track(tasks().onConversationEvent(snapshot => runAsPlugin(() => callback(snapshot))));
      },
      async catalog(options) { requirePermission("host:tasks"); return tasks().catalog(options); },
      async history(query) { requirePermission("host:tasks"); return tasks().history(query); },
      async excerpt(query) { requirePermission("host:tasks"); return tasks().excerpt(query); },
      async plan(request) { requirePermission("host:tasks"); return tasks().plan(request); },
      async getPlan(requestId) { requirePermission("host:tasks"); return tasks().getPlan(requestId); },
      async cancelPlan(requestId) { requirePermission("host:tasks"); return tasks().cancelPlan(requestId); },
      async submit(request) { requirePermission("host:tasks"); return tasks().submit(request); },
      async receipt(requestId) { requirePermission("host:tasks"); return tasks().receipt(requestId); },
      async list(query) { requirePermission("host:tasks"); return tasks().list(query); },
      async cancel(requestId) { requirePermission("host:tasks"); return tasks().cancel(requestId); },
      async open(requestId) { requirePermission("host:tasks"); return tasks().open(requestId); },
      async forget(requestId) { requirePermission("host:tasks"); return tasks().forget(requestId); },
      async slots(projectId) { requirePermission("host:tasks"); return tasks().slots(projectId); },
      onEvent(callback) {
        requirePermission("host:tasks");
        return track(tasks().onEvent((receipt) => runAsPlugin(() => callback(receipt))));
      },
    },
    memoryExtraction: {
      async status() { requirePermission("host:memory"); return memoryExtraction().status(); },
      async checkpoint(request) { requirePermission("host:memory"); return memoryExtraction().checkpoint(request); },
      async prepare(request) { requirePermission("host:memory"); return memoryExtraction().prepare(request); },
      async extract(request) { requirePermission("host:memory"); return memoryExtraction().extract(request); },
      async cancel(requestId) { requirePermission("host:memory"); return memoryExtraction().cancel(requestId); },
    },
    agent: {
      async catalog(workspacePath) {
        requirePermission("agent");
        if (!backend.agentCatalog) throw new Error("Plugin agent catalog is unavailable on this host");
        return backend.agentCatalog(workspacePath);
      },
      start(def) {
        requirePermission("agent");
        if (def.requestId !== undefined && !/^[a-fA-F0-9]{32}$/.test(def.requestId)) {
          throw new Error("Plugin agent requestId must contain exactly 32 hexadecimal characters");
        }
        return backend.bridgeInvoke("plugin_agent_start", {
          pluginId: id,
          engine: def.engine,
          prompt: def.prompt,
          workspacePath: def.workspacePath,
          model: def.model ?? null,
          providerId: def.providerId ?? null,
          sessionId: def.sessionId ?? null,
          readOnly: def.readOnly ?? false,
          requestId: def.requestId ?? null,
        }) as Promise<{ runId: string; sessionId: string | null }>;
      },
      async interrupt(runId) {
        requirePermission("agent");
        return await backend.bridgeInvoke("plugin_agent_interrupt", { pluginId: id, runId }) as boolean;
      },
    },
    bridge: {
      invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
        // JS 侧预检（DX；真边界是 Rust 侧的服务端强制）：授权未命中即
        // reject，不打 IPC。通过后注入 pluginId 再 invoke。
        if (command === "plugin_http_request") {
          const url = typeof args.url === "string" ? args.url : "";
          if (!networkGrantAllows(manifest.permissions, url)) {
            return Promise.reject(
              new Error(
                `[plugins] "${id}" http request to ${url || "(invalid url)"} matches no declared network: grant`,
              ),
            );
          }
        } else if (command === "plugin_exec_run" || command === "plugin_exec_spawn") {
          const bin = typeof args.bin === "string" ? args.bin : "";
          if (!execGrantAllows(manifest.permissions, bin)) {
            return Promise.reject(
              new Error(
                `[plugins] "${id}" exec of "${bin || "(invalid bin)"}" matches no declared exec: grant`,
              ),
            );
          }
        } else if (command === "plugin_exec_kill") {
          // Kills only this plugin's own tracked children; requiring some
          // exec: grant keeps the capability auditable in the manifest.
          if (!manifest.permissions.some((p) => p.startsWith("exec:"))) {
            return Promise.reject(
              new Error(`[plugins] "${id}" used plugin_exec_kill without any exec: grant`),
            );
          }
        } else if (command === "plugin_agent_start" || command === "plugin_agent_interrupt") {
          // 通用出口与 ctx.agent 同一能力：引擎管线走宿主（渠道/注册表/
          // 事件流）；run id 的属主前缀在 Rust 侧强制。
          if (!manifest.permissions.includes("agent")) {
            return Promise.reject(
              new Error(`[plugins] "${id}" used ${command} without declaring "agent" in permissions`),
            );
          }
        } else {
          return Promise.reject(
            new Error(
              `[plugins] unknown bridge command "${command}" (available: plugin_http_request / plugin_exec_run / plugin_exec_spawn / plugin_exec_kill / plugin_agent_start / plugin_agent_interrupt)`,
            ),
          );
        }
        // Not wrapped in runAsPlugin: the hardening guard would reject the
        // call it makes through the host's own transport. The grant checks
        // above are the DX gate; the invoke itself is host-authorized.
        return backend.bridgeInvoke(command, { ...args, pluginId: id }) as Promise<T>;
      },
    },
    host: {
      whenReady: whenRuntimeSubmissionResumed,
      appVersion: hostInfo.appVersion,
      sdkVersion: SDK_VERSION,
      isWeb,
      get locale() {
        return i18n.language;
      },
    },
  };

  return { manifest, ctx, disposers };
}
