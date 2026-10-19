import type { ReactNode } from "react";
import { cx } from "@/utils/cx";

/**
 * Rounded neutral chip used for filters and metadata (Skills 引擎筛选、MCP
 * 引擎/范围筛选共用）。`onClick` 存在时是按钮（带 `aria-pressed`），否则是
 * 纯展示的 `<span>`——不把不可点的状态画成可点。
 */
export function Chip({
  selected,
  children,
  onClick,
  title,
}: {
  selected?: boolean;
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const classes = cx(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption-1-regular transition-colors",
    onClick &&
      "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
    selected
      ? "bg-background-tertiary-default text-text-primary"
      : "bg-background-secondary-default text-text-secondary hover:bg-background-tertiary-default",
  );
  if (!onClick) {
    return (
      <span className={classes} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={Boolean(selected)}
      className={classes}
    >
      {children}
    </button>
  );
}
