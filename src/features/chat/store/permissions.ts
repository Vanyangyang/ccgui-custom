import type { EngineInfo } from "@/lib/ipc";
import type { ComposerPermission } from "@/components/application/ai-chat/permission-menu";
import { PERMISSION_PREF_KEY } from "./persistence";

const PERMISSION_MODES: readonly ComposerPermission[] = [
  "auto",
  "manual",
  "plan",
  "bypass",
];

/** Persisted composer permission, validated against the known modes. */
export function readPermissionPref(): ComposerPermission {
  const raw = localStorage.getItem(PERMISSION_PREF_KEY);
  return PERMISSION_MODES.includes(raw as ComposerPermission)
    ? (raw as ComposerPermission)
    : "auto";
}

/** The mode actually sent for an engine: the user's pick when the engine
 * honors it, else the engine's first supported mode (same fallback the
 * Rust side applies). */
export function effectivePermission(
  engines: EngineInfo[],
  engine: string,
  selected: ComposerPermission,
): ComposerPermission {
  const supported = engines.find((e) => e.id === engine)?.permissions;
  if (!supported || supported.length === 0) return selected;
  return supported.includes(selected)
    ? selected
    : (supported[0] as ComposerPermission);
}
