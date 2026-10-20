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
  /** False for partial turns or snapshots that do not cover a whole turn. */
  usageComplete: boolean;
  /** Share of the prompt side served from cache, 0-100, when any cache was read. */
  cacheHitPercent: number | null;
  /** Reasoning/thinking tokens when the engine reports them on their own. */
  reasoning: number | null;
  /** Tool calls the turn made. */
  tools: number;
  /** Output tokens ÷ the whole turn's duration (waits, tools and thinking included),
   *  so it is whole-turn throughput, not the model's generation speed. */
  outputTps: number | null;
}

/** Below this the quotient is dominated by timer noise. */
const MIN_SPEED_WINDOW_MS = 1_000;

interface TurnThroughputMeta {
  outputTokens: number;
  elapsedMs: number;
}

/** 【Codex回合统计】读取附加在消息 usage JSON 上的可信终态吞吐样本，不改变通用 parseUsage 对上下文占用的解释。 */
function readTurnThroughput(raw: Record<string, unknown> | null): TurnThroughputMeta | null {
  const candidate = raw?.turn_throughput;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const rec = candidate as Record<string, unknown>;
  const outputTokens = rec.output_tokens ?? rec.outputTokens;
  const elapsedMs = rec.elapsed_ms ?? rec.elapsedMs;
  if (
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof elapsedMs !== "number" ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    return null;
  }
  return { outputTokens, elapsedMs };
}

/** Single-request history and interrupted replies are not complete turn totals. */
function isIncompleteUsageScope(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  if (raw.turn_status === "partial") return true;
  if (raw.usage_scope === "unknown" || raw.usage_scope === "last_request") return true;
  if (raw.usage_scope === "turn") return false;
  const info = raw.info && typeof raw.info === "object" ? (raw.info as Record<string, unknown>) : null;
  return Boolean(
    (raw.last_token_usage && typeof raw.last_token_usage === "object") ||
      (info?.last_token_usage && typeof info.last_token_usage === "object"),
  );
}

export function buildTurnSummary(
  message: Pick<Message, "usage" | "durationMs">,
  tools = 0,
): TurnSummary | null {
  // Context-only snapshots (including AGY history metadata) describe occupancy,
  // not the tokens spent answering this turn.
  const raw = message.usage && typeof message.usage === "object"
    ? message.usage as Record<string, unknown>
    : null;
  // A partial terminal boundary overrides even previously attached paired data.
  const turnThroughput = raw?.turn_status === "partial" ? null : readTurnThroughput(raw);
  const incompleteScope = isIncompleteUsageScope(raw);
  const hasTurnUsage =
    raw?.usage_scope === "turn" ||
    incompleteScope ||
    turnThroughput !== null;
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
  // 【Codex整轮输出】有可信终态吞吐样本时展示该本轮 output，但不将 last input 伪装成整轮 input。
  const output = turnThroughput ? turnThroughput.outputTokens : (usage?.output ?? 0);
  const usageComplete = !incompleteScope;
  const toolCount = Number.isFinite(tools) && tools > 0 ? Math.floor(tools) : 0;
  if (durationMs == null && !input && !output && !toolCount) return null;
  const sampleTps =
    turnThroughput && turnThroughput.outputTokens > 0 && turnThroughput.elapsedMs >= MIN_SPEED_WINDOW_MS
      ? turnThroughput.outputTokens / (turnThroughput.elapsedMs / 1000)
      : null;
  const outputTps =
    sampleTps != null && Number.isFinite(sampleTps)
      ? sampleTps
      : usageComplete && durationMs != null && durationMs >= MIN_SPEED_WINDOW_MS && output > 0
        ? output / (durationMs / 1000)
        : null;
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
    outputTps,
  };
}
