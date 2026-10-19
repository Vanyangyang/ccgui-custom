import type { AnswerState } from "./protocol";

/** Match the exact existing host identity; never infer a session from active chat alone. */
export function answerOriginMatches(identity: string | undefined, sessionKey: string): boolean {
  if (!identity || !sessionKey || sessionKey.startsWith("new:")) return false;
  try {
    const block: unknown = JSON.parse(identity);
    if (!Array.isArray(block) || block.length !== 2 || typeof block[0] !== "string" || !Number.isSafeInteger(block[1]) || block[1] < 0) return false;
    const message: unknown = JSON.parse(block[0]);
    return Array.isArray(message) && message.length === 2 && message[0] === sessionKey && Number.isSafeInteger(message[1]) && message[1] >= 0;
  } catch { return false; }
}

export function parameterFeedback(identity: string, sourceHash: string, values: AnswerState, label: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || identity.length > 1024) return null;
  const entries = Object.entries(values);
  if (entries.length > 128 || entries.some(([key, value]) => !key || key.length > 65 || !(
    typeof value === "boolean" || (typeof value === "string" && value.length <= 256)
    || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12)
  ))) return null;
  const text = `${label}\n${JSON.stringify({ origin: identity, sourceSha256: sourceHash, parameters: values })}`;
  return text.length <= 8192 ? text : null;
}
