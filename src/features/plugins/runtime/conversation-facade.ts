import type { ConversationCatalog, ConversationSelection, Disposer } from "@ccgui/plugin-sdk";
import type { SidechatState } from "@/features/sidechat/store";
import { desktopTaskFacade, registeredWorkspace } from "./task-facade";
import { sameTaskPath } from "./task-paths";
import { nativeFixedInstructionsSupported } from "./fixed-instructions";
import { getEffortLevels, getDefaultEffort, normalizeEffortLevel, EFFORT_LABEL_KEYS } from "@/components/application/ai-chat/effort-levels";
import i18n from "@/lib/i18n";

/** Host-only seam; no Zustand objects or native handles cross the SDK boundary. */
export interface HostConversationFacade {
  claim(pluginId: string, threadId: string): Promise<void>;
  resolveSelection(pluginId: string, selection: ConversationSelection): Promise<ConversationSelection>;
  resolveImages?(pluginId: string, imageIds: string[]): Promise<string[]>;
  catalog(): Promise<ConversationCatalog>;
  workspace(path: string): Promise<string>;
  read(key: string): SidechatState | undefined;
  restore(key: string, state: SidechatState): void;
  send(key: string, workspacePath: string, selection: ConversationSelection, prompt: string, runId: string, images?: string[]): Promise<void>;
  stop(key: string, runId: string): Promise<void>;
  openFile(workspacePath: string, path: string): Promise<void>;
  subscribe(callback: () => void): Disposer;
}

let cached: Promise<HostConversationFacade> | undefined;
export function desktopConversationFacade(): Promise<HostConversationFacade> {
  return cached ??= (async (): Promise<HostConversationFacade> => {
    const [task, { useSidechatStore }, { ipc }, { invoke }] = await Promise.all([
      desktopTaskFacade(), import("@/features/sidechat/store"), import("@/lib/ipc"),
      import("@/lib/transport"),
    ]);
    await task.ready();
    const workspaces = async (): Promise<ConversationCatalog["workspaces"]> => {
      const result = task.workspaces().filter((w) => !w.remote && !w.archived)
        .map(({ id, path, name }) => ({ id, path, name }));
      for (const project of await task.projects()) {
        const root = registeredWorkspace(task, project.defaultPath);
        if (!root || root.remote || root.archived) continue;
        for (const member of project.members) {
          if (member.status !== "available" || result.some((w) => sameTaskPath(w.path, member.path))) continue;
          // Available members of a current local project are host registrations,
          // not arbitrary paths supplied by the plugin.
          result.push({ id: `${project.id}:${member.id}`, path: member.path, name: member.label });
        }
      }
      return result;
    };
    return {
      claim: (pluginId, threadId) => invoke<void>("plugin_conversation_claim", { pluginId, threadId }),
      resolveSelection: (pluginId, selection) => invoke<ConversationSelection>("plugin_conversation_resolve", { pluginId, selection }),
      resolveImages: (pluginId, imageIds) => invoke<string[]>("plugin_image_resolve", { pluginId, imageIds }),
      async catalog() {
        const config = await ipc.getCliConfig();
        const engines: ConversationCatalog["engines"] = [];
        for (const id of ["claude", "codex"] as const) {
          const info = task.engines().find((e) => e.id === id);
          if (!info?.available || !info.enabled) continue;
          const section = config[id];
          engines.push({ id, label: id === "claude" ? "Claude" : "Codex", available: true,
            supportsImages: info.supportsImages === true,
            models: (await task.models(id)).map((m) => ({ id: m.id, label: m.name || m.id })),
            providers: [{ id: "__local_settings_json__", label: i18n.t("settings.cliOfficial") },
              ...Object.entries(section.providers).filter(([key]) => key !== "__local_settings_json__").map(([key, raw]) => ({
                id: key, label: raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string" ? raw.name : key,
              }))],
            efforts: getEffortLevels(id).map(effort => ({ id: effort, label: i18n.t(EFFORT_LABEL_KEYS[effort]) })),
            defaultModel: info.defaultModel, defaultEffort: normalizeEffortLevel(id, info.defaultEffort) || getDefaultEffort(id),
            defaultProviderId: section.current || "__local_settings_json__",
          });
        }
        const preferred = task.activeEngine();
        return { capabilities: { images: true, fixedInstructions: await nativeFixedInstructionsSupported() }, engines, workspaces: await workspaces(), ...(preferred ? { defaultEngine: preferred } : {}) };
      },
      async workspace(path) {
        const workspace = (await workspaces()).find((w) => sameTaskPath(w.path, path));
        if (workspace) return workspace.path;
        throw new Error("Conversation workspace must be a registered local non-archived workspace");
      },
      read: (key) => useSidechatStore.getState().sidechatBySession[key],
      restore(key, state) {
        if (useSidechatStore.getState().sidechatBySession[key]) return;
        useSidechatStore.setState((s) => ({ sidechatBySession: { ...s.sidechatBySession, [key]: state } }));
      },
      async send(key, workspacePath, selection, prompt, runId, images) {
        await useSidechatStore.getState().sendSidechatMessage({ sessionKey: key,
          workspacePath, ...selection, parentSessionId: null, parentMessages: [], prompt,
          ...(images && images.length > 0 ? { images } : {}),
          requestedRunId: runId, strictBusy: true });
      },
      async stop(key, runId) {
        const current = useSidechatStore.getState().sidechatBySession[key];
        // A stop request is not terminal proof. Keep routing and streaming until
        // the native event for this exact run settles the SidechatStore.
        if (current?.streaming && current.runId === runId) await ipc.interruptSession(runId);
      },
      async openFile(workspacePath, path) {
        const [{ resolveChatProjectFileLink }, { useFilesStore }, { getCurrentWindow }] = await Promise.all([
          import("@/features/chat/project-file-links"), import("@/features/files/store"), import("@tauri-apps/api/window"),
        ]);
        const resolved = await resolveChatProjectFileLink(path, workspacePath);
        if (!resolved) throw new Error("Discussion file link could not be resolved");
        await useFilesStore.getState().openFile(resolved);
        await getCurrentWindow().show(); await getCurrentWindow().setFocus();
      },
      subscribe: (callback) => useSidechatStore.subscribe(callback),
    };
  })().catch((error) => { cached = undefined; throw error; });
}
