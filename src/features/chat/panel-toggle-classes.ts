import { cx } from "@/utils/cx";

/** Shared chrome for the small icon buttons that collapse/expand the
 * sidebar and side panel. */
export const PANEL_TOGGLE_CLASSES = cx(
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none transition-colors",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
  "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
);
