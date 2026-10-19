import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ipc, type CliVersionStatus } from "@/lib/ipc";
import { invoke, listen } from "@/lib/transport";
import { listenCliUpdateProgress } from "@/lib/events";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";
import i18n from "@/lib/i18n";
import type { EngineId } from "./providers";

/**
 * Session-local store for managed-CLI version status, one entry per engine.
 * The CLI 管理 header and the DSH host card both read it, so probes are
 * deduped: switching engine pages repaints from cache instantly and only
 * soft-refreshes in the background, and concurrent consumers share one
 * in-flight probe. No polling — refresh happens on page mount and explicit
 * user action only (each probe spawns `<bin> --version` + `npm view`).
 */

interface Entry {
  status: CliVersionStatus | null;
  /** A probe is in flight; a cached status stays visible meanwhile. */
  loading: boolean;
  error: string | null;
  updating: boolean;
  inflight: Promise<void> | null;
  updateSnapshot: CliUpdateSnapshot | null;
  recovering: Promise<CliUpdateSnapshot | null> | null;
  reconnectRevision: number;
}

export interface CliUpdateSnapshot {
  engine: string;
  runId: string;
  status: "running" | "done" | "error";
  sequence: number;
  logs: Array<{ stream: "stdout" | "stderr"; text: string; sequence: number }>;
  error: string | null;
  version: string | null;
}

const EMPTY: Entry = {
  status: null,
  loading: false,
  error: null,
  updating: false,
  inflight: null,
  updateSnapshot: null,
  recovering: null,
  reconnectRevision: 0,
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const observers = new Map<EngineId, { count: number; off: () => void }>();
const recoverAgain = new Set<EngineId>();
const progressEpochs = new Map<EngineId, number>();
const hostEpochs = new Map<EngineId, number>();

export async function readCliUpdateSnapshot(engine: EngineId): Promise<CliUpdateSnapshot | null> {
  return invoke<CliUpdateSnapshot | null>("cli_update_snapshot", { engine });
}

function recoverUpdate(engine: EngineId): Promise<CliUpdateSnapshot | null> {
  const previous = entries.get(engine) ?? EMPTY;
  if (previous.recovering) { recoverAgain.add(engine); return previous.recovering; }
  const task = (async () => {
    let snapshot: CliUpdateSnapshot | null = null;
    do {
      recoverAgain.delete(engine);
      const hostEpoch = hostEpochs.get(engine) ?? 0;
      const progressEpoch = progressEpochs.get(engine) ?? 0;
      try { snapshot = await readCliUpdateSnapshot(engine); }
      catch (error) {
        if (hostEpoch !== (hostEpochs.get(engine) ?? 0) || recoverAgain.has(engine)) { recoverAgain.add(engine); continue; }
        throw error;
      }
      if (hostEpoch !== (hostEpochs.get(engine) ?? 0) ||
          (snapshot === null && progressEpoch !== (progressEpochs.get(engine) ?? 0))) {
        // This response predates a new host or newly observed installer.
        recoverAgain.add(engine);
        continue;
      }
    const current = entries.get(engine) ?? EMPTY;
    if (snapshot?.engine === engine && (current.updateSnapshot?.sequence ?? -1) <= snapshot.sequence) {
      patch(engine, { updateSnapshot: snapshot, updating: snapshot.status === "running" });
    } else if (snapshot === null) {
      patch(engine, { updateSnapshot: null, updating: false });
    }
    } while (recoverAgain.has(engine));
    return snapshot;
  })();
  patch(engine, { recovering: task });
  void task.finally(() => patch(engine, { recovering: null })).catch(() => {});
  return task;
}

function observe(engine: EngineId) {
  const existing = observers.get(engine);
  if (existing) existing.count += 1;
  else {
    let disposed = false;
    const recover = () => { if (!disposed) void recoverUpdate(engine).catch(() => {}); };
    const offProgress = subscribeTauriEvent(() => listenCliUpdateProgress((events) => {
      for (const event of events) {
        if (disposed || event.engine !== engine) continue;
        progressEpochs.set(engine, (progressEpochs.get(engine) ?? 0) + 1);
        if (event.phase === "settled" || event.phase === "finished") { recover(); continue; }
        const current = entries.get(engine)?.updateSnapshot;
        const sequence = event.sequence ?? ((current?.sequence ?? 0) + 1);
        if (current && sequence <= current.sequence) continue;
        // Late lines from a settled run cannot resurrect it.
        if (current?.runId === event.runId && current.status !== "running") continue;
        const snapshot: CliUpdateSnapshot = current?.runId === event.runId ? current : {
          engine, runId: event.runId, status: "running", sequence: 0, logs: [], error: null, version: null,
        };
        const logs = event.phase === "stdout" || event.phase === "stderr"
          ? [...snapshot.logs, { stream: event.phase, text: event.line ?? "", sequence }].slice(-200)
          : snapshot.logs;
        patch(engine, { updating: true, updateSnapshot: { ...snapshot, logs, sequence } });
      }
    }));
    const offConnected = subscribeTauriEvent(() => listen("transport://connected", () => {
      // A restarted host begins a fresh event sequence.
      hostEpochs.set(engine, (hostEpochs.get(engine) ?? 0) + 1);
      patch(engine, { updateSnapshot: null });
      void recoverUpdate(engine).then(() => {
        if (!disposed) patch(engine, { reconnectRevision: (entries.get(engine)?.reconnectRevision ?? 0) + 1 });
      }).catch(() => {});
      if (!disposed) void refresh(engine);
    }));
    const offConfig = subscribeTauriEvent(() => listen<{ engine: string }>("engine-config://changed", (event) => {
      if (!disposed && event.payload.engine === engine) void refresh(engine);
    }));
    observers.set(engine, { count: 1, off: () => { disposed = true; offProgress(); offConnected(); offConfig(); } });
    recover();
  }
  return () => {
    const observer = observers.get(engine);
    if (observer && --observer.count === 0) { observer.off(); observers.delete(engine); }
  };
}

function patch(engine: EngineId, partial: Partial<Entry>) {
  entries.set(engine, { ...(entries.get(engine) ?? EMPTY), ...partial });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Probe (or share the in-flight probe for) an engine's version status. */
function refresh(engine: EngineId): Promise<void> {
  const current = entries.get(engine) ?? EMPTY;
  if (current.inflight) return current.inflight;
  const task = (async () => {
    try {
      const status = await ipc.cliVersionStatus(engine);
      patch(engine, { status, loading: false, error: null });
    } catch (e) {
      patch(engine, {
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  patch(engine, { loading: true, inflight: task });
  return task.finally(() => patch(engine, { inflight: null }));
}

/** Install/update an engine, then re-probe so badges reflect the result.
 *  `runId` scopes the streamed `cli://update-progress` events to this run. */
async function update(engine: EngineId, runId: string): Promise<void> {
  patch(engine, { updating: true, error: null });
  try {
    const result = await ipc.cliUpdate(engine, runId);
    if (!result.ok) throw new Error(i18n.t("settings.cliUpdateFailed"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try { await recoverUpdate(engine); } catch { /* Recover on the next handshake. */ }
    const snapshot = entries.get(engine)?.updateSnapshot;
    patch(engine, { updating: snapshot?.status === "running" || message.includes("web bridge disconnected"), error: message });
    throw e;
  }
  try { await recoverUpdate(engine); } catch { /* The invoke itself acknowledged success. */ }
  patch(engine, { updating: entries.get(engine)?.updateSnapshot?.status === "running" });
  await refresh(engine);
}

/** What the hook hands to components: latest probe state + actions. */
export interface CliVersionStatusView {
  status: CliVersionStatus | null;
  loading: boolean;
  error: string | null;
  updating: boolean;
  updateSnapshot: CliUpdateSnapshot | null;
  reconnectRevision: number;
  refresh: () => void;
  update: (runId: string) => Promise<void>;
}

export function useCliVersionStatus(engine: EngineId): CliVersionStatusView {
  useEffect(() => {
    void refresh(engine);
    return observe(engine);
  }, [engine]);
  const entry = useSyncExternalStore(subscribe, () => entries.get(engine) ?? EMPTY);
  return {
    status: entry.status,
    loading: entry.loading,
    error: entry.error,
    updating: entry.updating,
    updateSnapshot: entry.updateSnapshot,
    reconnectRevision: entry.reconnectRevision,
    refresh: useCallback(() => void refresh(engine), [engine]),
    update: useCallback((runId: string) => update(engine, runId), [engine]),
  };
}
