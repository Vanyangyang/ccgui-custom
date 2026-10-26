import i18n from "i18next";

function engineErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = value as { code?: unknown; message?: unknown; outcomeUnknown?: unknown };
  return error.code === "engine_error" && typeof error.message === "string" &&
    typeof error.outcomeUnknown === "boolean" ? error.message : null;
}

/**
 * Normalize an unknown thrown value to displayable text. Tauri command
 * errors arrive as plain strings or serialized objects, so Error.message
 * alone is not enough; unstringifiable values degrade to String().
 */
export function errorText(err: unknown): string {
  let text = engineErrorMessage(err) ?? (typeof err === "string" ? err : err instanceof Error ? err.message : null);
  if (text !== null) {
    // Worker IPC serializes its engine error DTO. Unwrap only the known
    // envelope for display; delivery/retry decisions still use the raw error.
    const candidate = text.startsWith("Error: ") ? text.slice(7) : text;
    if (candidate.startsWith("{") && candidate.length <= 16 * 1024) {
      try { text = engineErrorMessage(JSON.parse(candidate)) ?? text; }
      catch { /* Preserve malformed and unknown envelopes verbatim. */ }
    }
    const prefix = "CCGUI_PROVIDER_MIGRATION_CONFLICT:";
    if (text.startsWith(prefix)) {
      try {
        const detail = JSON.parse(text.slice(prefix.length));
        if (typeof detail.path === "string" && typeof detail.backup === "string") {
          return i18n.t("settings.cliMigrationConflict", { path: detail.path, backup: detail.backup }) || text;
        }
      } catch { /* Preserve malformed/unknown backend errors verbatim. */ }
    }
    if (text === "Invalid Codex channel config.toml") {
      return i18n.t("settings.cliCodexConfigInvalid") || text;
    }
    if (text === "Cursor model is not selected in saved settings; select it in Settings → Collaboration and save before sending") {
      return i18n.t("settings.cursorModelNotSelected") || text;
    }
    return text;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
