import { ipc, type PluginInfo } from "@/lib/ipc";
import { invoke } from "@/lib/transport";
import { beginRuntimeOperation } from "@/lib/runtime-checkpoint";
import { refreshPluginsAfterMaintenance } from "../manager/usePlugins";
import { getLoadedPluginVersion, getPluginStatesSnapshot, unloadPlugin } from "./loader";
import { preparePluginForMaintenance } from "./update-close";

interface Request { requestId: string; method: string; arguments?: Record<string, unknown> }
interface Candidate { id: string; name: string; version: string; tier: string; permissions: string[]; sdkVersion?: string; minAppVersion?: string }
const methods = new Set(["list_plugins", "get_plugin_status", "install_plugin", "reload_plugin"]);
export function isPluginManagementMethod(method: string): boolean { return methods.has(method); }
let busy = false;
function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}`);
  return value;
}
function runtime(id: string) {
  const entry = getPluginStatesSnapshot().find(p => p.id === id);
  return { state: entry?.state ?? "not-loaded", loadedVersion: getLoadedPluginVersion(id) ?? null, error: entry?.error ?? null };
}
export async function handlePluginManagementRequest(request: Request, isActive: () => boolean): Promise<unknown> {
  const assertActive = () => {
    if (!isActive() || window.location.hash.startsWith("#/p/")) throw new Error("Plugin management main runtime is unavailable");
  };
  assertActive();
  const args = request.arguments ?? {};
  if (request.method === "list_plugins") {
    const installed = await ipc.pluginList(); assertActive();
    return { plugins: installed.map(info => ({ installed: info, runtime: runtime(info.id) })) };
  }
  if (request.method === "get_plugin_status") {
    const id = required(args, "id");
    const installed = (await ipc.pluginList()).find(info => info.id === id) ?? null;
    const candidate = args.sourcePath === undefined ? null : await invoke<Candidate>("plugin_inspect_path", { path: required(args, "sourcePath") });
    assertActive();
    if (candidate && candidate.id !== id) throw new Error("Candidate plugin id mismatch");
    return { installed, runtime: runtime(id), candidate, newPermissions: candidate?.permissions.filter(p => !installed?.permissions.includes(p)) ?? [] };
  }
  if (request.method !== "install_plugin" && request.method !== "reload_plugin") throw new Error("Unknown plugin management method");
  if (busy) throw new Error("Plugin management is busy");
  const id = required(args, request.method === "install_plugin" ? "expectedId" : "id");
  const expectedVersion = required(args, "expectedVersion");
  const path = request.method === "install_plugin" ? required(args, "path") : undefined;
  const done = beginRuntimeOperation(`plugin-maintenance:${id}`);
  busy = true;
  let finish: ((committed: boolean) => void) | undefined;
  let committed = false;
  let operationError: string | null = null;
  try {
    if (!await invoke<boolean>("host_chat_request_active", { requestId: request.requestId })) throw new Error("Plugin management request expired");
    assertActive();
    if (path) {
      const candidate = await invoke<Candidate>("plugin_inspect_path", { path });
      if (candidate.id !== id || candidate.version !== expectedVersion) throw new Error("Candidate plugin id or version mismatch");
    } else {
      const installed = (await ipc.pluginList()).find(info => info.id === id);
      if (!installed || installed.version !== expectedVersion) throw new Error("Installed plugin version mismatch");
    }
    assertActive();
    // Preparation alone is time bounded. Never replay an in-flight native write.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Plugin maintenance preparation timed out")), 20_000);
    try { finish = await preparePluginForMaintenance(id, controller.signal); }
    finally { clearTimeout(timer); }
    await refreshPluginsAfterMaintenance(id, request.requestId, async () => {
      assertActive();
      if (!await invoke<boolean>("host_chat_request_active", { requestId: request.requestId })) throw new Error("Plugin management request expired");
      assertActive();
      await invoke<PluginInfo>(path ? "plugin_install_from_path" : "plugin_reload", path
        ? { path, requestId: request.requestId, hostRequestId: request.requestId, expectedId: id, expectedVersion }
        : { id, requestId: request.requestId, hostRequestId: request.requestId, expectedVersion, preserveEnabled: true });
      committed = true;
      // Tear down the saved generation under its lock, then permit activation
      // to open replacement views. No async gap exposes the old controller.
      unloadPlugin(id);
      finish?.(true);
      finish = undefined;
    });
  } catch (error) { operationError = String(error); }
  finally {
    // Resume only an old controller that survived; replacement identity is
    // checked by the maintenance cleanup and must never receive old resume.
    try { finish?.(false); }
    catch (error) { operationError = [operationError, `Plugin resume failed: ${String(error)}`].filter(Boolean).join("; "); }
    finally { busy = false; done(); }
  }
  assertActive();
  const installed = (await ipc.pluginList()).find(info => info.id === id) ?? null;
  const currentRuntime = runtime(id);
  const activation = !committed ? "not-committed" : installed?.enabled === false ? "disabled"
    : currentRuntime.state === "active" && currentRuntime.loadedVersion === expectedVersion ? "active" : "failed";
  return { committed, installed, runtime: currentRuntime, activation,
    error: operationError ?? (activation === "failed" ? currentRuntime.error ?? "Expected plugin version is not active" : null) };
}
