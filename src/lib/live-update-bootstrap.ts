import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { initializeRuntimeCheckpoint, awaitRuntimeCheckpointReady, resumeCommittedRuntimeCheckpoint, type RuntimeCheckpoint } from "./runtime-checkpoint";
import { initializeWorkerEvents, resumeWorkerEvents, isWeb, invoke } from "./transport";
import { isRetiredHostChatPlugin, retainRetiredHostChatCheckpoints } from "@/features/plugins/runtime/retired-checkpoints";

interface RestartResumeSession { engine: string; sessionId: string; workspacePath: string; prompt?: string }
interface FrontendReadyAck { resumeSessions?: RestartResumeSession[] }
interface Recovery { transactionId?: string; observer?: boolean; checkpoint: RuntimeCheckpoint; cursors: Record<string, number> }
const missing = (error: unknown, command: string) => new RegExp(`(?:unknown command[: ]*${command}|command ['\"]?${command}['\"]? (?:was )?not found)`, "i")
  .test(error instanceof Error ? error.message : String(error));

/** Runs before React stores import: state and per-source cursors share one cut. */
export async function prepareLiveUpdateBootstrap(): Promise<() => Promise<void>> {
  let recovery: Recovery | null = null;
  let supported = !isWeb;
  if (!isWeb) {
    try { recovery = await nativeInvoke<Recovery | null>("live_update_bootstrap"); }
    catch (error) { if (!missing(error, "live_update_bootstrap")) throw error; supported = false; }
  } else {
    try { recovery = await invoke<Recovery | null>("runtime_observer_snapshot"); supported = !!recovery; }
    catch (error) { if (!missing(error, "runtime_observer_snapshot")) throw error; }
  }
  initializeRuntimeCheckpoint(recovery?.checkpoint, recovery?.observer ? {requiredParticipants:["chat"]} : undefined);
  if (recovery && !recovery.observer) {
    const dispose = retainRetiredHostChatCheckpoints(recovery.checkpoint);
    if (import.meta.hot) import.meta.hot.dispose(dispose);
  }
  if (recovery) document.documentElement.inert = true;
  await initializeWorkerEvents(recovery?.cursors);
  await import("./app-runtime-checkpoint");
  return async () => {
    if (!supported) return;
    if (recovery?.observer) {
      // This viewer owns no copied queue, ask loop, or source window promise.
      // Native approval facts may remain pending without blocking observation.
      const { useChatStore } = await import("@/features/chat/store");
      await useChatStore.getState().init();
      await resumeWorkerEvents();
      try { resumeCommittedRuntimeCheckpoint(); }
      finally { document.documentElement.inert = false; }
      return;
    }
    if (!recovery) {
      const { useChatStore } = await import("@/features/chat/store");
      await useChatStore.getState().init();
      const { installRuntimeObserverResponder } = await import("./runtime-observer");
      const dispose = await installRuntimeObserverResponder();
      if (import.meta.hot) import.meta.hot.dispose(dispose);
      const ready = await nativeInvoke<FrontendReadyAck | null>("live_update_frontend_ready");
      if (Array.isArray(ready?.resumeSessions)) {
        for (const item of ready.resumeSessions) {
          if (!item?.engine || !item?.sessionId || !item?.workspacePath) continue;
          try {
            const store = useChatStore.getState();
            const isForeground =
              !store.active ||
              (store.active.engine === item.engine &&
                store.active.sessionId === item.sessionId &&
                store.active.workspacePath === item.workspacePath);
            await store.selectSession?.(item.engine, item.sessionId, item.workspacePath, {
              background: !isForeground,
            });
            await store.send?.(
              typeof item.prompt === "string" && item.prompt.trim() ? item.prompt : "继续",
              [],
              undefined,
              { engine: item.engine, sessionId: item.sessionId, workspacePath: item.workspacePath },
            );
          } catch (error) {
            console.warn("[bootstrap] restart session auto-resume failed:", error);
          }
        }
      }
      return;
    }
    // React mounts are concurrent and StrictMode may remount bridge effects.
    // Readiness is checked without releasing queue or mutation ownership.
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (recovery && !recovery.observer) {
          const { pendingHostChatPluginIds } = await import("@/features/plugins/runtime/chat-bridge");
          const ids = pendingHostChatPluginIds(recovery.checkpoint).filter(id => !isRetiredHostChatPlugin(id));
          if (ids.length) {
            const { prewarmHostChatBridges } = await import("@/features/plugins/runtime/loader");
            await prewarmHostChatBridges(ids);
          }
        }
        await awaitRuntimeCheckpointReady();
        lastError = undefined;
        break;
      } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (lastError) throw lastError;
    if (recovery) {
      await resumeWorkerEvents();
      await awaitRuntimeCheckpointReady();
      const { installRuntimeObserverResponder } = await import("./runtime-observer");
      const dispose = await installRuntimeObserverResponder();
      if (import.meta.hot) import.meta.hot.dispose(dispose);
      // Do not dispatch queued work until the native owner commits health.
      // Retrying this same transaction is idempotent after an uncertain ACK.
      for (let attempt = 0; ; attempt++) {
        try { await nativeInvoke("live_update_confirm", { transactionId: recovery.transactionId }); break; }
        catch (error) { if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1))); }
      }
      try { resumeCommittedRuntimeCheckpoint(); }
      finally { document.documentElement.inert = false; }
    }
  };
}
