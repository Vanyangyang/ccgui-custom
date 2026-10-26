import { ipc, type AppSettings } from "@/lib/ipc";
import { matchCursorBase, readCursorPins, writeCursorPins, type CursorModel } from "./cursor-models";

const MIGRATION_KEY = "ccgui.cursor.saved-model-selection:v1";
// Menus can coexist (desktop/mobile and other surfaces). Preserve write order
// and consume legacy local checkmarks only once, after native persistence.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}

export function isConcreteCursorModel(id: string): boolean {
  return !!id && !["auto", "default"].includes(id.toLowerCase());
}

function savedModels(settings: AppSettings): string[] {
  return (settings.leaderAllowedModels?.cursor ?? []).filter(isConcreteCursorModel);
}

function cacheSelection(models: string[]): void {
  // Native settings are authoritative; storage failure must not turn a
  // confirmed native save into a failure or leave the UI falsely enabled.
  try { writeCursorPins(models); } catch { /* Local sorting cache is optional. */ }
}

export function loadCursorModelSelection(catalog: readonly CursorModel[]): Promise<string[]> {
  return serial(async () => {
    let selected = savedModels(await ipc.refreshAppSettings());
    let migrated = false;
    try { migrated = localStorage.getItem(MIGRATION_KEY) === "1"; } catch { /* No legacy storage. */ }
    if (!migrated) {
      const legacy = [...new Set(readCursorPins().map(id => matchCursorBase(id, catalog)?.id ?? id))]
        .filter(isConcreteCursorModel);
      const additions = legacy.filter(id => !selected.includes(id));
      if (additions.length) selected = (await ipc.updateCursorModelSelection(additions, [])).filter(isConcreteCursorModel);
      try { localStorage.setItem(MIGRATION_KEY, "1"); } catch { /* Cache below replaces stale checkmarks. */ }
    }
    cacheSelection(selected);
    return selected;
  });
}

export function saveCursorModelSelection(id: string, enabled: boolean): Promise<string[]> {
  return serial(async () => {
    const selected = (await ipc.updateCursorModelSelection(enabled ? [id] : [], enabled ? [] : [id])).filter(isConcreteCursorModel);
    cacheSelection(selected);
    return selected;
  });
}
