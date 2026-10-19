import i18n from "@/lib/i18n";
import type { SlashCommandEntry } from "@/lib/ipc";
import { useSlashCommandStore } from "./slash-commands";

/**
 * App-level commands: bare slash inputs ccgui handles itself instead of
 * sending to the engine. The CLIs only interpret their native commands in
 * interactive TUI mode — headless/protocol launches (how ccgui runs them)
 * never see them, so the GUI provides the equivalent.
 *
 * A workspace/global catalog entry of the same name always wins: the user
 * defined that command for the CLI, and the CLI expands it — the app
 * shortcut is only the fallback when no such command exists.
 */
export type AppCommand = "new" | "compact" | "handoff" | "mcp" | "cua" | "btw" | "sidechat";

/** Bare input → catalog key. `/clear` is an alias of `/new`: in-place
 *  clearing is a TUI feature no headless/protocol launch honors, and a new
 *  session is the same net effect. `/mcp` opens the app's MCP panel instead
 *  of being sent — the CLIs only run their own `/mcp` in interactive TUI
 *  mode, which is exactly what this launch path bypasses.
 *
 *  `/ccgui-cua <task>` is the one app command that takes an argument (see
 *  ARG_COMMANDS): the line after the name is the task, and the app mounts
 *  its computer-use driver on that single send. */
const APP_COMMAND_NAMES: Record<string, AppCommand> = {
  "/new": "new",
  "/clear": "new",
  "/compact": "compact",
  "/handoff": "handoff",
  "/mcp": "mcp",
  "/ccgui-cua": "cua",
  "/btw": "btw",
  "/sidechat": "sidechat",
};

/** Commands whose trailing text is a task argument rather than part of the
 *  command name. Every other app command matches the whole input —
 *  `/compact 聚焦改动` is the CLI's own command with an argument and must
 *  keep travelling to the engine verbatim. */
const ARG_COMMANDS: ReadonlySet<AppCommand> = new Set<AppCommand>(["compact", "handoff", "cua", "btw", "sidechat"]);

const DEFAULT_COMPACT_ENGINES: ReadonlySet<string> = new Set(["claude", "codex", "pi", "omp", "agy"]);

/** Whether an engine supports manual context compaction (`/compact`). Falls back
 *  to the known protocol list when `EngineInfo.supportsCompact` is not yet populated. */
export function engineSupportsCompact(
  engines: readonly { id: string; supportsCompact?: boolean }[],
  engineId: string,
): boolean {
  const found = engines.find((e) => e.id === engineId);
  if (typeof found?.supportsCompact === "boolean") {
    return found.supportsCompact;
  }
  return DEFAULT_COMPACT_ENGINES.has(engineId);
}

/** One parsed app command: the command plus its task text (`""` for the
 *  argument-less forms). */
export interface AppCommandInput {
  command: AppCommand;
  arg: string;
}

/** Whether a user-defined catalog command of this name shadows the app
 *  command: the user defined it for the CLI, and the CLI expands it. Shared
 *  by whole-input matching and the argument form so both honor the same
 *  precedence. */
function shadowedByCatalog(
  name: string,
  workspacePath: string | null,
): boolean {
  if (!workspacePath) return false;
  const entries = useSlashCommandStore.getState().byRoot[workspacePath]?.entries;
  return Boolean(
    entries?.some(
      (entry) =>
        entry.kind === "command" &&
        entry.name.toLowerCase() === name.toLowerCase(),
    ),
  );
}

export function matchAppCommand(
  value: string,
  workspacePath: string | null,
): AppCommand | null {
  const name = value.trim();
  const command = APP_COMMAND_NAMES[name];
  if (!command) return null;
  if (shadowedByCatalog(name.slice(1), workspacePath)) return null;
  return command;
}

/** Parse one composer submission into an app command. Whole-input matching
 *  covers the argument-less commands; an ARG_COMMANDS entry additionally
 *  accepts trailing text as its task (`/ccgui-cua 打开计算器`). Returns null
 *  when the input is no app command — it then travels to the engine as
 *  typed. */
export function parseAppCommand(
  value: string,
  workspacePath: string | null,
): AppCommandInput | null {
  const exact = matchAppCommand(value, workspacePath);
  if (exact) return { command: exact, arg: "" };
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return null;
  const head = trimmed.slice(0, space);
  const command = APP_COMMAND_NAMES[head];
  if (!command || !ARG_COMMANDS.has(command)) return null;
  if (shadowedByCatalog(head.slice(1), workspacePath)) return null;
  const arg = trimmed.slice(space).trim();
  if (!arg) return null;
  return { command, arg };
}

/** The `/` picker's built-in group: one row per app-level command. Rows are
 *  frontend-injected (the backend catalog never emits kind "app"). */
export function appCommandEntries(): SlashCommandEntry[] {
  return [
    {
      name: "btw",
      description: i18n.t("sidechat.slashBtw"),
      argumentHint: i18n.t("sidechat.slashBtwArgHint"),
      source: "app",
      kind: "app",
    },
    {
      name: "sidechat",
      description: i18n.t("sidechat.slashSidechat"),
      argumentHint: i18n.t("sidechat.slashSidechatArgHint"),
      source: "app",
      kind: "app",
    },
    {
      name: "new",
      description: i18n.t("chat.slashAppNew"),
      source: "app",
      kind: "app",
    },
    {
      name: "clear",
      description: i18n.t("chat.slashAppClear"),
      source: "app",
      kind: "app",
    },
    {
      name: "compact",
      description: i18n.t("chat.slashAppCompact"),
      source: "app",
      kind: "app",
    },
    {
      name: "handoff",
      description: i18n.t("chat.slashAppHandoff"),
      argumentHint: i18n.t("chat.slashAppHandoffArgHint"),
      source: "app",
      kind: "app",
    },
    {
      name: "mcp",
      description: i18n.t("chat.slashAppMcp"),
      source: "app",
      kind: "app",
    },
    // 电脑操控入口：暂时隐藏（输入框仍可手动输入 /ccgui-cua），恢复时取消注释。
    // {
    //   name: "ccgui-cua",
    //   description: i18n.t("chat.slashAppCua"),
    //   source: "app",
    //   kind: "app",
    // },
  ];
}

/** App rows for a picker query: same contains-filter as the catalog, minus
 *  any name a user-defined catalog command claims (precedence parity with
 *  the submit interception). */
export function matchAppCommands(
  entries: SlashCommandEntry[] | undefined,
  query: string,
): SlashCommandEntry[] {
  const q = query.trim().toLowerCase();
  return appCommandEntries().filter((entry) => {
    if (
      q &&
      !entry.name.toLowerCase().includes(q) &&
      !(entry.description ?? "").toLowerCase().includes(q)
    ) {
      return false;
    }
    return !entries?.some(
      (catalog) =>
        catalog.kind === "command" && catalog.name.toLowerCase() === entry.name,
    );
  });
}
