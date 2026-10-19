import type { Message } from "@/lib/ipc";
import { parseUsage } from "./usage";

/** What one finished reply cost, in the numbers the engine actually reported.
 *  Nothing here is estimated: a field the engine did not report stays absent
 *  rather than reading as zero. */
export interface TurnSummary {
  /** Wall clock from send to completion; includes tool execution and waits. */
  durationMs: number | null;
  /** Whole prompt side: fresh input plus cache reads and writes. */
  input: number;
  output: number;
  /** False when native history explicitly says the counters are incomplete. */
  usageComplete: boolean;
  /** Share of the prompt side served from cache, 0-100, when any cache was read. */
  cacheHitPercent: number | null;
  /** Reasoning/thinking tokens when the engine reports them on their own. */
  reasoning: number | null;
  /** Tool calls the turn made. */
  tools: number;
  /** Output tokens ÷ the whole turn's duration (waits and tools included), so
   *  it is an average over the turn, not the model's generation speed. */
  outputTps: number | null;
}

/** Below this the quotient is dominated by timer noise. */
const MIN_SPEED_WINDOW_MS = 1_000;

export function buildTurnSummary(
  message: Pick<Message, "usage" | "durationMs">,
  tools = 0,
): TurnSummary | null {
  // Context-only snapshots (including AGY history metadata) describe occupancy,
  // not the tokens spent answering this turn.
  const raw = message.usage && typeof message.usage === "object"
    ? message.usage as Record<string, unknown>
    : null;
  const hasTurnUsage = raw?.usage_scope === "turn" || raw?.usage_scope === "unknown";
  const parsed = !hasTurnUsage && raw?.context_usage_kind && raw.context_usage_kind !== "billing"
    ? null
    : parseUsage(message.usage);
  const valid = (value: number) => Number.isFinite(value) && value >= 0;
  const usage = parsed && [parsed.input, parsed.output, parsed.cacheRead, parsed.cacheWrite].every(valid)
    ? parsed
    : null;
  const durationMs =
    message.durationMs != null && Number.isFinite(message.durationMs) && message.durationMs > 0
      ? message.durationMs
      : null;
  const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
  const output = usage?.output ?? 0;
  const usageComplete = raw?.usage_scope !== "unknown";
  const toolCount = Number.isFinite(tools) && tools > 0 ? Math.floor(tools) : 0;
  if (durationMs == null && !input && !output && !toolCount) return null;
  return {
    durationMs,
    input,
    output,
    usageComplete,
    cacheHitPercent: usageComplete && usage && usage.cacheRead > 0 && input > 0
      ? Math.min(100, Math.round((usage.cacheRead / input) * 100))
      : null,
    reasoning: usage?.reasoning != null && valid(usage.reasoning) ? usage.reasoning : null,
    tools: toolCount,
    outputTps: usageComplete && durationMs != null && durationMs >= MIN_SPEED_WINDOW_MS && output > 0
      ? output / (durationMs / 1000)
      : null,
  };
}
