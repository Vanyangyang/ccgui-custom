import { invoke, listen } from "@/lib/transport";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface DetachedSnapshot { revision: number; state: JsonValue }
export interface DetachedAction { name: string; args: JsonValue[] }
export interface DetachedLabels { returnToMain: string; ownerUnavailable: string; actionFailed: string; loading: string }
export interface WindowIdentity { windowId: string; registrationId: string }
export interface OwnerIdentity extends WindowIdentity { ownerToken: string }
export interface DetachedInit extends WindowIdentity {
  label: string; pluginId: string; tabId: string; title: string; rendererExport: string;
  code: string; css: string; snapshot: DetachedSnapshot; dark: boolean; labels: DetachedLabels;
  nextSequence: number;
  unresolvedSequences: number[];
}
export interface SnapshotEvent extends WindowIdentity { snapshot: DetachedSnapshot; dark: boolean }
export interface ActionEvent extends OwnerIdentity { sequence: number; action: DetachedAction }
export interface ActionReceipt { sequence: number; ok: boolean; value?: JsonValue; error?: string; unknown?: boolean; snapshot: DetachedSnapshot }
export interface ActionInspection extends WindowIdentity { sequence: number; state: "pending" | "unknown" | "resolved" | "missing" | "expired"; receipt?: ActionReceipt }
export interface ReturnedEvent extends OwnerIdentity { tabId: string; reason: "return" | "closed" | "maintenance" }
export interface ReturnBlockedEvent extends OwnerIdentity { tabId: string }
export interface CloseRequestedEvent extends WindowIdentity { reason?: "return" | "closed" | "maintenance" }
export interface DetachedTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void>;
}
export const defaultDetachedTransport: DetachedTransport = { invoke, listen };
export type DetachedPhase = "docked" | "opening" | "detached" | "returning" | "recovering" | "unavailable" | "error";
export interface DetachedStatus {
  phase: DetachedPhase;
  error?: string;
  windowId?: string;
  returnBlocked?: boolean;
  blockedReason?: "return" | "closed";
}
export const EVENTS = {
  action: "plugin-window://action", snapshot: "plugin-window://snapshot",
  returned: "plugin-window://returned", closeRequested: "plugin-window://close-requested",
  returnBlocked: "plugin-window://return-blocked",
} as const;
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_ACTION_BYTES = 64 * 1024;

/** Reject lossy JSON conversions (undefined, dates, cycles, NaN), then detach references. */
export function copyJson(value: unknown, maxBytes = MAX_JSON_BYTES): JsonValue {
  const ancestors = new Set<object>();
  function check(item: unknown, depth: number): void {
    if (depth > 64) throw new Error("Detached payload exceeds nesting limit");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || !item) throw new Error("Detached payload must be JSON");
    if (ancestors.has(item)) throw new Error("Detached payload must not contain cycles");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
      throw new Error("Detached payload must contain plain objects");
    if (Reflect.ownKeys(item).some(key => typeof key === "symbol")) throw new Error("Detached payload must be JSON");
    ancestors.add(item);
    for (const entry of Array.isArray(item) ? item : Object.values(item)) check(entry, depth + 1);
    ancestors.delete(item);
  }
  check(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("Detached payload exceeds size limit");
  return JSON.parse(text) as JsonValue;
}
export function copyAction(action: DetachedAction): DetachedAction {
  if (!action || typeof action.name !== "string" || !action.name || action.name.length > 80 || !Array.isArray(action.args))
    throw new Error("Invalid detached action");
  return copyJson(action, MAX_ACTION_BYTES) as unknown as DetachedAction;
}
export function copySnapshot(snapshot: DetachedSnapshot): DetachedSnapshot {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("Invalid snapshot revision");
  return { revision: snapshot.revision, state: copyJson(snapshot.state) };
}
export function sameWindow(a: WindowIdentity | undefined, b: WindowIdentity): boolean {
  return !!a && a.windowId === b.windowId && a.registrationId === b.registrationId;
}
export function jsonKey(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jsonKey(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function mergeSnapshot(current: DetachedSnapshot | undefined, incoming: DetachedSnapshot): DetachedSnapshot {
  const next = copySnapshot(incoming);
  if (!current || next.revision > current.revision) return next;
  if (next.revision === current.revision && jsonKey(next.state) !== jsonKey(current.state))
    throw new Error("Conflicting detached snapshot revision");
  return current;
}
