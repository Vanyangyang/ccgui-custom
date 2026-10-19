import { ipc } from "@/lib/ipc";
import { readStoredJson, readStoredBool, writeStored } from "@/lib/storage";
import vscodeIcon from "@/assets/app-icons/vscode.png?url";
import cursorIcon from "@/assets/app-icons/cursor.png?url";
import ideaIcon from "@/assets/app-icons/idea.png?url";
import finderIcon from "@/assets/app-icons/finder.png?url";

/**
 * Curated "open with" targets for the header. Migrated from the legacy app's
 * preset catalog, trimmed to the four targets that made the cut: VS Code,
 * Cursor, IntelliJ IDEA and the OS file manager.
 */
export type OpenAppTarget = {
  id: string;
  label: string;
  kind: "app" | "finder";
  /** macOS `open -a` name; other platforms resolve a matching CLI binary. */
  appName: string | null;
};

export const OPEN_APP_TARGETS: readonly OpenAppTarget[] = [
  { id: "vscode", label: "VS Code", kind: "app", appName: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", kind: "app", appName: "Cursor" },
  { id: "finder", label: "Finder", kind: "finder", appName: null },
  { id: "idea", label: "IntelliJ IDEA", kind: "app", appName: "IntelliJ IDEA" },
];

export const DEFAULT_OPEN_APP_ID = "vscode";

export const OPEN_APP_ICONS: Record<string, string> = {
  vscode: vscodeIcon,
  cursor: cursorIcon,
  idea: ideaIcon,
  finder: finderIcon,
};

/**
 * Which path a target receives: the file manager always gets the workspace
 * folder; editors (and custom programs) prefer the file currently open in
 * the files panel.
 */
export function resolveOpenAppPath(
  target: Pick<OpenAppTarget, "kind"> | CustomApp,
  options: { workspacePath: string; activeFilePath?: string | null },
): string {
  if ("kind" in target && target.kind === "finder") return options.workspacePath;
  return options.activeFilePath?.trim() || options.workspacePath;
}

export async function openPathInTarget(path: string, target: OpenAppTarget): Promise<void> {
  if (target.kind === "finder") {
    await ipc.revealInFileManager(path);
    return;
  }
  if (!target.appName) return;
  await ipc.openWorkspaceIn(path, { appName: target.appName });
}

/** Launch a custom program entry at `path` with the workspace path appended. */
export async function openCustomProgram(path: string, app: CustomApp): Promise<void> {
  await ipc.openCustomProgram(app.path, path);
}

// ---------- user-added custom programs (header menu "添加程序") ----------

export type CustomApp = {
  id: string;
  /** Display name in the menu (user-provided; falls back to the file name). */
  label: string;
  /** Absolute path of the executable (or macOS .app bundle). */
  path: string;
  /**
   * OS-extracted icon as a PNG data URL. `undefined` = not extracted yet,
   * `null` = extraction ran and found nothing (so we don't retry).
   */
  icon?: string | null;
};

export const CUSTOM_APPS_KEY = "ccgui-next.openWorkspaceCustomApps";

export function readCustomApps(): CustomApp[] {
  return (
    readStoredJson<CustomApp[]>(CUSTOM_APPS_KEY, (stored) =>
      Array.isArray(stored)
        ? stored.flatMap((entry): CustomApp[] => {
            if (
              typeof entry !== "object" ||
              entry === null ||
              typeof (entry as CustomApp).id !== "string" ||
              typeof (entry as CustomApp).label !== "string" ||
              typeof (entry as CustomApp).path !== "string"
            ) {
              return [];
            }
            const raw = entry as CustomApp;
            const icon =
              typeof raw.icon === "string" ? raw.icon : raw.icon === null ? null : undefined;
            return [{ id: raw.id, label: raw.label, path: raw.path, icon }];
          })
        : null,
    ) ?? []
  );
}

export function writeCustomApps(apps: CustomApp[]): void {
  writeStored(CUSTOM_APPS_KEY, JSON.stringify(apps));
}

/** Extract the icon for an app that has not been probed yet (failures → null). */
export async function extractCustomAppIcon(app: CustomApp): Promise<string | null> {
  if (app.icon !== undefined) return app.icon;
  return ipc.getProgramIcon(app.path).catch(() => null);
}

// ---------- header pinning / selection persistence (localStorage) ----------

const PINNED_IDS_KEY = "ccgui-next.headerPinnedActions";
const SELECTED_APP_KEY = "ccgui-next.openWorkspaceApp";

/** One-time migration marker: pin lists stored before the launch script became pinnable. */
export const LAUNCH_SCRIPT_PIN_MIGRATION_KEY =
  "ccgui-next.headerPinnedActions.launchScriptPin";

/** "terminal" is a pinnable extra action, not an open target. */
export const TERMINAL_ACTION_ID = "terminal";
/** The launch-script cluster is a pinnable extra action, not an open target. */
export const LAUNCH_SCRIPT_ACTION_ID = "launchScript";

export const DEFAULT_PINNED_IDS: readonly string[] = [
  DEFAULT_OPEN_APP_ID,
  TERMINAL_ACTION_ID,
  LAUNCH_SCRIPT_ACTION_ID,
];

// useSyncExternalStore snapshot: cache by raw value so repeated reads return
// a stable reference until a write (or external clear) changes the key.
let pinnedSnapshot: { raw: string | null; ids: string[] } | null = null;
const pinnedListeners = new Set<() => void>();

export function readPinnedIds(): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PINNED_IDS_KEY);
  } catch {
    raw = null;
  }
  if (pinnedSnapshot && pinnedSnapshot.raw === raw) return pinnedSnapshot.ids;
  let ids: string[];
  if (raw === null) {
    // First ever read: persist the defaults and mark the migration done, so a
    // later unpin of the launch script is not mistaken for a legacy list.
    ids = [...DEFAULT_PINNED_IDS];
    writeStored(PINNED_IDS_KEY, JSON.stringify(ids));
    writeStored(LAUNCH_SCRIPT_PIN_MIGRATION_KEY, 1);
    raw = JSON.stringify(ids);
  } else {
    ids =
      readStoredJson<string[]>(PINNED_IDS_KEY, (stored) =>
        Array.isArray(stored)
          ? stored.filter((id): id is string => typeof id === "string")
          : null,
      ) ?? [...DEFAULT_PINNED_IDS];
    // Lists stored before the launch script became pinnable predate its id;
    // keep the previously always-visible button pinned for them exactly once,
    // so an explicit unpin afterwards sticks.
    if (
      !ids.includes(LAUNCH_SCRIPT_ACTION_ID) &&
      !readStoredBool(LAUNCH_SCRIPT_PIN_MIGRATION_KEY, false)
    ) {
      ids = [...ids, LAUNCH_SCRIPT_ACTION_ID];
      writeStored(PINNED_IDS_KEY, JSON.stringify(ids));
      writeStored(LAUNCH_SCRIPT_PIN_MIGRATION_KEY, 1);
      raw = JSON.stringify(ids);
    }
  }
  pinnedSnapshot = { raw, ids };
  return ids;
}

/** Notifies subscribers (the launch-script cluster) after a pin change. */
export function subscribePinnedIds(listener: () => void): () => void {
  pinnedListeners.add(listener);
  return () => {
    pinnedListeners.delete(listener);
  };
}

export function writePinnedIds(ids: string[]): void {
  writeStored(PINNED_IDS_KEY, JSON.stringify(ids));
  pinnedListeners.forEach((listener) => listener());
}

export function readSelectedOpenAppId(): string {
  const stored = localStorage.getItem(SELECTED_APP_KEY);
  return stored && OPEN_APP_TARGETS.some((target) => target.id === stored)
    ? stored
    : DEFAULT_OPEN_APP_ID;
}

export function writeSelectedOpenAppId(id: string): void {
  writeStored(SELECTED_APP_KEY, id);
}
