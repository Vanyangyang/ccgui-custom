import { memo, useMemo, type ComponentType, type SVGProps } from "react";
import { useTranslation } from "react-i18next";
import Brain from "lucide-react/dist/esm/icons/brain";
import Clock from "lucide-react/dist/esm/icons/clock";
import Database from "lucide-react/dist/esm/icons/database";
import Wrench from "lucide-react/dist/esm/icons/wrench";
import Zap from "lucide-react/dist/esm/icons/zap";
import type { Message } from "@/lib/ipc";
import { formatTokens } from "@/utils/format-tokens";
import { buildTurnSummary } from "../turn-summary";
import { formatDuration } from "./format-duration";

type Chip = {
  key: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
  tip: string;
};

/** What the finished reply cost, kept visible under it: total time, tokens,
 *  cache hits, reasoning, tool calls and average output speed. Every figure is
 *  something the engine reported or the turn measured; a missing one is left
 *  out instead of being shown as zero. */
export const TurnSummaryBar = memo(function TurnSummaryBar({
  message,
  tools,
}: {
  message: Message;
  tools: number;
}) {
  const { t } = useTranslation();
  const { usage, durationMs } = message;
  const chips = useMemo<Chip[]>(() => {
    const summary = buildTurnSummary({ usage, durationMs }, tools);
    if (!summary) return [];
    const list: Chip[] = [];
    const duration = formatDuration(summary.durationMs);
    if (duration) {
      list.push({ key: "duration", icon: Clock, text: duration, tip: t("chat.turnSummaryDuration") });
    }
    if (summary.input || summary.output) {
      const parts: string[] = [];
      if (summary.input) parts.push(`↑${formatTokens(summary.input)}`);
      if (summary.output) parts.push(`↓${formatTokens(summary.output)}`);
      list.push({
        key: "tokens",
        text: summary.usageComplete ? parts.join(" ") : t("chat.turnSummaryReported", { value: parts.join(" ") }),
        tip: summary.usageComplete ? t("chat.turnSummaryTokens", {
          input: formatTokens(summary.input),
          output: formatTokens(summary.output),
        }) : t("chat.turnSummaryIncomplete"),
      });
    }
    if (summary.cacheHitPercent != null) {
      list.push({
        key: "cache",
        icon: Database,
        text: `${summary.cacheHitPercent}%`,
        tip: t("chat.turnSummaryCache", { percent: summary.cacheHitPercent }),
      });
    }
    if (summary.reasoning != null) {
      list.push({
        key: "reasoning",
        icon: Brain,
        text: formatTokens(summary.reasoning),
        tip: t("chat.turnSummaryReasoning", { tokens: formatTokens(summary.reasoning) }),
      });
    }
    if (summary.tools > 0) {
      list.push({
        key: "tools",
        icon: Wrench,
        text: String(summary.tools),
        tip: t("chat.turnSummaryTools", { count: summary.tools }),
      });
    }
    if (summary.outputTps != null) {
      const tps = summary.outputTps;
      list.push({
        key: "speed",
        icon: Zap,
        text: t("chat.turnSummarySpeedValue", { value: tps < 10 ? tps.toFixed(1) : Math.round(tps) }),
        tip: t("chat.turnSummarySpeed"),
      });
    }
    return list;
  }, [durationMs, t, tools, usage]);
  if (chips.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t("chat.turnSummaryLabel")}
      className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption-1-regular tabular-nums text-text-tertiary"
    >
      {chips.map(({ key, icon: Icon, text, tip }) => (
        <span
          key={key}
          title={tip}
          className="inline-flex items-center gap-1 rounded-full border border-border-secondary bg-background-secondary-default px-2 py-0.5"
        >
          {Icon && <Icon className="size-3 shrink-0 text-foreground-icon-secondary" aria-hidden />}
          {text}
        </span>
      ))}
    </div>
  );
});
