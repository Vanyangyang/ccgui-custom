import { create } from "zustand";
import { invoke, isWeb } from "@/lib/transport";
import { holdRuntimeSubmissions } from "@/lib/runtime-checkpoint";
import { readTaskShutdownBusy } from "./activity";

export interface TaskShutdownStatus {
  supported: boolean;
  phase: "off" | "waiting" | "countdown" | "requested" | "failed";
  remainingSeconds: number | null;
  blockers: string[];
  generation: number;
  error: string | null;
}
export interface TaskShutdownState {
  status: TaskShutdownStatus | null;
  pending: boolean;
  desiredEnabled: boolean;
  start: () => () => void;
  dispose: () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
}
interface Dependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  readBusy: () => boolean;
  holdSubmissions?: () => () => void;
  web?: boolean;
}
const off = (): TaskShutdownStatus => ({ supported: true, phase: "off", remainingSeconds: null, blockers: [], generation: 0, error: null });
const armed = (status: TaskShutdownStatus | null) => status?.phase === "waiting" || status?.phase === "countdown";
function parseStatus(value: TaskShutdownStatus): TaskShutdownStatus {
  if (!value || typeof value.supported !== "boolean" || !["off", "waiting", "countdown", "requested", "failed"].includes(value.phase)
    || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !(value.remainingSeconds === null || (Number.isFinite(value.remainingSeconds) && value.remainingSeconds >= 0))
    || !Array.isArray(value.blockers) || value.blockers.some(item => typeof item !== "string")
    || !(value.error === null || typeof value.error === "string")) throw new Error("Invalid task shutdown status");
  return value;
}

export function createTaskShutdownStore(deps: Dependencies) {
  let running = false;
  let revision = 0;
  let lifecycle = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollingLifecycle: number | null = null;
  // Serialize only mutations. A stalled poll must never delay cancellation.
  let mutation: Promise<void> = Promise.resolve();
  let pendingTarget: boolean | undefined;
  let releaseHold: (() => void) | undefined;
  const cancelNative = async () => { await deps.invoke<TaskShutdownStatus>("task_shutdown_set", { enabled: false }); };
  // Cleanup shares the mutation queue: a late old arm is cancelled before any
  // subsequent arm, including one issued by an immediately remounted runtime.
  const queueCancellation = () => {
    const held = releaseHold;
    mutation = mutation.then(cancelNative).catch(() => {}).finally(() => {
      if (held && releaseHold === held) { releaseHold = undefined; held(); }
    });
  };
  const store = create<TaskShutdownState>((set, get) => {
    const fail = (cause: unknown) => {
      set({ status: { ...(get().status ?? off()), phase: "failed", remainingSeconds: null,
        error: cause instanceof Error ? cause.message : String(cause) }, desiredEnabled: false });
      // Stop advancing immediately; loss of communication must fail closed.
      queueCancellation();
    };
    const poll = async () => {
      if (!running || pollingLifecycle === lifecycle || get().pending || !armed(get().status)) return;
      const token = revision;
      const life = lifecycle;
      pollingLifecycle = life;
      let release: (() => void) | undefined;
      try {
        const frontendBusy = deps.readBusy();
        const current = get().status!;
        if (!frontendBusy && current.phase === "countdown" && (current.remainingSeconds ?? 60) <= 1) {
          release = deps.holdSubmissions?.();
          releaseHold = release;
        }
        const status = parseStatus(await deps.invoke<TaskShutdownStatus>("task_shutdown_poll", {
          generation: current.generation, frontendBusy, allowShutdown: Boolean(release),
        }));
        if (running && lifecycle === life && revision === token) set({ status, desiredEnabled: armed(status) });
      } catch (cause) {
        if (running && lifecycle === life && revision === token) fail(cause);
      } finally {
        if (release && releaseHold === release) { releaseHold = undefined; release(); }
        if (pollingLifecycle === life) pollingLifecycle = null;
      }
    };
    const dispose = () => {
      if (!running) return;
      running = false;
      ++lifecycle;
      ++revision;
      clearInterval(timer); timer = undefined;
      pendingTarget = undefined;
      set({ status: null, pending: false, desiredEnabled: false });
      if (!deps.web) queueCancellation();
    };
    return {
      status: deps.web ? { ...off(), supported: false } : null,
      pending: false,
      desiredEnabled: false,
      dispose,
      start: () => {
        if (running || deps.web) return () => {};
        running = true;
        const life = ++lifecycle;
        const token = ++revision;
        timer = setInterval(() => { void poll(); }, 1_000);
        // Read after any cleanup from the previous mount has settled.
        void mutation.then(async () => {
          if (!running || lifecycle !== life) return;
          try {
            const status = parseStatus(await deps.invoke<TaskShutdownStatus>("task_shutdown_status"));
            if (running && lifecycle === life && revision === token) set({ status, desiredEnabled: armed(status) });
          } catch (cause) { if (running && lifecycle === life && revision === token) fail(cause); }
        });
        return () => { if (lifecycle === life) dispose(); };
      },
      setEnabled: enabled => {
        if (deps.web || !running || get().status?.supported === false) return Promise.resolve();
        if (pendingTarget === enabled) return mutation;
        const token = ++revision;
        const life = lifecycle;
        pendingTarget = enabled;
        set({ pending: true, desiredEnabled: enabled });
        mutation = mutation.then(async () => {
          if (!running || lifecycle !== life) return;
          try {
            const status = parseStatus(await deps.invoke<TaskShutdownStatus>("task_shutdown_set", { enabled }));
            if (!enabled && releaseHold) { const release = releaseHold; releaseHold = undefined; release(); }
            if (running && lifecycle === life && revision === token) set({ status, desiredEnabled: armed(status) });
          } catch (cause) {
            if (running && lifecycle === life && revision === token) fail(cause);
          } finally {
            if (running && lifecycle === life && revision === token) {
              pendingTarget = undefined;
              set({ pending: false });
            }
          }
        });
        return mutation;
      },
    };
  });
  return store;
}

export const useTaskShutdownStore = createTaskShutdownStore({ invoke, readBusy: readTaskShutdownBusy, holdSubmissions: holdRuntimeSubmissions, web: isWeb });
export const startTaskShutdownRuntime = () => useTaskShutdownStore.getState().start();
