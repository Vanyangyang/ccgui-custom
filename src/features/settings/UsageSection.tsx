import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Pause from "lucide-react/dist/esm/icons/pause";
import Play from "lucide-react/dist/esm/icons/play";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import {
  ipc,
  type AgyQuotaSnapshot,
  type ClaudeQuotaSnapshot,
  type CodexQuotaSnapshot,
  type UsageRow,
} from "@/lib/ipc";
import {
  listenAgyQuotaChanged,
  listenClaudeQuotaChanged,
  listenCodexQuotaChanged,
  listenUsageChanged,
} from "@/lib/events";
import { validAgyQuotaSnapshot } from "@/features/chat/agy-quota";
import { validClaudeQuotaSnapshot } from "@/features/chat/claude-quota";
import { validSubscriptionQuotaSnapshot } from "@/features/chat/subscription-quota";
import {
  setUsageTrackingEnabled,
  usageTrackingEnabled,
} from "./usage-tracking";
import { UsageChart } from "./UsageChart";
import { modelDisplayName } from "./usage-model";
import {
  addCostBreakdowns,
  buildQuotaWindowSpans,
  computeModelCost,
  computeQuotaInferences,
  emptyCostBreakdown,
  formatPercent,
  formatUsd,
  sumRowsCost,
  type CostBreakdown,
  type EngineQuotaInference,
} from "./usage-pricing";
import { tokensOf } from "./usage-totals";
import {
  cliBuckets,
  dayBuckets,
  monthBuckets,
  type UsageBucket,
} from "./usage-buckets";
import { formatTokens } from "@/utils/format-tokens";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ModelBadge } from "@/components/foundations/icons/model-badge";
import type { EngineIconId } from "@/components/foundations/icons/engine-icon";

type Range = "today" | "week" | "month" | "year" | "all";

/** Same affordance the message rows use: bare icon, hover-revealed chrome. */
const ICON_BUTTON =
  "flex size-7 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary";

const RANGES: { id: Range; labelKey: string }[] = [
  { id: "today", labelKey: "usage.rangeToday" },
  { id: "week", labelKey: "usage.rangeWeek" },
  { id: "month", labelKey: "usage.rangeMonth" },
  { id: "year", labelKey: "usage.rangeYear" },
  { id: "all", labelKey: "usage.rangeAll" },
];

function rangeDays(range: Range): number {
  switch (range) {
    case "today":
      return 1;
    case "week":
      return 7;
    case "month":
      return 31;
    case "year":
      return 366;
    case "all":
      return 0;
  }
}

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function rangeStart(range: Range, now: Date): string {
  if (range === "all") return "";
  if (range === "today") return dayKey(now);
  if (range === "year") return dayKey(new Date(now.getFullYear(), 0, 1));
  if (range === "month") return dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const monday = new Date(now);
  const back = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - back);
  return dayKey(monday);
}

interface Totals {
  key: string;
  engine: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  cost: CostBreakdown;
}

const emptyTotals = (key: string, engine: string): Totals => ({
  key,
  engine,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
  cost: emptyCostBreakdown(),
});

function fold(rows: UsageRow[], keyOf: (row: UsageRow) => string, engineOf: (row: UsageRow) => string): Totals[] {
  const map = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? emptyTotals(key, engineOf(row));
    entry.input += row.input;
    entry.output += row.output;
    entry.cacheRead += row.cacheRead;
    entry.cacheWrite += row.cacheWrite;
    entry.requests += row.requests;
    entry.cost = addCostBreakdowns(entry.cost, computeModelCost(row.engine, row.model, row));
    map.set(key, entry);
  }
  const total = (e: Totals) => e.input + e.output + e.cacheRead + e.cacheWrite;
  return [...map.values()].sort((a, b) => total(b) - total(a));
}

const sum = (entries: Totals[]) =>
  entries.reduce(
    (acc, e) => ({
      input: acc.input + e.input,
      output: acc.output + e.output,
      cacheRead: acc.cacheRead + e.cacheRead,
      cacheWrite: acc.cacheWrite + e.cacheWrite,
      requests: acc.requests + e.requests,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
  );

function ShareBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-background-tertiary-default">
      <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

const ENGINE_ICON_IDS: readonly EngineIconId[] = [
  "claude",
  "codex",
  "grok",
  "kimi",
  "pi",
  "omp",
  "dsh",
  "agy",
  "opencode",
  "qoder",
  "qoder-cn",
  "cursor",
];
const isEngineIcon = (engine: string): engine is EngineIconId =>
  ENGINE_ICON_IDS.includes(engine as EngineIconId);

export function UsageSection() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [range, setRange] = useState<Range>("today");
  const [enabled, setEnabled] = useState(usageTrackingEnabled);
  const [confirmClear, setConfirmClear] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quotaInferences, setQuotaInferences] = useState<EngineQuotaInference[]>([]);

  const refreshQuotasAndWindows = useCallback(async () => {
    try {
      const nowSec = Date.now() / 1000;
      const [claudeRaw, codexRaw, agyRaw] = await Promise.all([
        typeof ipc.claudeQuotaRead === "function"
          ? ipc.claudeQuotaRead({ cacheOnly: true, force: false }).catch(() => undefined)
          : Promise.resolve(undefined),
        typeof ipc.codexQuotaRead === "function"
          ? ipc.codexQuotaRead({ cacheOnly: true, force: false }).catch(() => undefined)
          : Promise.resolve(undefined),
        typeof ipc.agyQuotaRead === "function"
          ? ipc.agyQuotaRead({ cacheOnly: true, force: false }).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);

      const snapshots: {
        claude?: ClaudeQuotaSnapshot;
        codex?: CodexQuotaSnapshot;
        agy?: AgyQuotaSnapshot;
      } = {
        claude: claudeRaw ? validClaudeQuotaSnapshot(claudeRaw, nowSec) : undefined,
        codex: codexRaw ? validSubscriptionQuotaSnapshot(codexRaw, nowSec) : undefined,
        agy: agyRaw ? validAgyQuotaSnapshot(agyRaw, nowSec) : undefined,
      };

      const spans = buildQuotaWindowSpans(snapshots, nowSec);
      const windowRows =
        typeof ipc.usageWindowTotals === "function"
          ? await ipc.usageWindowTotals(spans).catch(() => [])
          : [];
      setQuotaInferences(computeQuotaInferences(windowRows, snapshots, nowSec));
    } catch {
      // Keep last good snapshot.
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await ipc.usageSummary(
        rangeDays(range),
        -new Date().getTimezoneOffset(),
      );
      setRows(next);
      void refreshQuotasAndWindows();
    } catch {
      // A failed read keeps the last good snapshot on screen.
    } finally {
      setLoading(false);
    }
  }, [range, refreshQuotasAndWindows]);

  useEffect(() => {
    void refresh();
    const unlisteners = [
      listenUsageChanged(() => void refresh()),
      typeof listenClaudeQuotaChanged === "function"
        ? listenClaudeQuotaChanged(() => void refreshQuotasAndWindows())
        : Promise.resolve(() => {}),
      typeof listenCodexQuotaChanged === "function"
        ? listenCodexQuotaChanged(() => void refreshQuotasAndWindows())
        : Promise.resolve(() => {}),
      typeof listenAgyQuotaChanged === "function"
        ? listenAgyQuotaChanged(() => void refreshQuotasAndWindows())
        : Promise.resolve(() => {}),
    ];
    return () => {
      for (const p of unlisteners) {
        void p.then((off) => off());
      }
    };
  }, [refresh, refreshQuotasAndWindows]);

  const scoped = useMemo(() => {
    const from = rangeStart(range, new Date());
    return rows.filter((row) => row.day >= from);
  }, [rows, range]);

  const byEngine = useMemo(() => fold(scoped, (row) => row.engine, (row) => row.engine), [scoped]);
  const byCli = useMemo(() => {
    const clis = new Map<string, { engine: string; models: Totals[]; cost: CostBreakdown }>();
    for (const row of scoped) {
      const cli = clis.get(row.engine) ?? {
        engine: row.engine,
        models: [],
        cost: emptyCostBreakdown(),
      };
      const name = modelDisplayName(row.model);
      const existing = cli.models.find((m) => m.key === name);
      const entry = existing ?? emptyTotals(name, row.engine);
      const rowCost = computeModelCost(row.engine, name, row);
      entry.input += row.input;
      entry.output += row.output;
      entry.cacheRead += row.cacheRead;
      entry.cacheWrite += row.cacheWrite;
      entry.requests += row.requests;
      entry.cost = addCostBreakdowns(entry.cost, rowCost);
      cli.cost = addCostBreakdowns(cli.cost, rowCost);
      if (!existing) cli.models.push(entry);
      clis.set(row.engine, cli);
    }
    for (const cli of clis.values()) {
      for (const m of cli.models) {
        const prompt = m.input + m.cacheRead + m.cacheWrite;
        m.cost.promptTokens = prompt;
        m.cost.cacheHitRate = prompt > 0 ? (m.cacheRead / prompt) * 100 : null;
      }
      const cliPrompt = cli.models.reduce((acc, m) => acc + m.input + m.cacheRead + m.cacheWrite, 0);
      const cliCacheRead = cli.models.reduce((acc, m) => acc + m.cacheRead, 0);
      cli.cost.promptTokens = cliPrompt;
      cli.cost.cacheHitRate = cliPrompt > 0 ? (cliCacheRead / cliPrompt) * 100 : null;
      cli.models.sort((a, b) => tokensOf(b) - tokensOf(a));
    }
    return [...clis.values()].sort(
      (a, b) =>
        b.models.reduce((acc, m) => acc + tokensOf(m), 0) -
        a.models.reduce((acc, m) => acc + tokensOf(m), 0),
    );
  }, [scoped]);

  const totals = useMemo(() => sum(byEngine), [byEngine]);
  const totalCostSummary = useMemo(() => sumRowsCost(scoped), [scoped]);
  const hasClaudeCacheRead = useMemo(
    () => scoped.some((r) => r.engine === "claude" && r.cacheRead > 0),
    [scoped],
  );
  const claudeFreeCacheRefUsd = useMemo(
    () => Math.max(0, totalCostSummary.cacheReadRefUsd - totalCostSummary.cacheReadBilledUsd),
    [totalCostSummary],
  );

  const dayList = useMemo(() => {
    if (range === "year" || range === "all") return [];
    const today = dayKey(new Date());
    const [year, month, day] = rangeStart(range, new Date()).split("-").map(Number);
    const days: string[] = [];
    for (const cursor = new Date(year, month - 1, day); ; cursor.setDate(cursor.getDate() + 1)) {
      const key = dayKey(cursor);
      if (key > today) break;
      days.push(key);
    }
    return days;
  }, [range]);

  const buckets = useMemo<UsageBucket[]>(() => {
    if (range === "all") {
      return cliBuckets(
        byCli.map((cli) => ({
          engine: cli.engine,
          label: CLI_DISPLAY_NAMES[cli.engine] ?? cli.engine,
        })),
      );
    }
    if (range === "year") {
      return monthBuckets(rangeStart("year", new Date()), dayKey(new Date()));
    }
    return dayBuckets(dayList);
  }, [byCli, dayList, range]);

  const bucketOf = useCallback(
    (row: UsageRow) => {
      if (range === "all") return row.engine;
      if (range === "year") return row.day.slice(0, 7);
      return row.day;
    },
    [range],
  );

  const bucketTotalLabel =
    range === "year"
      ? t("usage.tooltipMonth")
      : range === "all"
        ? t("usage.tooltipCli")
        : t("usage.tooltipTotal");

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsCard>
        <div className="flex w-full flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-background-tertiary-default p-0.5">
              {RANGES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setRange(item.id)}
                  className={
                    item.id === range
                      ? "cursor-pointer rounded-md bg-background-primary-default px-2.5 py-1 text-body-2-medium text-text-primary shadow-sm"
                      : "cursor-pointer rounded-md px-2.5 py-1 text-body-2-medium text-text-secondary"
                  }
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={enabled ? t("usage.trackingDisable") : t("usage.trackingEnable")}
                title={enabled ? t("usage.trackingDisable") : t("usage.trackingEnable")}
                onClick={() => {
                  const next = !enabled;
                  setUsageTrackingEnabled(next);
                  setEnabled(next);
                }}
                className={ICON_BUTTON}
              >
                {enabled ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              </button>
              <button
                type="button"
                aria-label={t("usage.clear")}
                title={confirmClear ? t("usage.clearConfirm") : t("usage.clear")}
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true);
                    return;
                  }
                  void ipc
                    .usageClear()
                    .then(() => {
                      setConfirmClear(false);
                      void refresh();
                    })
                    .catch(() => setConfirmClear(false));
                }}
                onBlur={() => setConfirmClear(false)}
                className={confirmClear ? `${ICON_BUTTON} text-text-error-primary` : ICON_BUTTON}
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="flex flex-col gap-0.5">
              <span className="text-body-2-regular text-text-secondary">{t("usage.tokens")}</span>
              <span className="text-title-3 text-text-primary tabular-nums">
                {formatTokens(tokensOf(totals))}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-body-2-regular text-text-secondary">{t("usage.input")}</span>
              <span className="text-title-3 text-text-primary tabular-nums">
                {formatTokens(totals.input + totals.cacheRead + totals.cacheWrite)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-body-2-regular text-text-secondary">{t("usage.output")}</span>
              <span className="text-title-3 text-text-primary tabular-nums">
                {formatTokens(totals.output)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-body-2-regular text-text-secondary">{t("usage.turns")}</span>
              <span className="text-title-3 text-text-primary tabular-nums">{totals.requests}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-body-2-regular text-text-secondary">{t("usage.costUsd")}</span>
              <span className="text-title-3 text-text-primary tabular-nums">
                {formatUsd(totalCostSummary.actualTotalUsd)}
              </span>
            </div>
          </div>

          {tokensOf(totals) > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-separator-border pt-2 text-caption-1-regular text-text-tertiary tabular-nums">
              <span>
                {t("usage.freshInput")} {formatTokens(totals.input)} ({formatUsd(totalCostSummary.inputUsd)})
              </span>
              <span>
                {t("usage.cacheRead")} {formatTokens(totals.cacheRead)}{" "}
                {hasClaudeCacheRead && totalCostSummary.cacheReadBilledUsd === 0
                  ? `(${t("usage.claudeCacheFreeInline", { refCost: formatUsd(claudeFreeCacheRefUsd) })})`
                  : hasClaudeCacheRead && claudeFreeCacheRefUsd > 0
                    ? `(${formatUsd(totalCostSummary.cacheReadBilledUsd)} · Claude ${t("usage.claudeCacheFreeInline", { refCost: formatUsd(claudeFreeCacheRefUsd) })})`
                    : `(${formatUsd(totalCostSummary.cacheReadBilledUsd)})`}
              </span>
              {totals.cacheWrite > 0 && (
                <span>
                  {t("usage.cacheWrite")} {formatTokens(totals.cacheWrite)} ({formatUsd(totalCostSummary.cacheWriteUsd)})
                </span>
              )}
              {totalCostSummary.cacheHitRate !== null && (
                <span>
                  {t("usage.cacheHitRate")} {formatPercent(totalCostSummary.cacheHitRate, 1)}
                </span>
              )}
              {totalCostSummary.savedUsd > 0 && (
                <span className="text-text-success-primary">
                  {t("usage.savedUsd", { cost: formatUsd(totalCostSummary.savedUsd) })}
                </span>
              )}
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-body-medium text-text-primary">{t("usage.chartTitle")}</span>
            <span className="text-body-2-regular text-text-tertiary">
              {t("usage.chartTotal", {
                tokens: formatTokens(tokensOf(totals)),
                cost: formatUsd(totalCostSummary.actualTotalUsd),
              })}
            </span>
          </div>
          <UsageChart
            rows={scoped}
            buckets={buckets}
            bucketOf={bucketOf}
            formatTokens={formatTokens}
            axisLabel={t(RANGES.find((item) => item.id === range)?.labelKey ?? "usage.rangeToday")}
            bucketTotalLabel={bucketTotalLabel}
          />
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-body-medium text-text-primary">{t("usage.details")}</span>
            <span className="text-body-2-regular text-text-tertiary">{t("usage.perRange")}</span>
          </div>
          {loading ? (
            <p className="py-2 text-body-regular text-text-tertiary">{t("usage.loading")}</p>
          ) : byCli.length === 0 ? (
            <p className="py-2 text-body-regular text-text-tertiary">{t("usage.empty")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {byCli.map((cli) => {
                const total = cli.models.reduce((acc, m) => acc + tokensOf(m), 0);
                const maxModel = cli.models.length ? tokensOf(cli.models[0]) : 0;
                const isClaude = cli.engine === "claude";
                const cliInferences = quotaInferences.filter((q) => q.engine === cli.engine);

                return (
                  <div key={cli.engine} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2">
                        {isEngineIcon(cli.engine) && (
                          <EngineIcon
                            engine={cli.engine}
                            size={16}
                            className="shrink-0 text-foreground-icon-primary"
                          />
                        )}
                        <span className="text-body-medium text-text-primary">
                          {CLI_DISPLAY_NAMES[cli.engine] ?? cli.engine}
                        </span>
                        {cliInferences.map((inf) => {
                          const w5 = inf.fiveHour;
                          const w7 = inf.sevenDay;
                          const has5 = w5.usedPercentage !== undefined || w5.inferredLimitUsd !== null;
                          const has7 = w7.usedPercentage !== undefined || inf.weeklyLimitEstimateUsd !== null;
                          if (!has5 && !has7) return null;
                          return (
                            <span
                              key={inf.id}
                              className="flex flex-wrap items-center gap-1.5 rounded bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-regular tabular-nums text-text-secondary"
                            >
                              {has5 && (
                                <span>
                                  {t("usage.quotaWindow5h")} {formatUsd(w5.localSpentUsd)}
                                  {w5.inferredLimitUsd !== null ? ` / ~${formatUsd(w5.inferredLimitUsd)}` : ""}
                                  {w5.usedPercentage !== undefined ? ` (${formatPercent(w5.usedPercentage, 0)})` : ""}
                                </span>
                              )}
                              {has5 && has7 && <span className="text-text-tertiary">·</span>}
                              {has7 && (
                                <span>
                                  {t("usage.quotaWindow7d")} {formatUsd(w7.localSpentUsd)}
                                  {inf.weeklyLimitEstimateUsd !== null
                                    ? ` / ~${formatUsd(inf.weeklyLimitEstimateUsd)}`
                                    : ""}
                                  {w7.usedPercentage !== undefined ? ` (${formatPercent(w7.usedPercentage, 0)})` : ""}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </span>
                      <span className="text-body-medium text-text-secondary tabular-nums">
                        {formatTokens(total)} · {formatUsd(cli.cost.actualTotalUsd)}
                        {isClaude && cli.cost.cacheReadRefUsd > 0 && (
                          <span className="ml-1 text-caption-1-regular text-text-tertiary">
                            ({t("usage.claudeCacheFreeInline", { refCost: formatUsd(cli.cost.cacheReadRefUsd) })})
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2 pl-6">
                      {cli.models.map((model) => {
                        const modelTokens = tokensOf(model);
                        return (
                          <div key={model.key || "__unknown__"} className="flex w-full flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <ModelBadge name={model.key} size={12} className="shrink-0" />
                                <span className="truncate text-body-regular text-text-primary">
                                  {model.key || t("usage.unknownModel")}
                                </span>
                              </span>
                              <span className="shrink-0 text-body-2-regular text-text-secondary tabular-nums">
                                {formatTokens(modelTokens)} · {formatUsd(model.cost.actualTotalUsd)}
                              </span>
                            </div>
                            <ShareBar
                              pct={maxModel > 0 ? Math.max(2, Math.round((modelTokens / maxModel) * 100)) : 0}
                            />
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-caption-1-regular text-text-tertiary tabular-nums">
                              <span className="flex flex-wrap items-center gap-x-2.5">
                                <span>
                                  {t("usage.freshInput")} {formatTokens(model.input)} ({formatUsd(model.cost.inputUsd)})
                                </span>
                                <span>
                                  {t("usage.cacheRead")} {formatTokens(model.cacheRead)}{" "}
                                  {isClaude
                                    ? `(${t("usage.claudeCacheFreeInline", { refCost: formatUsd(model.cost.cacheReadRefUsd) })})`
                                    : `(${formatUsd(model.cost.cacheReadBilledUsd)})`}
                                </span>
                                {model.cacheWrite > 0 && (
                                  <span>
                                    {t("usage.cacheWrite")} {formatTokens(model.cacheWrite)} ({formatUsd(model.cost.cacheWriteUsd)})
                                  </span>
                                )}
                                <span>
                                  {t("usage.output")} {formatTokens(model.output)} ({formatUsd(model.cost.outputUsd)})
                                </span>
                              </span>
                              <span className="flex items-center gap-x-2">
                                {model.cost.cacheHitRate !== null && (
                                  <span>
                                    {t("usage.cacheHitRate")} {formatPercent(model.cost.cacheHitRate, 1)}
                                  </span>
                                )}
                                {model.cost.savedUsd > 0 && (
                                  <span className="text-text-success-primary">
                                    {t("usage.savedUsd", { cost: formatUsd(model.cost.savedUsd) })}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SettingsCard>

      <p className="px-1 text-body-2-regular text-text-tertiary">{t("usage.footnote")}</p>
    </div>
  );
}
