import type { AnswerState } from "./protocol";

const snapshots = new Map<string, { source: string; values: AnswerState }>();
const MAX_SNAPSHOTS = 128;

export function cleanAnswerState(values: Record<string, unknown>, defaults: AnswerState): AnswerState {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = Object.hasOwn(values, key) ? values[key] : fallback;
    const valid = typeof value === typeof fallback && (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12) ||
      (typeof value === "string" && value.length <= 256)
    );
    return [key, valid ? value : fallback];
  })) as AnswerState;
}

/** Preserve inputs across virtual-list unmounts, scoped to the exact host message. */
export function readAnswerState(identity: string | undefined, source: string, defaults: AnswerState): AnswerState {
  const stored = identity ? snapshots.get(identity) : undefined;
  return cleanAnswerState(stored?.source === source ? stored.values : {}, defaults);
}

export function writeAnswerState(identity: string | undefined, source: string, values: Record<string, unknown>, defaults: AnswerState): void {
  if (!identity) return;
  snapshots.delete(identity);
  snapshots.set(identity, { source, values: cleanAnswerState(values, defaults) });
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
}

export function clearAnswerState(identity: string | undefined): void { if (identity) snapshots.delete(identity); }
