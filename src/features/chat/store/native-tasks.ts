import type { NativeTask } from "@/lib/events";
import type { NativeTaskStopResult } from "@/lib/ipc";
import { setNativeBackgroundActive, type BySessionSlice, type SessionState, type SetFn } from "./stream";

/** Within one run, a task id denotes one execution. A confirmed terminal from
 * an event or stop result must survive a delayed running/paused snapshot;
 * other incoming fields and statuses remain authoritative. */
export function mergeNativeTaskSnapshot(previous: NativeTask[] | undefined, incoming: NativeTask[]): NativeTask[] {
  if (!previous?.length) return incoming;
  const confirmed = new Map(previous.filter((task) =>
    task.status === "completed" || task.status === "failed" || task.status === "stopped",
  ).map((task) => [task.id, task.status]));
  if (!confirmed.size) return incoming;
  return incoming.map((task) => {
    const status = confirmed.get(task.id);
    return status && (task.status === "running" || task.status === "paused") ? { ...task, status } : task;
  });
}

/** ACK/accepted is not terminal evidence. Validate the transport boundary
 * against the task the caller requested, including unexpected older servers. */
export function readNativeTaskStopResult(data: unknown, taskId: string): NativeTaskStopResult | null {
  if (!data || typeof data !== "object") return null;
  const result = data as Record<string, unknown>;
  if (result.taskId !== taskId ||
    (result.status !== "completed" && result.status !== "failed" && result.status !== "stopped")) return null;
  return { taskId, status: result.status };
}

/** The stop response carries real native terminal evidence, so it also heals
 * a missing tasks event after a Web disconnect. Preserve every newer terminal
 * and all unrelated rows; this does not settle the overall run or its queue. */
export function applyConfirmedNativeTaskStop<T extends BySessionSlice>(
  set: SetFn<T>, key: string, runId: string, result: NativeTaskStopResult,
): void {
  set((state) => {
    const session = state.bySession[key];
    if (!session || session.nativeTaskRunId !== runId || !session.nativeTasks) return {};
    const index = session.nativeTasks.findIndex((task) => task.id === result.taskId &&
      (task.status === "running" || task.status === "paused"));
    if (index < 0) return {};
    const nativeTasks = session.nativeTasks.map((task, i) => i === index ? { ...task, status: result.status } : task);
    setNativeBackgroundActive(runId, session.nativeActivity === "requires_action" ||
      nativeTasks.some((task) => task.status === "running" && !task.ambient));
    return { bySession: { ...state.bySession, [key]: { ...session, nativeTasks } } } as Partial<T>;
  });
}

/** Replace the previous catalog at a run boundary; never carry running tasks
 * into a newer run or infer a terminal status from the parent's reply. */
export function beginNativeRun(session: SessionState, runId: string): Partial<SessionState> {
  if (session.nativeTaskRunId === runId) return {};
  return {
    nativeTaskRunId: runId,
    // The stop flag drops late events of `nativeTaskRunId` (the stopped run).
    // A run adopted without sendPrompt (leader child, remote client) is a new
    // run: its events must not be dropped on the strength of the old stop.
    interrupted: false,
    nativeTasks: undefined,
    nativeTaskSeq: undefined,
    nativeActivity: null,
    // Per-run live-CLI state never carries over: the launch settings, the
    // follow-up guard and a Stop's park belong to the process that is gone.
    liveLaunch: undefined,
    followUpAt: null,
    queueParked: false,
    interruptRequestedAt: null,
    lastInterruptAt: null,
    retiredNativeRunIds: session.nativeTaskRunId
      ? [...(session.retiredNativeRunIds ?? []), session.nativeTaskRunId].slice(-32)
      : session.retiredNativeRunIds,
  };
}

const statuses = new Set(["running", "paused", "completed", "failed", "stopped", "unknown"]);

/** A finite authoritative snapshot. Invalid entries are omitted, duplicate
 * IDs resolve to the last entry, and unfamiliar states stay visibly unknown. */
export function readNativeTasks(data: unknown): NativeTask[] | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as { tasks?: unknown }).tasks)) return null;
  const tasks = new Map<string, NativeTask>();
  for (const value of (data as { tasks: unknown[] }).tasks) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    tasks.set(row.id, {
      id: row.id,
      kind: typeof row.kind === "string" ? row.kind : "unknown",
      description: typeof row.description === "string" ? row.description : row.id,
      status: typeof row.status === "string" && statuses.has(row.status)
        ? row.status as NativeTask["status"] : "unknown",
      ...(typeof row.toolUseId === "string" ? { toolUseId: row.toolUseId } : {}),
      ...(typeof row.summary === "string" ? { summary: row.summary } : {}),
      ...(typeof row.progress === "string" ? { progress: row.progress } : {}),
      ...(typeof row.background === "boolean" ? { background: row.background } : {}),
      ...(typeof row.ambient === "boolean" ? { ambient: row.ambient } : {}),
    });
  }
  return [...tasks.values()];
}
