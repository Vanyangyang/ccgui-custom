import { cloneCheckpointValue, runtimeCheckpoint, type RuntimeCheckpoint } from "@/lib/runtime-checkpoint";

// Keep this allowlist aligned with plugins::require_supported_plugin. Missing
// owners outside this explicit retirement must still block health confirmation.
export function isRetiredHostChatPlugin(id: string): boolean {
  return id === "spellcast-canvas-bridge";
}

/** A retired plugin has no execution owner. Retain its old state as inert data
 * across handoffs, without loading its bundle, replaying requests or touching KV.
 * Importing this module must not register participants before initialization. */
export function retainRetiredHostChatCheckpoints(
  checkpoint: RuntimeCheckpoint,
  coordinator: Pick<typeof runtimeCheckpoint, "register"> = runtimeCheckpoint,
): () => void {
  const id = "host-chat-bridge:spellcast-canvas-bridge";
  if (!Object.hasOwn(checkpoint.participants, id)) return () => {};
  let snapshot: unknown;
  return coordinator.register({
    id,
    restore(value) {
      const state = value as { version?: unknown; pluginId?: unknown } | null;
      if (state?.version !== 1 || state.pluginId !== "spellcast-canvas-bridge") {
        throw new Error("Invalid retired host chat bridge checkpoint");
      }
      snapshot = cloneCheckpointValue(value);
    },
    capture: () => cloneCheckpointValue(snapshot),
  });
}
