import { EngineIcon } from "./engine-icon";
import { inferModelEngine } from "./engine-brands";
import { cx } from "@/utils/cx";

/**
 * Mark for one model: the vendor's brand glyph when we know it, else a
 * monogram chip ("GLM", "Q", "M") derived from the name. Inventing brand art
 * for vendors we have no mark for would be worse than saying nothing — the
 * monogram only names the family, the same way the label beside it does.
 */
export function ModelBadge({
  name,
  size = 14,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const engine = inferModelEngine(name);
  if (engine) {
    return <EngineIcon engine={engine} size={size} className={className} />;
  }
  const token = (name.split(/[-/._\s]/)[0] ?? "").trim();
  const letters = /^[a-z0-9]+$/i.test(token)
    ? token.length <= 3
      ? token.toUpperCase()
      : token[0]!.toUpperCase()
    : name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  if (!letters) return null;
  return (
    <span
      aria-hidden
      className={cx(
        "flex shrink-0 items-center justify-center rounded-[4px] bg-background-tertiary-default font-medium text-text-secondary",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(7, size * 0.52) }}
    >
      {letters}
    </span>
  );
}
