import type { ReactNode } from "react";
import { cx } from "@/utils/cx";

/** Keyboard key cap — one modifier/key segment of a shortcut (⌘, ⇧, K…). */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-separator-border bg-background-tertiary-default px-1 font-sans text-[11px] leading-none text-text-secondary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
