export type CheckboxSize = "sm" | "md";

export const checkboxSizes: Record<
  CheckboxSize,
  { box: string; glyph: string; label: string; gap: string }
> = {
  md: { box: "size-4", glyph: "size-4", label: "text-body-medium", gap: "gap-2" },
  sm: { box: "size-3.5", glyph: "size-3.5", label: "text-body-2-medium", gap: "gap-1.5" },
};
