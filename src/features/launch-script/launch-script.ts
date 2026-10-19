import { newId } from "@/lib/id";
import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * Per-workspace startup scripts ("启动脚本"). The legacy app stored these in
 * backend workspace settings; this rewrite has no per-workspace backend
 * settings, so persistence follows the localStorage `ccgui-next.*`
 * convention used by the open-app header cluster.
 */

export interface LaunchScriptEntry {
  id: string;
  /** Optional display label for extra entries; "" renders the script text. */
  label: string;
  script: string;
}

const keyFor = (workspacePath: string) => `ccgui-next.launchScripts.${workspacePath}`;

function normalize(value: unknown): LaunchScriptEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LaunchScriptEntry>;
  if (typeof candidate.id !== "string" || typeof candidate.script !== "string") return null;
  if (candidate.script.trim().length === 0) return null;
  return {
    id: candidate.id,
    label: typeof candidate.label === "string" ? candidate.label : "",
    script: candidate.script,
  };
}

export function readLaunchScripts(workspacePath: string): LaunchScriptEntry[] {
  return (
    readStoredJson(keyFor(workspacePath), (value) =>
      Array.isArray(value)
        ? value.map(normalize).filter((entry): entry is LaunchScriptEntry => entry !== null)
        : null,
    ) ?? []
  );
}

export function writeLaunchScripts(workspacePath: string, entries: LaunchScriptEntry[]): void {
  writeStored(keyFor(workspacePath), JSON.stringify(entries));
}

export function createLaunchScriptEntry(label: string, script: string): LaunchScriptEntry {
  return { id: newId(), label: label.trim(), script: script.trim() };
}

// ---------- cross-cluster editor requests (更多 menu row → header cluster) ----------

const editorRequestListeners = new Set<() => void>();

/** Ask the mounted LaunchScriptActions cluster to open its editor dialog. */
export function requestLaunchScriptEditor(): void {
  editorRequestListeners.forEach((listener) => listener());
}

export function onLaunchScriptEditorRequest(listener: () => void): () => void {
  editorRequestListeners.add(listener);
  return () => {
    editorRequestListeners.delete(listener);
  };
}
