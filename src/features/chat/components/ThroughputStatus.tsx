import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import {
  averageTps,
  endToEndTps,
  formatTps,
  liveEstimateTps,
  MIN_COMPLETE_WINDOW_MS,
  MIN_RUNNING_WINDOW_MS,
  observedOutputTps,
  type ThroughputBreakdown,
  type ThroughputState,
} from "../throughput";
import { aggregateTps } from "../throughput-stats";
import { formatDuration } from "./format-duration";
import { useThroughputStats } from "./use-throughput-stats";
import type { ThroughputStatsScope, ThroughputTotals } from "@/lib/ipc";

const ENGINE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  agy: "AGY",
  cursor: "Cursor",
};

function formatBreakdown(
  breakdown: ThroughputBreakdown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [
    t("chat.throughputBreakdownModel", { value: formatDuration(breakdown.modelMs) ?? "0.0s" }),
  ];
  if (breakdown.toolMs >= 50) {
    parts.push(t("chat.throughputBreakdownTool", { value: formatDuration(breakdown.toolMs) ?? "0.1s" }));
  }
  if (breakdown.waitMs >= 50) {
    parts.push(t("chat.throughputBreakdownWait", { value: formatDuration(breakdown.waitMs) ?? "0.1s" }));
  }
  if (breakdown.startupMs >= 50) {
    parts.push(t("chat.throughputBreakdownStartup", { value: formatDuration(breakdown.startupMs) ?? "0.1s" }));
  }
  parts.push(t("chat.throughputBreakdownWall", { value: formatDuration(breakdown.wallMs) ?? "0.0s" }));
  return parts.join(" · ");
}

function TotalsSummary({ title, totals }: { title: string; totals?: ThroughputTotals }) {
  const { t, i18n } = useTranslation();
  const rate = aggregateTps(totals);
  const fmt = (value: number) => formatTps(value, i18n.language);
  const hasSplitCounts =
    totals !== undefined &&
    totals.interruptedTurns !== undefined &&
    totals.missingTurns !== undefined;
  return (
    <section className="flex flex-col gap-1 text-caption-1-regular" aria-label={title}>
      <dl className="flex flex-wrap items-start justify-between gap-x-3 text-text-secondary">
        <dt className="min-w-0 truncate">{title}</dt>
        <dd className="tabular-nums">
          {rate === null ? "—" : fmt(rate)} tok/s
          {totals?.medianTps !== undefined && rate !== null && (
            <span className="ml-1.5 text-text-tertiary">
              ({t("chat.throughputMedian", { value: fmt(totals.medianTps) })})
            </span>
          )}
        </dd>
      </dl>
      {totals && (
        <p className="text-text-tertiary">
          {hasSplitCounts
            ? t("chat.throughputRecordedTurnsSplit", {
                complete: totals.completedTurns,
                interrupted: totals.interruptedTurns,
                missing: totals.missingTurns,
              })
            : t("chat.throughputRecordedTurns", {
                complete: totals.completedTurns,
                total: totals.completedTurns + totals.excludedTurns,
              })}
        </p>
      )}
    </section>
  );
}

/** Always-present steady-state session TPS pill with live running estimate and 3-tier breakdown popover. */
export function ThroughputStatus({
  throughput,
  scope,
}: {
  throughput: ThroughputState | null | undefined;
  scope?: ThroughputStatsScope;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<"model" | "engine">("model");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(open, triggerRef);

  const sample = throughput?.sample;
  const average = averageTps(sample);
  const observed = observedOutputTps(sample);
  const isRunning = sample?.status === "running";
  const liveRate = isRunning
    ? (liveEstimateTps(sample) ?? (sample?.source === "claude" ? observed : null))
    : null;
  const endToEnd = endToEndTps(sample);
  const stats = useThroughputStats(scope);
  const sessionAverage = aggregateTps(stats.snapshot?.session);
  const fmt = (value: number | null) => (value === null ? "—" : formatTps(value, i18n.language));

  const segments: Array<{ key: string; text: string; tip: string }> = [];
  if (scope) {
    if (sessionAverage !== null) {
      segments.push({
        key: "session",
        text: t("chat.throughputSessionSteady", { value: fmt(sessionAverage) }),
        tip: t("chat.throughputAggregateHint"),
      });
    } else if (stats.error && !stats.snapshot && average !== null) {
      segments.push({
        key: "turn",
        text: t("chat.throughputTurn", { value: fmt(average) }),
        tip: t("chat.throughputAverageHint"),
      });
    } else {
      segments.push({
        key: "session",
        text: t("chat.throughputSessionEmpty"),
        tip: t("chat.throughputAggregateHint"),
      });
    }
    if (isRunning && liveRate !== null) {
      segments.push({
        key: "live",
        text: t("chat.throughputLiveEstimate", { value: fmt(liveRate) }),
        tip: t("chat.throughputLiveEstimateHint"),
      });
    }
  } else {
    if (isRunning && sample?.liveEstimate && liveRate !== null) {
      segments.push({
        key: "live",
        text: t("chat.throughputLiveEstimate", { value: fmt(liveRate) }),
        tip: t("chat.throughputLiveEstimateHint"),
      });
    } else if (average !== null) {
      segments.push({
        key: "turn",
        text: t("chat.throughputTurn", { value: fmt(average) }),
        tip: t("chat.throughputAverageHint"),
      });
    } else if (observed !== null && sample?.source === "claude") {
      segments.push({
        key: "observed",
        text: `${t("chat.throughputGenerationTitle")} ${fmt(observed)} tok/s`,
        tip: t("chat.throughputGenerationHint"),
      });
    }
  }

  if (segments.length === 0) return null;

  const label = segments.map((segment) => segment.text).join(" · ");
  const status =
    sample?.status === "partial"
      ? "partial"
      : isRunning && liveRate !== null
        ? "running"
        : !sample || average === null
          ? "missing"
          : sample.status;
  const minWindow = sample?.status === "running" ? MIN_RUNNING_WINDOW_MS : MIN_COMPLETE_WINDOW_MS;
  const turnReason =
    sample?.turnReason ??
    (sample?.status === "partial"
      ? "incomplete"
      : sample?.outputTokens == null || sample.outputTokens <= 0
        ? "missing_usage"
        : sample?.elapsedMs == null
          ? "missing_timing"
          : sample.elapsedMs < minWindow
            ? "insufficient_timing"
            : "implausible");

  const modelEntries = Object.entries(stats.snapshot?.byModel ?? {}).sort(
    ([, a], [, b]) => b.completedTurns - a.completedTurns || b.outputTokens - a.outputTokens,
  );
  const engineEntries = Object.entries(stats.snapshot?.byEngine ?? {});
  const hasModels = modelEntries.length > 0;
  const effectiveGroup = groupBy === "model" && hasModels ? "model" : "engine";

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        if (allowOpenChange(next)) setOpen(next);
      }}
    >
      <Button
        ref={triggerRef}
        aria-label={`${label} · ${t(`chat.throughputStatus.${status}`)} · ${t("chat.throughputAverageHint")}`}
        className="flex min-w-0 max-w-full cursor-pointer flex-wrap items-center rounded-full bg-background-secondary-default px-2.5 py-1 text-caption-1-regular tabular-nums text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none"
      >
        {segments.map((segment, index) => (
          <span key={segment.key} title={segment.tip} className="whitespace-nowrap">
            {index > 0 ? " · " : ""}
            {segment.text}
          </span>
        ))}
      </Button>
      <Popover
        ref={popoverRef}
        isNonModal
        placement="top end"
        offset={8}
        className="max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] origin-bottom-right overflow-y-auto rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none"
      >
        <Dialog aria-label={t("chat.throughputDetails")} className="flex flex-col gap-3 outline-none">
          <div className="flex flex-col gap-2 text-caption-1-regular">
            <dl className="flex flex-wrap items-start justify-between gap-x-3">
              <dt className="text-text-secondary">{t("chat.throughputAverageTitle")}</dt>
              <dd className="tabular-nums text-text-secondary">
                {isRunning && average === null && liveRate !== null
                  ? `~${fmt(liveRate)} tok/s`
                  : `${fmt(average)} tok/s`}
              </dd>
            </dl>
            <p className="text-text-tertiary">
              {isRunning && sample?.liveEstimate
                ? t("chat.throughputLiveEstimateHint")
                : t("chat.throughputAverageHint")}
            </p>
            {sample?.breakdown && sample.status === "complete" && sample.turnReason == null && (
              <p className="text-text-tertiary">{formatBreakdown(sample.breakdown, t)}</p>
            )}
            {endToEnd !== null && (
              <dl className="flex flex-wrap items-start justify-between gap-x-3 pt-0.5">
                <dt className="text-text-tertiary">{t("chat.throughputEndToEndTitle")}</dt>
                <dd className="tabular-nums text-text-tertiary" title={t("chat.throughputEndToEndHint")}>
                  {fmt(endToEnd)} tok/s
                </dd>
              </dl>
            )}
            {average === null && !(isRunning && liveRate !== null) && (
              <p className="text-text-secondary">
                {sample ? t(`chat.throughputTurnReason.${turnReason}`) : t("chat.throughputNoSample")}
              </p>
            )}
            {isRunning && (average !== null || liveRate !== null) && (
              <p className="text-text-tertiary">{t("chat.throughputStatus.running")}</p>
            )}
            {sample?.source === "claude" && (observed !== null || Boolean(sample.outputRate)) && (
              <>
                <dl className="flex flex-wrap items-start justify-between gap-x-3 border-t border-border-button-default pt-2">
                  <dt className="text-text-secondary">{t("chat.throughputGenerationTitle")}</dt>
                  <dd className="tabular-nums text-text-secondary">{fmt(observed)} tok/s</dd>
                </dl>
                <p className="text-text-tertiary">{t("chat.throughputGenerationHint")}</p>
                {sample.outputRate && (
                  <p className="text-text-tertiary">
                    {t("chat.throughputObservedSamples", {
                      complete: sample.outputRate.samples,
                      total: sample.outputRate.samples + sample.outputRate.excludedSamples,
                    })}
                  </p>
                )}
              </>
            )}
          </div>

          {scope && (
            <div className="flex flex-col gap-2 border-t border-border-button-default pt-2">
              <TotalsSummary title={t("chat.throughputSessionTitle")} totals={stats.snapshot?.session} />
              {stats.error && (
                <p role="alert" className="text-caption-1-regular text-text-warning-primary">
                  {t("chat.throughputStatsUnavailable")}
                </p>
              )}
            </div>
          )}

          {scope && (
            <details className="border-t border-border-button-default pt-2 text-caption-1-regular text-text-secondary">
              <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">
                {t("chat.throughputHistoryTitle")}
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <TotalsSummary title={t("chat.throughputGlobalTitle")} totals={stats.snapshot?.global} />
                {hasModels && (
                  <div
                    role="group"
                    aria-label={t("chat.throughputHistoryTitle")}
                    className="inline-flex self-start rounded-lg bg-background-secondary-default p-0.5"
                  >
                    <button
                      type="button"
                      aria-pressed={effectiveGroup === "model"}
                      onClick={() => setGroupBy("model")}
                      className={`cursor-pointer rounded-md px-2 py-0.5 text-caption-1-regular transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none ${
                        effectiveGroup === "model"
                          ? "bg-button-primary text-text-white"
                          : "bg-transparent text-text-tertiary hover:text-text-secondary"
                      }`}
                    >
                      {t("chat.throughputGroupByModel")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={effectiveGroup === "engine"}
                      onClick={() => setGroupBy("engine")}
                      className={`cursor-pointer rounded-md px-2 py-0.5 text-caption-1-regular transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none ${
                        effectiveGroup === "engine"
                          ? "bg-button-primary text-text-white"
                          : "bg-transparent text-text-tertiary hover:text-text-secondary"
                      }`}
                    >
                      {t("chat.throughputGroupByEngine")}
                    </button>
                  </div>
                )}
                {effectiveGroup === "model"
                  ? modelEntries.map(([model, totals]) => (
                      <TotalsSummary key={model} title={model} totals={totals} />
                    ))
                  : engineEntries.map(([engine, totals]) => (
                      <TotalsSummary
                        key={engine}
                        title={ENGINE_LABELS[engine] ?? engine}
                        totals={totals}
                      />
                    ))}
                <p className="text-caption-1-regular text-text-tertiary">{t("chat.throughputAggregateHint")}</p>
                {stats.snapshot?.startedAt && (
                  <p className="text-caption-1-regular text-text-tertiary">
                    {t("chat.throughputStartedAt", {
                      time: new Date(stats.snapshot.startedAt).toLocaleString(i18n.language),
                    })}
                  </p>
                )}
                {stats.loading && (
                  <p role="status" className="text-caption-1-regular text-text-tertiary">
                    {t("chat.throughputStatsLoading")}
                  </p>
                )}
                <p className="text-caption-1-regular text-text-tertiary">{t("chat.throughputHistoryHint")}</p>
              </div>
            </details>
          )}

          {sample && (
            <div className="flex flex-col gap-1 border-t border-border-button-default pt-2 text-caption-1-regular text-text-secondary">
              <p>
                {sample.model
                  ? t("chat.throughputSourceWithModel", {
                      source: t(`chat.throughputSources.${sample.source}`),
                      model: sample.model,
                    })
                  : t("chat.throughputSource", { source: t(`chat.throughputSources.${sample.source}`) })}
              </p>
            </div>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
