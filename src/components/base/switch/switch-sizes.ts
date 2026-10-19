import { sortCx } from "@/utils/cx";

/** Per-size class tables for the switch track/thumb/chip (see switch.tsx). */
export const switchSizes = sortCx({
  sm: {
    track: "h-4 w-7",
    trackRadius: { pill: "rounded-full", rectangle: "rounded-[3px]" },
    onShadow: "shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25),inset_0_0_0_0.5px_var(--color-accent-500)]",
    thumb: "size-3",
    thumbRadius: { pill: "rounded-full", rectangle: "rounded-[1px]" },
    offset: "left-0.5 top-0.5",
    travel: "translate-x-3",
    chip: "size-[5px] border-[0.25px] shadow-[0_2px_2px_0_rgb(0_0_0/0.03)]",
    chipRadius: { pill: "rounded-full", rectangle: "rounded-[0.5px]" },
  },
  md: {
    track: "h-6 w-[42px]",
    trackRadius: { pill: "rounded-full", rectangle: "rounded-[4.5px]" },
    onShadow: "shadow-[inset_0_1.5px_0_0_rgb(255_255_255/0.25),inset_0_0_0_0.75px_var(--color-accent-500)]",
    thumb: "size-[18px]",
    thumbRadius: { pill: "rounded-full", rectangle: "rounded-[1.5px]" },
    offset: "left-[3px] top-[3px]",
    travel: "translate-x-[18px]",
    chip: "size-[7.5px] border-[0.375px] shadow-[0_3px_3px_0_rgb(0_0_0/0.03)]",
    chipRadius: { pill: "rounded-full", rectangle: "rounded-[0.75px]" },
  },
  lg: {
    track: "h-8 w-14",
    trackRadius: { pill: "rounded-full", rectangle: "rounded-md" },
    onShadow: "shadow-checkbox-selected",
    thumb: "size-6",
    thumbRadius: { pill: "rounded-full", rectangle: "rounded-xs" },
    offset: "left-1 top-1",
    travel: "translate-x-6",
    chip: "size-[10px] border-[0.5px] shadow-[0_4px_4px_0_rgb(0_0_0/0.03)]",
    chipRadius: { pill: "rounded-full", rectangle: "rounded-[1px]" },
  },
});
