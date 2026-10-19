import { cx } from "@/utils/cx";
import { checkboxSizes } from "./checkbox-sizes";
import type { CheckboxSize } from "./checkbox-sizes";

export interface CheckboxGlyphState {
  isSelected: boolean;
  isIndeterminate: boolean;
  isFocusVisible: boolean;
  isDisabled: boolean;
  isHovered: boolean;
}

/**
 * The 16px (or 14px) checkbox box + tick/indeterminate glyph. Shared by the
 * standalone Checkbox and the CheckboxCard so their visuals stay identical.
 */
export function CheckboxGlyph({
  state,
  size = "md",
}: {
  state: CheckboxGlyphState;
  size?: CheckboxSize;
}) {
  const { isSelected, isIndeterminate, isFocusVisible, isDisabled, isHovered } = state;
  const s = checkboxSizes[size];
  const isMarked = isSelected || isIndeterminate;
  const hover = isHovered && !isDisabled;

  return (
    <span
      aria-hidden
      className={cx(
        "flex shrink-0 items-center justify-center rounded-sm",
        "transition-[background-color,border-color,box-shadow] duration-150 ease",
        s.box,
        isMarked
          ? cx(
              "bg-linear-to-b shadow-checkbox-selected",
              hover ? "from-accent-400 to-accent-500" : "from-accent-500 to-accent-600",
            )
          : cx(
              "border bg-background-primary-default shadow-xs",
              hover ? "border-border-checkbox-hover" : "border-border-checkbox-default",
            ),
        isDisabled && "opacity-50",
        isFocusVisible && "ring-2 ring-border-focus-ring ring-offset-2",
      )}
    >
      <svg viewBox="0 0 16 16" fill="none" className={s.glyph}>
        {isIndeterminate ? (
          <path d="M4.5 8H8H11.5" stroke="white" strokeWidth="2" strokeLinecap="round" />
        ) : isSelected ? (
          <path
            d="M4 7.7L6.65 10.35C6.84 10.54 7.16 10.54 7.35 10.35L12 5.7"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            className="animate-check-draw"
          />
        ) : null}
      </svg>
    </span>
  );
}
