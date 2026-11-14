import type { Disposer, HostHandoffApi, HostHandoffPreferences, HostHandoffManagedChildSource, HostHandoffCoordinatorSource, HostHandoffSelection } from "@ccgui/plugin-sdk";
import { readHandoffCompressionPreferences } from "@/features/chat/handoff-preferences";
import { createHandoffCompressionRuntime } from "@/features/chat/handoff-compression-runtime";
import { runtimeCheckpoint } from "@/lib/runtime-checkpoint";
import type { PluginContextBackend } from "./context";
import { ipc } from "@/lib/ipc";
import { isHandoffCompressionSelection } from "@/features/chat/handoff-preferences";
import { withHandoffProgress, type HandoffProgressCallback } from "@/lib/handoff-progress";

export const HOST_HANDOFF_KEY_PREFIX = "__host_handoff_v1:";
const controllers = new Map<string, HostHandoffApi>();
const bindings = new Map<string, HandoffBridgeDependencies>();

export interface HandoffBridgeDependencies {
  singleton?: boolean;
  preferences?(): HostHandoffPreferences;
  supportsFullHistory?(): Promise<boolean>;
  summarizeManagedChild?(source: HostHandoffManagedChildSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string>;
  summarizeCoordinatorHandoff?(source: HostHandoffCoordinatorSource, selection: HostHandoffSelection, onProgress?: HandoffProgressCallback): Promise<string>;
  chooseModel?: NonNullable<HostHandoffApi["chooseModel"]>;
  catalog?: NonNullable<HostHandoffApi["catalog"]>;
  checkpoint?: Pick<typeof runtimeCheckpoint, "assertAllowed" | "registerBlocker">;
}

/** Document singleton keeps native ownership across plugin reloads. Wrapper
 * disposal only detaches its listeners; it never discards or cancels work. */
export function createHostHandoffBridge(pluginId: string, backend: PluginContextBackend,
  dependencies?: HandoffBridgeDependencies): HostHandoffApi & { dispose: Disposer } {
  const singleton = !dependencies || dependencies.singleton === true;
  if (singleton) bindings.set(pluginId, dependencies ?? {});
  const current = () => singleton ? bindings.get(pluginId)! : dependencies!;
  let controller = singleton ? controllers.get(pluginId) : undefined;
  if (!controller) {
    controller = createHandoffCompressionRuntime({
      scope: `plugin-handoff:${pluginId}`,
      load: handoffId => backend.get(pluginId, HOST_HANDOFF_KEY_PREFIX + handoffId),
      save: (handoffId, value) => backend.set(pluginId, HOST_HANDOFF_KEY_PREFIX + handoffId, value),
      preferences: dependencies?.preferences ?? readHandoffCompressionPreferences,
      checkpoint: dependencies?.checkpoint,
      submit: async (input, selection, onProgress) => {
        if (await (current()?.supportsFullHistory ?? ipc.handoffFullHistorySupported)().catch(() => false) !== true) throw new Error("Full-history Handoff requires an updated native host");
        if (input.source) {
          if (input.source.kind === "coordinator") {
            const resolve = current()?.summarizeCoordinatorHandoff;
            if (!resolve) throw new Error("Owned coordinator Handoff source is unavailable");
            return resolve(input.source, selection, onProgress);
          }
          const resolve = current()?.summarizeManagedChild;
          if (!resolve) throw new Error("Owned managed-child Handoff source is unavailable");
          return resolve(input.source, selection, onProgress);
        }
        return withHandoffProgress(progress => backend.bridgeInvoke("plugin_summarize_handoff", {
          pluginId, title: input.title, transcriptExcerpt: input.text, childContext: input.childContext,
          compressionSelection: selection, fullHistory: true, ...(progress ? { progress } : {}),
        }) as Promise<string>, onProgress);
      },
    });
    if (singleton) controllers.set(pluginId, controller);
  }
  let disposed = false;
  const subscriptions = new Set<Disposer>();
  const live = () => { if (disposed) throw new Error("Handoff facade disposed"); return controller!; };
  return {
    async catalog(options = {}) {
      live();
      const frozen = structuredClone(options);
      if (!frozen || typeof frozen !== "object" || Array.isArray(frozen) || Object.keys(frozen).some(key => key !== "selection") ||
        frozen.selection !== undefined && !isHandoffCompressionSelection(frozen.selection)) throw new Error("Invalid handoff model catalog options");
      const selection = frozen.selection ?? (await live().preferences()).selection;
      const read = current()?.catalog ?? (async ({ selection: chosen }: { selection?: HostHandoffSelection }) =>
        (await import("@/features/chat/handoff-model-catalog")).readHandoffModelCatalog(chosen!));
      const catalog = await read({ selection: structuredClone(selection) });
      live();
      return structuredClone(catalog);
    },
    async chooseModel(options = {}) {
      live();
      const frozen = structuredClone(options);
      if (Object.keys(frozen).some(key => !["workspacePath", "selection"].includes(key)) || frozen.workspacePath !== undefined && (typeof frozen.workspacePath !== "string" || frozen.workspacePath.length > 4096 || /[\u0000-\u001f]/.test(frozen.workspacePath)) ||
        frozen.selection !== undefined && !isHandoffCompressionSelection(frozen.selection)) throw new Error("Invalid handoff model picker options");
      const choose = current()?.chooseModel ?? (await import("@/features/chat/handoff-model-picker")).chooseHandoffModel;
      return choose({ workspacePath: frozen.workspacePath ?? "", selection: frozen.selection ?? (await live().preferences()).selection });
    },
    preferences: () => live().preferences(), summarize: input => live().summarize(input), inspect: handoffId => live().inspect(handoffId),
    discard: (handoffId, requestId) => live().discard(handoffId, requestId),
    onEvent(callback) {
      const off = live().onEvent(callback);
      const dispose = () => { off(); subscriptions.delete(dispose); };
      subscriptions.add(dispose); return dispose;
    },
    dispose() { disposed = true; for (const off of subscriptions) off(); subscriptions.clear(); },
  };
}
