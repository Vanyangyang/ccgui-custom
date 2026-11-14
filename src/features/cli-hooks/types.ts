export interface CliHookEntry {
  id: string;
  event: string;
  matcher: string | null;
  handlerType: string;
  label: string | null;
  source: string;
  sourcePath: string | null;
  pluginId: string | null;
  pluginScope?: string | null;
  enabled: boolean | null;
  trust: string | null;
  managed: boolean;
  toggle?: { scope: "user" | "project" | "codex"; name: string; version: string };
}

export interface CliHooksInventory {
  engine: string;
  workspace: string | null;
  coverage: "partial" | "unknown";
  warnings: string[];
  entries: CliHookEntry[];
}
