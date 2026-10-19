import { cx } from "@/utils/cx";

/** Fill colour by consumed share: calm below 75%, warning from 75%, danger from 90%. */
export function quotaMeterTone(usedPercentage: number): string {
  if (usedPercentage >= 90) return "bg-red-500";
  if (usedPercentage >= 75) return "bg-amber-500";
  return "bg-blue-500";
}

/** Thin track + fill for a quota share (0–100). Unknown values render an empty track. */
export function QuotaMeter({ usedPercentage, remaining = false, className }: { usedPercentage?: number; remaining?: boolean; className?: string }) {
  const known = usedPercentage !== undefined && Number.isFinite(usedPercentage);
  const used = known ? Math.max(0, Math.min(100, usedPercentage)) : 0;
  const fill = remaining ? 100 - used : used;
  return <div aria-hidden className={cx("h-1.5 w-full overflow-hidden rounded-full bg-chart-track", className)}>
    {known && <div className={cx("h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none", quotaMeterTone(used))}
      style={{ width: `${fill}%` }} />}
  </div>;
}

/** Label/value row for read-only facts such as credits or reset chances. */
export function QuotaFact({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="flex flex-col gap-0.5">
    <div className="flex items-center justify-between gap-3 text-caption-1-regular text-text-secondary">
      <dt>{label}</dt>
      <dd className="text-text-primary tabular-nums">{value}</dd>
    </div>
    {note && <p className="text-caption-1-regular text-text-tertiary">{note}</p>}
  </div>;
}
