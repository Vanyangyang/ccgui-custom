import { invoke } from "@/lib/transport";
import type { CliHooksInventory } from "./types";

export const readCliHooks = (engine: string, workspace: string | null) =>
  invoke<CliHooksInventory>("cli_hooks_inventory", { engine, workspace });

export const setCliHookEnabled = (request: { engine: string; workspace: string | null; scope: string; name: string; version: string; enabled: boolean }) =>
  invoke<void>("cli_hooks_set_enabled", { request });
