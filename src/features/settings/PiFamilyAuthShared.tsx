/** Shared row chrome for the pi/omp「供应商认证」sections (extracted from
 *  PiFamilyAuthSection so each section component can live in its own file). */
import Globe from "lucide-react/dist/esm/icons/globe";
import { cx } from "@/utils/cx";

/** Same row chrome as CliConfigSection. */
export const ROW =
  "flex min-h-[52px] w-full items-center gap-3 py-2.5 pr-2.5 border-b border-separator-border last:border-b-0";

export const TEXT_BTN =
  "shrink-0 rounded-lg px-2 py-1 text-body-2-medium text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary disabled:opacity-40";

export function BrandIcon({ iconSrc }: { iconSrc: string | null }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background-tertiary">
      {iconSrc ? (
        <img src={iconSrc} alt="" className="size-5" aria-hidden />
      ) : (
        <Globe className="size-4 text-foreground-icon-secondary" aria-hidden />
      )}
    </span>
  );
}

export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-1.5 rounded-full",
        on ? "bg-notification-success-foreground" : "bg-text-tertiary",
      )}
    />
  );
}
