import { useFilesStore } from "@/features/files/store";
import { useGitStore } from "@/features/git/store";
import { usePluginHubStore } from "@/features/plugins/hub/store";
import { usePluginTabsStore } from "@/features/plugins/runtime/center-tabs";
import { usePluginsStore } from "@/features/plugins/manager/usePlugins";
import { getPluginStatesSnapshot } from "@/features/plugins/runtime/loader";
import { useReleaseNotesTabStore } from "@/features/update/notes-tab";
import { captureLayoutPanelRuntime, layoutPanelCheckpointBlockers, restoreLayoutPanelRuntime } from "@/features/chat/use-layout-panels";
import { cloneCheckpointValue, registerRuntimeCheckpointParticipant } from "./runtime-checkpoint";

type FilesState = ReturnType<typeof useFilesStore.getState>;
const FILE_KEYS = ["root", "children", "loadingDirs", "dirErrors", "expanded", "repositories", "fileColors",
  "selectedPath", "selectedIsDir", "openFiles", "fileStates", "activeFilePath", "dirtyPaths", "clipboard", "searchRoot", "refreshing"] as const satisfies readonly (keyof FilesState)[];
type FileSnapshot = Pick<FilesState, (typeof FILE_KEYS)[number]>;
interface AppCheckpoint {
  version: 1;
  hash: string;
  files: FileSnapshot;
  panel: ReturnType<typeof captureLayoutPanelRuntime>;
  diffView: ReturnType<typeof useGitStore.getState>["diffView"];
  pluginHub: Pick<ReturnType<typeof usePluginHubStore.getState>, "open" | "active" | "view">;
  releaseNotes: Pick<ReturnType<typeof useReleaseNotesTabStore.getState>, "open" | "active" | "unreadVersion">;
}

/** Browser tabs, split panes, widths, collapse flags and ordinary preferences
 * already persist. This participant carries the remaining host navigation/file
 * view state; it does not claim ownership of arbitrary plugin component state.
 * Native admission separately checks PTYs, plugin agents, missions and Leader. */
export function appRuntimeCheckpointBlockers(): string[] {
  const state = useFilesStore.getState();
  const reasons = layoutPanelCheckpointBlockers();
  const unsafeDialog = [...document.querySelectorAll('dialog[open], [role="dialog"]')].some((dialog) =>
    // The update settings pane contains only already-staged update controls.
    // Nested dialogs are checked independently and do not inherit this opt-in.
    !(dialog.matches("dialog[open]") && dialog.querySelector('[data-runtime-update-safe="true"]')));
  if (unsafeDialog) reasons.push("open-dialog");
  if (usePluginsStore.getState().installing) reasons.push("plugin-install-in-progress");
  if (getPluginStatesSnapshot().some((plugin) => plugin.state === "loading")) reasons.push("plugin-loading");
  if (Object.keys(state.dirtyPaths).length) reasons.push("unsaved-editor-drafts");
  if (state.refreshing || Object.keys(state.loadingDirs).length || Object.values(state.fileStates).some((file) => file.loading)) reasons.push("file-read-in-progress");
  // Open instances can contain arbitrary unsaved plugin forms; merely having
  // an enabled/loaded plugin is not a blocker.
  if (usePluginTabsStore.getState().tabs.length || window.location.hash.startsWith("#/p/") || captureLayoutPanelRuntime().panelTab.startsWith("plugin:")) reasons.push("plugin-view-without-checkpoint");
  return reasons;
}

export function captureAppRuntimeCheckpoint(): AppCheckpoint {
  const files = Object.fromEntries(FILE_KEYS.map((key) => [key, useFilesStore.getState()[key]])) as FileSnapshot;
  const hub = usePluginHubStore.getState();
  const notes = useReleaseNotesTabStore.getState();
  return cloneCheckpointValue({ version: 1, hash: window.location.hash, files, panel: captureLayoutPanelRuntime(),
    diffView: useGitStore.getState().diffView,
    pluginHub: { open: hub.open, active: hub.active, view: hub.view },
    releaseNotes: { open: notes.open, active: notes.active, unreadVersion: notes.unreadVersion },
  });
}

export function restoreAppRuntimeCheckpoint(value: unknown): void {
  const state = cloneCheckpointValue(value) as AppCheckpoint;
  if (!state || state.version !== 1 || typeof state.hash !== "string" || (state.hash && !state.hash.startsWith("#")) ||
      !state.files || !FILE_KEYS.every((key) => Object.hasOwn(state.files, key)) || !Array.isArray(state.files.openFiles) ||
      !state.pluginHub || typeof state.pluginHub.open !== "boolean" || typeof state.pluginHub.active !== "boolean" ||
      !["market", "installed"].includes(state.pluginHub.view) || !state.releaseNotes || typeof state.releaseNotes.open !== "boolean" || typeof state.releaseNotes.active !== "boolean") {
    throw new Error("Invalid app UI checkpoint");
  }
  restoreLayoutPanelRuntime(state.panel);
  useFilesStore.setState(Object.fromEntries(FILE_KEYS.map((key) => [key, state.files[key]])) as FileSnapshot);
  useGitStore.setState({ diffView: state.diffView });
  usePluginHubStore.setState({ open: state.pluginHub.open, active: state.pluginHub.active, view: state.pluginHub.view });
  useReleaseNotesTabStore.setState({ open: state.releaseNotes.open, active: state.releaseNotes.active, unreadVersion: state.releaseNotes.unreadVersion });
  const url = new URL(window.location.href); url.hash = state.hash;
  window.history.replaceState(window.history.state, "", url.href);
}

const unregister = registerRuntimeCheckpointParticipant({
  id: "app-ui", capture: captureAppRuntimeCheckpoint, restore: restoreAppRuntimeCheckpoint,
  captureReadiness: appRuntimeCheckpointBlockers,
});
if (import.meta.hot) import.meta.hot.dispose(unregister);
