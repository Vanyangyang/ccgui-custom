const MAX_ERROR_JSON_LENGTH = 16 * 1024;

function explicitUnknown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const error = value as { outcomeUnknown?: unknown; code?: unknown };
  return error.outcomeUnknown === true || error.code === "request-uncertain";
}

/** Only explicit transport/native uncertainty changes retry semantics. Native
 * IPC may serialize its error DTO, while WebBridge uses a typed Error object. */
export function isDeliveryOutcomeUnknown(error: unknown): boolean {
  try {
    if (explicitUnknown(error)) return true;
    const serialized = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
    if (!serialized || serialized.length > MAX_ERROR_JSON_LENGTH) return false;
    return explicitUnknown(JSON.parse(serialized));
  } catch {
    return false;
  }
}
