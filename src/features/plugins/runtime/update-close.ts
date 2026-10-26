import { centerTabRegistry, panelTabRegistry } from "@ccgui/plugin-sdk";
import { captureLayoutPanelRuntime, registerLayoutPanelSelectionGuard, setLayoutPanelRuntime } from "@/features/chat/use-layout-panels";
import { usePluginTabsStore } from "./center-tabs";
import type { DetachedSurfaceOwner } from "../windows/owner";

interface Handler { prepare(signal: AbortSignal): Promise<void>; resume(): void }
interface Registration { pluginId: string; handler: Handler }
const handlers = new Map<string, Registration>();
interface OwnerRegistration { pluginId: string; owner: DetachedSurfaceOwner; onRestore?: () => void }
const owners = new Set<OwnerRegistration>();
interface Recovery { epoch: number; targets: OwnerRegistration[]; closing: Map<OwnerRegistration, Promise<void>>; restored: Set<OwnerRegistration> }
let recoveryEpoch = 0;
const locks = new Map<string, Registration>();
const maintenanceLocks = new Set<string>();
const failedMaintenanceResumes = new Map<string, { registration: Registration; retry(): void }>();
let registryRevision = 0;
let attempt: { registrations: Registration[]; invoked: Registration[]; cancelled: boolean; resuming: boolean; recovery: Recovery } | undefined;

function pluginId(key: string): string | undefined {
  return /^plugin:([^:]+)(?::[^:]+)*$/.exec(key)?.[1];
}
export function assertPluginViewsCanOpen(id: string): void {
  if (locks.has(id) || maintenanceLocks.has(id)) throw new Error(`Plugin views are preparing for update: ${id}`);
}
const unregisterPanelGuard = registerLayoutPanelSelectionGuard(key => { const id = pluginId(key); if (id) assertPluginViewsCanOpen(id); });
if (import.meta.hot) import.meta.hot.dispose(() => {
  try { resumePluginViewsAfterUpdate(); }
  finally { unregisterPanelGuard(); }
});

export function registerPluginUpdateCloseHandler(id: string, handler: Handler): () => void {
  if (!handler || typeof handler.prepare !== "function" || typeof handler.resume !== "function") throw new Error("Invalid update close handler");
  if (handlers.has(id)) throw new Error(`Duplicate update close handler: ${id}`);
  const registration = { pluginId: id, handler };
  handlers.set(id, registration);
  registryRevision++;
  return () => {
    if (handlers.get(id) !== registration) return;
    handlers.delete(id);
    registryRevision++;
    if (locks.get(id) === registration) locks.delete(id);
    if (failedMaintenanceResumes.get(id)?.registration === registration) {
      failedMaintenanceResumes.delete(id);
      maintenanceLocks.delete(id);
    }
  };
}

export function registerPluginDetachedOwner(id: string, owner: DetachedSurfaceOwner, onRestore?: () => void): () => void {
  const registration = { pluginId: id, owner, onRestore };
  owners.add(registration);
  registryRevision++;
  return () => { if (owners.delete(registration)) { owner.cancelRestore?.(); registryRevision++; } };
}
function beginRecovery(ids: Set<string>): Recovery {
  const targets = [...owners].filter(r => ids.has(r.pluginId));
  for (const target of targets) target.owner.cancelRestore?.();
  return { epoch: ++recoveryEpoch, targets, closing: new Map(), restored: new Set() };
}
function restoreOwners(recovery: Recovery, registration: Registration): void {
  for (const target of recovery.targets) {
    if (target.pluginId !== registration.pluginId || recovery.restored.has(target)) continue;
    recovery.restored.add(target);
    // A cancelled prepare can still be waiting for the child's flush/close guard.
    void (recovery.closing.get(target) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (recovery.epoch !== recoveryEpoch || !owners.has(target) || handlers.get(registration.pluginId) !== registration ||
          locks.has(registration.pluginId) || maintenanceLocks.has(registration.pluginId)) return;
      return target.onRestore?.();
    }).catch(error => { console.warn("[plugins] Unable to restore views after maintenance", error); });
  }
}
function activeOwners() {
  return [...owners].filter(({ owner }) => {
    const status = owner.getStatus();
    return status.phase !== "docked" && (status.phase !== "error" || !!status.windowId);
  });
}
async function waitForPreparation(work: Promise<void>, signal: AbortSignal): Promise<void> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Plugin update close aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function participants(): Set<string> | undefined {
  if (window.location.hash.startsWith("#/p/")) return;
  const ids = new Set<string>();
  for (const key of usePluginTabsStore.getState().tabs) {
    const id = pluginId(key);
    if (!id || !centerTabRegistry.get(key) || !handlers.has(id)) return;
    ids.add(id);
  }
  const panel = captureLayoutPanelRuntime().panelTab;
  if (panel.startsWith("plugin:")) {
    const id = pluginId(panel);
    if (!id || !panelTabRegistry.get(panel) || !handlers.has(id)) return;
    ids.add(id);
  }
  for (const { pluginId: id } of activeOwners()) {
    if (!handlers.has(id)) return;
    ids.add(id);
  }
  return ids;
}

export function canClosePluginViewsForUpdate(blockers: readonly { reason: string; participant?: string; pluginId?: string }[]): boolean {
  if (!blockers.length || blockers.some(b => !["plugin-view-without-checkpoint", "plugin-window-without-checkpoint", "plugin-processes"].includes(b.reason))) return false;
  const ids = participants();
  if (!ids) return false;
  for (const blocker of blockers) {
    if (blocker.reason !== "plugin-processes") continue;
    // This permits preparation only. Native admission still requires every
    // service and one-shot exec to have actually stopped before handoff.
    if (!blocker.pluginId || !handlers.has(blocker.pluginId)) return false;
    ids.add(blocker.pluginId);
  }
  if (!ids.size) return false;
  const active = activeOwners();
  return blockers.every(b => b.reason !== "plugin-window-without-checkpoint" ||
    (active.length > 0 && (!b.participant?.startsWith("plugin-window-owner:") || active.some(({ owner }) => owner.checkpointParticipant === b.participant))));
}

export async function preparePluginViewsForUpdate(signal: AbortSignal): Promise<void> {
  if (attempt || maintenanceLocks.size) throw new Error("Plugin update close already in progress");
  const ids = participants();
  if (!ids) throw new Error("Plugin views cannot close for update");
  // A closed view can still have a loaded controller receiving chat receipts.
  // Every opted-in controller must settle its background work before admission.
  for (const id of handlers.keys()) ids.add(id);
  signal.throwIfAborted();
  if (!ids.size) return;
  const revision = registryRevision;
  const current = { registrations: [...ids].map(id => handlers.get(id)!), invoked: [] as Registration[], cancelled: false, resuming: false, recovery: beginRecovery(ids) };
  attempt = current;
  for (const registration of current.registrations) locks.set(registration.pluginId, registration);
  const check = () => {
    signal.throwIfAborted();
    if (attempt !== current || current.cancelled || registryRevision !== revision || current.registrations.some(r => handlers.get(r.pluginId) !== r)) throw new Error("Plugin update close registration changed");
  };
  check();
  for (const registration of owners) {
    if (ids.has(registration.pluginId)) { await waitForPreparation(registration.owner.flushPresentation(), signal); check(); }
  }
  // The existing return protocol drains the child and honors its close guard.
  // Maintenance preserves presentation and never reopens a main-window tab.
  for (const registration of activeOwners()) {
    check();
    if (!ids.has(registration.pluginId)) throw new Error("Plugin detached owner changed");
    const closing = registration.owner.returnToMain("maintenance");
    current.recovery.closing.set(registration, closing);
    await waitForPreparation(closing, signal);
    check();
    if (!owners.has(registration)) throw new Error("Plugin detached owner unregistered");
  }
  for (const registration of current.registrations) {
    check();
    current.invoked.push(registration);
    await waitForPreparation(registration.handler.prepare(signal), signal);
    check();
  }
  // Close only after every controller persisted successfully. A late callback
  // from an aborted/unloaded generation must never close a replacement view.
  check();
  for (const key of [...usePluginTabsStore.getState().tabs]) {
    if (ids.has(pluginId(key)!)) usePluginTabsStore.getState().closeTab(key, "maintenance");
  }
  if (ids.has(pluginId(captureLayoutPanelRuntime().panelTab)!)) setLayoutPanelRuntime("files");
}

/** Settle only one controller. finish(false) resumes that exact old generation. */
export async function preparePluginForMaintenance(id: string, signal: AbortSignal): Promise<(committed: boolean) => void> {
  failedMaintenanceResumes.get(id)?.retry();
  if (attempt || maintenanceLocks.size) throw new Error("Plugin maintenance already in progress");
  if (window.location.hash.startsWith("#/p/")) throw new Error("Plugin maintenance requires the main runtime");
  signal.throwIfAborted();
  const registration = handlers.get(id);
  const targetOwners = activeOwners().filter(r => r.pluginId === id);
  // Disable/unload removes rendered contributions before the tab selection is
  // pruned. Those stale keys contain no live editor/controller to save.
  const panel = captureLayoutPanelRuntime().panelTab;
  const visible = usePluginTabsStore.getState().tabs.some(key => pluginId(key) === id && centerTabRegistry.get(key)) ||
    (pluginId(panel) === id && !!panelTabRegistry.get(panel)) || targetOwners.length > 0;
  if (visible && !registration) throw new Error(`Plugin has active views without an update close handler: ${id}`);
  const recovery = beginRecovery(new Set([id]));
  maintenanceLocks.add(id);
  let invoked = false;
  let finished = false;
  const finish = (committed: boolean) => {
    if (finished) return;
    if (!committed && invoked && registration && handlers.get(id) === registration) {
      try { registration.handler.resume(); }
      catch (error) {
        if (handlers.get(id) === registration) failedMaintenanceResumes.set(id, { registration, retry: () => finish(false) });
        else { finished = true; maintenanceLocks.delete(id); }
        throw error;
      }
    }
    finished = true;
    failedMaintenanceResumes.delete(id);
    maintenanceLocks.delete(id);
    if (!committed && registration) restoreOwners(recovery, registration);
  };
  const check = () => {
    signal.throwIfAborted();
    if (finished || handlers.get(id) !== registration || targetOwners.some(r => !owners.has(r)) ||
      activeOwners().some(r => r.pluginId === id && !targetOwners.includes(r))) throw new Error("Plugin maintenance registration changed");
  };
  try {
    for (const item of owners) if (item.pluginId === id) { check(); await waitForPreparation(item.owner.flushPresentation(), signal); check(); }
    for (const target of targetOwners) {
      check(); const closing = target.owner.returnToMain("maintenance"); recovery.closing.set(target, closing);
      await waitForPreparation(closing, signal); check();
    }
    if (registration) {
      check(); invoked = true;
      await waitForPreparation(registration.handler.prepare(signal), signal);
    }
    check();
    for (const key of [...usePluginTabsStore.getState().tabs]) if (pluginId(key) === id) usePluginTabsStore.getState().closeTab(key, "maintenance");
    if (pluginId(captureLayoutPanelRuntime().panelTab) === id) setLayoutPanelRuntime("files");
    return finish;
  } catch (error) {
    try { finish(false); }
    catch (resumeError) { throw new AggregateError([error, resumeError], `Plugin preparation failed: ${String(error)}; resume failed: ${String(resumeError)}`); }
    throw error;
  }
}

export function resumePluginViewsAfterUpdate(): void {
  const current = attempt;
  if (!current || current.resuming) return;
  current.cancelled = true;
  current.resuming = true;
  const errors: unknown[] = [];
  const failed: Registration[] = [];
  for (const registration of current.invoked) {
    if (handlers.get(registration.pluginId) !== registration) continue;
    try { registration.handler.resume(); } catch (error) {
      errors.push(error);
      if (handlers.get(registration.pluginId) === registration) failed.push(registration);
    }
  }
  for (const registration of current.registrations) {
    if (!failed.includes(registration) && locks.get(registration.pluginId) === registration) {
      locks.delete(registration.pluginId);
      restoreOwners(current.recovery, registration);
    }
  }
  current.invoked = failed;
  current.resuming = false;
  if (!failed.length) attempt = undefined;
  if (errors.length) throw new AggregateError(errors, "Unable to resume plugin views");
}
