/** Shared CLI display order. The settings CLI 管理 rail is drag-sortable and
 *  persists its order here; the composer CLI picker reads the same list so
 *  both surfaces show engines in the user's order. Keys are settings section
 *  keys ("cli:<engineId>"); engines absent from the stored list (new engines)
 *  keep their registry order at the end. */
import { useSyncExternalStore } from "react";
import { readStoredJson, writeStored } from "./storage";

/** localStorage key for the user's CLI 管理 rail order (section keys). */
export const CLI_NAV_ORDER_KEY = "ccgui-next.settingsCliNavOrder:v1";

/** Same-tab change signal; the "storage" event only fires in other tabs. */
const CHANGE_EVENT = "ccgui:cli-nav-order";

export const readCliNavOrder = (): string[] =>
  readStoredJson(CLI_NAV_ORDER_KEY, (value) =>
    Array.isArray(value) && value.every((k) => typeof k === "string")
      ? (value as string[])
      : null,
  ) ?? [];

export function writeCliNavOrder(keys: string[]): void {
  writeStored(CLI_NAV_ORDER_KEY, JSON.stringify(keys));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Items in the user's stored order; keys absent from the stored list keep
 *  their incoming relative order at the end — Array.sort is stable. */
export const orderByStoredKeys = <T extends { key: string }>(
  items: T[],
  keys: string[],
): T[] => {
  const rank = new Map(keys.map((key, index) => [key, index]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.key) ?? keys.length) - (rank.get(b.key) ?? keys.length),
  );
};

// useSyncExternalStore requires a stable snapshot identity between changes,
// so the parsed order is cached by the raw stored string.
let cachedRaw: string | null = null;
let cachedOrder: string[] = [];
const getSnapshot = (): string[] => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CLI_NAV_ORDER_KEY);
  } catch {
    return cachedOrder;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedOrder = readCliNavOrder();
  }
  return cachedOrder;
};

/** React binding: re-reads the order on same-tab writes (drag reorder in
 *  settings) and cross-tab storage events. */
export function useCliNavOrder(): string[] {
  return useSyncExternalStore((onStoreChange) => {
    window.addEventListener(CHANGE_EVENT, onStoreChange);
    window.addEventListener("storage", onStoreChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onStoreChange);
      window.removeEventListener("storage", onStoreChange);
    };
  }, getSnapshot);
}
