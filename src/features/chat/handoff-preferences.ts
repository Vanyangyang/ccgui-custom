import type { HandoffCompressionSelection } from "@/lib/ipc";

/** Handoff compression is independent of the destination chat's model. */
export const HANDOFF_PREFERENCES_KEY = "ccgui.handoff.compression:v2";
export const LEGACY_HANDOFF_PREFERENCES_KEY = "ccgui.handoff.compression:v1";
export const DEFAULT_HANDOFF_COMPRESSION_MODEL = "grok-4.7-low-fast";

export interface HandoffCompressionPreferences {
  enabled: boolean;
  model: string;
  selection: HandoffCompressionSelection;
}

export function isHandoffCompressionModel(model: string): boolean {
  return model.length > 0 && model.length <= 512 && model.trim() === model
    && !model.startsWith("-") && !/[\u0000-\u0020\u007f]/.test(model);
}

export function isHandoffCompressionSelection(value: unknown): value is HandoffCompressionSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as HandoffCompressionSelection;
  return ["claude", "codex", "pi", "cursor"].includes(selection.engine)
    && typeof selection.model === "string" && isHandoffCompressionModel(selection.model)
    && (selection.providerId === undefined || (typeof selection.providerId === "string"
      && selection.providerId.length > 0 && selection.providerId.trim() === selection.providerId
      && selection.providerId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(selection.providerId)))
    && (selection.effort === undefined || ["low", "medium", "high", "xhigh", "max", "ultra"].includes(selection.effort));
}

export function legacyHandoffSelection(model: string): HandoffCompressionSelection {
  return { engine: "cursor", model };
}

export function readHandoffCompressionPreferences(): HandoffCompressionPreferences {
  const defaults = { enabled: false, model: DEFAULT_HANDOFF_COMPRESSION_MODEL,
    selection: legacyHandoffSelection(DEFAULT_HANDOFF_COMPRESSION_MODEL) };
  try {
    // Keep the old Cursor-only slot intact: a rollback must not reinterpret a
    // Claude/Pi model as a Cursor model with compression already enabled.
    const stored: unknown = JSON.parse(localStorage.getItem(HANDOFF_PREFERENCES_KEY)
      ?? localStorage.getItem(LEGACY_HANDOFF_PREFERENCES_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return defaults;
    const value = stored as Partial<HandoffCompressionPreferences>;
    if (value.selection !== undefined) {
      if (!isHandoffCompressionSelection(value.selection)) return defaults;
      return { enabled: value.enabled === true, model: value.selection.model, selection: value.selection };
    }
    if (typeof value.model !== "string" || !isHandoffCompressionModel(value.model)) return defaults;
    return {
      enabled: value.enabled === true,
      model: value.model,
      selection: legacyHandoffSelection(value.model),
    };
  } catch {
    return defaults;
  }
}

export function saveHandoffCompressionPreferences(patch: Partial<HandoffCompressionPreferences>): boolean {
  const next = { ...readHandoffCompressionPreferences(), ...patch };
  if (patch.selection) next.model = patch.selection.model;
  else if (patch.model) next.selection = { ...next.selection, model: patch.model };
  try {
    localStorage.setItem(HANDOFF_PREFERENCES_KEY, JSON.stringify(next));
    return true;
  } catch {
    // Storage may be unavailable in a restricted WebView. The current handoff
    // still uses its explicit choice; future handoffs safely default to local.
    return false;
  }
}
