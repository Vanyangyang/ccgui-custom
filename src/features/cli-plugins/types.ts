export interface CliPluginEntry {
  id: string;
  recordKey?: string;
  name: string;
  version: string | null;
  scope: string;
  enabled: boolean | null;
  projectPath: string | null;
  mcpServers: string[];
  /** False when declarations may be incomplete or dynamically registered. */
  mcpServersKnown?: boolean;
  canToggle: boolean;
  canUninstall: boolean;
  canUpdate: boolean;
}

export interface CliPluginsInventory {
  engine: string;
  available: boolean;
  support: "managed" | "read_only" | "unsupported" | "unknown";
  message: string | null;
  entries: CliPluginEntry[];
  installScopes: string[];
}

export type CliPluginAction = "install" | "enable" | "disable" | "uninstall" | "update";

export interface CliPluginActionRequest {
  engine: string;
  workspace: string | null;
  action: CliPluginAction;
  pluginId: string;
  scope: string;
}
