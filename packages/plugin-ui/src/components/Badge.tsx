import type { HTMLAttributes } from "react";
import { cx } from "../cx";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent" | "success" | "error";
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx("pui-badge", `pui-badge-${tone}`, className)} {...rest} />;
}
