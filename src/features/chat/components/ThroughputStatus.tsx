import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import { averageTps, observedOutputTps, type ThroughputState } from "../throughput";
import { aggregateTps } from "../throughput-stats";
import { useThroughputStats } from "./use-throughput-stats";
import type { ThroughputStatsScope, ThroughputTotals } from "@/lib/ipc";

function TotalsSummary({ title, totals }: { title: string; totals?: ThroughputTotals }) {
  const { t, i18n } = useTranslation();
  const rate = aggregateTps(totals);
  const number = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  return <section className="flex flex-col gap-1 text-caption-1-regular" aria-label={title}>
    <dl className="flex flex-wrap items-start justify-between gap-x-3 text-text-secondary">
      <dt>{title}</dt><dd className="tabular-nums">{rate === null ? "—" : number(rate)} tokens/s</dd>
    </dl>
    {totals && <>
      <p className="text-text-tertiary">{t("chat.throughputRecordedTurns", {complete: totals.completedTurns, total: totals.completedTurns + totals.excludedTurns})}</p>
    </>}
  </section>;
}

/** Per-turn observations and independently persisted session/global statistics. */
export function ThroughputStatus({ throughput, scope }: { throughput: ThroughputState | null | undefined; scope?: ThroughputStatsScope }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);
  const allowOpenChange = useTriggerToggle(open, triggerRef);
  const sample = throughput?.sample;
  const average = averageTps(sample);
  const observed = observedOutputTps(sample);
  const stats = useThroughputStats(scope);
  const sessionAverage = aggregateTps(stats.snapshot?.session);
  const number = (value: number | null) => value === null ? "—" : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  const turnLabel = t("chat.throughputTurn", { value: number(average) });
  const sessionLabel = t("chat.throughputSession", { value: number(sessionAverage) });
  const labels = [scope && sessionAverage !== null ? sessionLabel : null, average !== null ? turnLabel : null,
    average === null && observed !== null && sample?.source === "claude" ? `${t("chat.throughputGenerationTitle")} ${number(observed)} tokens/s` : null].filter((value): value is string => value !== null);
  const label = labels.join(" · ");
  const status = sample?.status === "partial" ? "partial" : !sample || average === null ? "missing" : sample.status;
  const turnReason = sample?.turnReason ?? (sample?.status === "partial" ? "incomplete" : sample?.outputTokens == null ? "missing_usage" : "missing_timing");

  if (labels.length === 0) return null;

  return <DialogTrigger isOpen={open} onOpenChange={next => { if (allowOpenChange(next)) setOpen(next); }}>
    <Button
      ref={triggerRef}
      aria-label={`${label} · ${t(`chat.throughputStatus.${status}`)} · ${t("chat.throughputAverageHint")}`}
      className="flex min-w-0 max-w-full cursor-pointer flex-wrap items-center rounded-full bg-background-secondary-default px-2.5 py-1 text-caption-1-regular tabular-nums text-text-tertiary outline-none transition-colors duration-150 hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none"
    >
      {labels.map((text, index) => <span key={text} title={t(text === sessionLabel ? "chat.throughputAggregateHint" : text === turnLabel ? "chat.throughputAverageHint" : "chat.throughputGenerationHint")} className="whitespace-nowrap">{index > 0 ? " · " : ""}{text}</span>)}
    </Button>
    <Popover ref={popoverRef} isNonModal placement="top end" offset={8}
      className="max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] origin-bottom-right overflow-y-auto rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-dropdown outline-none transition duration-150 ease-out data-[entering]:scale-95 data-[entering]:opacity-0 data-[exiting]:scale-95 data-[exiting]:opacity-0 motion-reduce:transition-none">
      <Dialog aria-label={t("chat.throughputDetails")} className="flex flex-col gap-3 outline-none">
        <div className="flex flex-col gap-2 text-caption-1-regular">
          <dl className="flex flex-wrap items-start justify-between gap-x-3">
            <dt className="text-text-secondary">{t("chat.throughputAverageTitle")}</dt>
            <dd className="tabular-nums text-text-secondary">{number(average)} tokens/s</dd>
          </dl>
          <p className="text-text-tertiary">{t("chat.throughputAverageHint")}</p>
          {average === null && <p className="text-text-secondary">{sample ? t(`chat.throughputTurnReason.${turnReason}`) : t("chat.throughputNoSample")}</p>}
          {sample?.status === "running" && average !== null && <p className="text-text-tertiary">{t("chat.throughputStatus.running")}</p>}
          {sample?.source === "claude" && <>
            <dl className="flex flex-wrap items-start justify-between gap-x-3 border-t border-border-button-default pt-2">
              <dt className="text-text-secondary">{t("chat.throughputGenerationTitle")}</dt>
              <dd className="tabular-nums text-text-secondary">{number(observed)} tokens/s</dd>
            </dl>
            <p className="text-text-tertiary">{t("chat.throughputGenerationHint")}</p>
            {sample.outputRate && <p className="text-text-tertiary">{t("chat.throughputObservedSamples", { complete: sample.outputRate.samples, total: sample.outputRate.samples + sample.outputRate.excludedSamples })}</p>}
          </>}
          {observed === null && <p className="text-text-tertiary">{t("chat.throughputStreamUnavailable")}</p>}
        </div>
        {scope && <details className="border-t border-border-button-default pt-2 text-caption-1-regular text-text-secondary">
          <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring">{t("chat.throughputHistoryTitle")}</summary>
          <div className="mt-3 flex flex-col gap-3">
          <TotalsSummary title={t("chat.throughputSessionTitle")} totals={stats.snapshot?.session} />
          <TotalsSummary title={t("chat.throughputGlobalTitle")} totals={stats.snapshot?.global} />
          {stats.snapshot && Object.entries(stats.snapshot.byEngine).map(([engine, totals]) =>
            <TotalsSummary key={engine} title={engine === "claude" ? "Claude" : engine === "agy" ? "AGY" : "Codex"} totals={totals} />)}
          <p className="text-caption-1-regular text-text-tertiary">{t("chat.throughputAggregateHint")}</p>
          {stats.snapshot?.startedAt && <p className="text-caption-1-regular text-text-tertiary">{t("chat.throughputStartedAt", {time: new Date(stats.snapshot.startedAt).toLocaleString(i18n.language)})}</p>}
          {stats.loading && <p role="status" className="text-caption-1-regular text-text-tertiary">{t("chat.throughputStatsLoading")}</p>}
          {stats.error && <p role="alert" className="text-caption-1-regular text-text-warning-primary">{t("chat.throughputStatsUnavailable")}</p>}
          <p className="text-caption-1-regular text-text-tertiary">{t("chat.throughputHistoryHint")}</p>
          </div>
        </details>}
        <div className="flex flex-col gap-1 border-t border-border-button-default pt-2 text-caption-1-regular text-text-secondary">
          {sample && <p>{t("chat.throughputSource", { source: t(`chat.throughputSources.${sample.source}`) })}</p>}
        </div>
      </Dialog>
    </Popover>
  </DialogTrigger>;
}
