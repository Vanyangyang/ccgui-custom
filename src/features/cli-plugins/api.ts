import { invoke } from "@/lib/transport";
import type { CliPluginActionRequest, CliPluginsInventory } from "./types";

export const readCliPlugins = (engine: string, workspace: string | null) =>
  invoke<CliPluginsInventory>("cli_plugins_inventory", { engine, workspace });

// The backend must reject failed operations; there is no optimistic inventory.
export const runCliPluginAction = (request: CliPluginActionRequest) =>
  invoke<void>("cli_plugins_action", { request });
