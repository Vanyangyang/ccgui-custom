/**
 * Upstream HTTP errors arrive as `400: {"message":"...","type":"..."}`.
 * Split the status code and the human-readable message so the banner can
 * show readable text instead of raw JSON. Returns null for anything that
 * does not match that shape; callers then render the original string.
 */
export interface UpstreamError {
  status: string;
  text: string;
}

export function parseUpstreamError(message: string): UpstreamError | null {
  const match = /^(\d{3})[:：]\s*(\{[\s\S]*\})$/.exec(message.trim());
  if (!match) return null;
  try {
    const body: unknown = JSON.parse(match[2]);
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const nested = record.error as Record<string, unknown> | null | undefined;
    const text =
      typeof record.message === "string"
        ? record.message
        : nested && typeof nested.message === "string"
          ? nested.message
          : null;
    return text ? { status: match[1], text } : null;
  } catch {
    return null;
  }
}
