import { Channel, isTauri } from "@tauri-apps/api/core";
import type { HostHandoffProgress } from "@ccgui/plugin-sdk";
import { invoke } from "./transport";

export type NativeHandoffProgress = Omit<HostHandoffProgress, "updatedAt">;
export type HandoffProgressCallback = (progress: NativeHandoffProgress) => void;
export function isHandoffTiming(value: unknown): value is NonNullable<HostHandoffProgress["timing"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = value as Record<string, number>;
  const required = ["elapsedMs", "readingMs", "segmentsMs", "mergingMs", "verifyingMs", "modelCalls", "completedModelCalls", "activeModelCalls", "modelElapsedMs"];
  const optional = ["lastModelCallMs", "longestModelCallMs"];
  if (Object.keys(t).some(key => ![...required, ...optional].includes(key)) ||
    required.some(key => !Number.isSafeInteger(t[key]) || t[key] < 0) ||
    optional.some(key => t[key] !== undefined && (!Number.isSafeInteger(t[key]) || t[key] < 0))) return false;
  return [t.modelCalls, t.completedModelCalls, t.activeModelCalls].every(n => n <= 1024) &&
    t.completedModelCalls + t.activeModelCalls === t.modelCalls &&
    (t.completedModelCalls > 0 || optional.every(key => t[key] === undefined));
}
/** Cumulative clocks/counters fence out-of-order events, including equal phase/count updates. */
export function handoffTimingAdvances(previous: HostHandoffProgress["timing"], next: HostHandoffProgress["timing"]): boolean {
  if (!previous) return true;
  if (!next) return false;
  return (["elapsedMs", "readingMs", "segmentsMs", "mergingMs", "verifyingMs", "modelCalls", "completedModelCalls", "modelElapsedMs"] as const)
    .every(key => next[key] >= previous[key]) &&
    (previous.longestModelCallMs === undefined || next.longestModelCallMs !== undefined && next.longestModelCallMs >= previous.longestModelCallMs);
}
const PHASE_ORDER: Record<NativeHandoffProgress["phase"], number> = {
  reading: 0,
  segments: 1,
  merging: 2,
  verifying: 3,
};

export function nativeHandoffProgressAdvances(
  previous: NativeHandoffProgress | undefined,
  next: NativeHandoffProgress,
): boolean {
  if (!handoffTimingAdvances(previous?.timing, next.timing)) return false;
  if (!previous || PHASE_ORDER[next.phase] > PHASE_ORDER[previous.phase]) return true;
  if (PHASE_ORDER[next.phase] < PHASE_ORDER[previous.phase]) return false;
  if (next.phase === "merging" && next.round !== previous.round) return (next.round ?? 0) > (previous.round ?? 0);
  return next.total === previous.total && (next.completed ?? 0) >= (previous.completed ?? 0);
}

export function isNativeHandoffProgress(value: unknown): value is NativeHandoffProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as NativeHandoffProgress;
  if (Object.keys(p).some(key => !["phase", "completed", "total", "round", "timing"].includes(key)) ||
    !["reading", "segments", "merging", "verifying"].includes(p.phase)) return false;
  if ([p.completed, p.total, p.round].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return false;
  if (p.timing !== undefined && !isHandoffTiming(p.timing)) return false;
  if (p.phase === "reading" || p.phase === "verifying") return p.completed === undefined && p.total === undefined && p.round === undefined;
  return p.total !== undefined && p.total > 0 && p.completed !== undefined && p.completed <= p.total &&
    (p.phase === "merging" ? p.round !== undefined && p.round > 0 : p.round === undefined);
}
let supported: Promise<boolean> | undefined;
/** One scoped channel per native call; never allocate callbacks on an older host. */
export async function withHandoffProgress<T>(run: (progress?: Channel<NativeHandoffProgress>) => Promise<T>, onProgress?: HandoffProgressCallback): Promise<T> {
  if (!onProgress || !isTauri()) return run();
  if (!await (supported ??= invoke<boolean>("handoff_progress_supported").then(value => value === true, () => false))) return run();
  const channel = new Channel<NativeHandoffProgress>(value => {
    if (isNativeHandoffProgress(value)) { try { onProgress(structuredClone(value)); } catch { /* Progress must never fail inference. */ } }
  });
  try { return await run(channel); }
  finally { channel.onmessage = () => {}; }
}
