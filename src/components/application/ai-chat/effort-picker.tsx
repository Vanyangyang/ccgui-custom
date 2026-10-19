import { useTranslation } from "react-i18next";
import { cx } from "@/utils/cx";
import { EFFORT_LABEL_KEYS, type EffortLevel } from "./effort-levels";

/** Discrete choices with a single tab stop and arrow-key radio navigation. */
export function EffortPicker({ levels, value, onChange }: {
  levels: readonly EffortLevel[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const tabLevel = levels.includes(value) ? value : levels[0];
  return <div
    role="radiogroup"
    aria-label={t("chat.effort")}
    className="flex w-full flex-wrap gap-1 rounded-lg bg-background-secondary-default p-1"
    onKeyDown={(event) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(event.key) || levels.length === 0) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const current = buttons.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? levels.length - 1
        : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + levels.length) % levels.length;
      buttons[next].focus();
      onChange(levels[next]);
    }}
  >
    {levels.map((level) => <button
      key={level} type="button" role="radio" aria-checked={value === level}
      data-effort={level} tabIndex={tabLevel === level ? 0 : -1}
      title={level} onClick={() => onChange(level)}
      className={cx(
        "min-h-8 min-w-max flex-1 cursor-pointer rounded-md px-1.5 text-body-2-medium whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        value === level ? "bg-background-primary-default text-text-primary shadow-xs ring-1 ring-border-button-default"
          : "text-text-secondary hover:bg-background-primary-hover hover:text-text-primary",
      )}
    >{t(EFFORT_LABEL_KEYS[level])}</button>)}
  </div>;
}
