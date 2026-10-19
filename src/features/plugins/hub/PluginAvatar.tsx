import { useState } from "react";
import { cx } from "@/utils/cx";
import { pluginAvatarGradient, pluginInitial } from "./catalog";

/**
 * Market identity tile. The artwork is optional — an index entry without an
 * `icon` gets the same deterministic gradient tile with its initial (see
 * catalog.ts) on every machine. `src` also carries the developer's GitHub
 * avatar for the small author chip: it fills the tile, and the gradient
 * initial shows while it loads or when it fails (offline, renamed account).
 * Purely decorative: `aria-hidden`, the row text carries the identity.
 */
export function PluginAvatar({
  id,
  name,
  src = null,
  size = 40,
  shape = "tile",
  className,
}: {
  id: string;
  name: string;
  /** Real GitHub avatar URL; when it errors the initial takes over again. */
  src?: string | null;
  size?: number;
  /** `circle` is the small author chip in market rows; entries use the tile. */
  shape?: "tile" | "circle";
  className?: string;
}) {
  const { from, to } = pluginAvatarGradient(id);
  // Tracked per URL instead of a flag: recycled row positions swap authors
  // without remounting, and a new login must get a fresh attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <div
      aria-hidden
      className={cx(
        "flex shrink-0 select-none items-center justify-center font-medium text-white shadow-xs",
        shape === "circle" ? "rounded-full" : "rounded-xl",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(12, Math.round(size * 0.42)),
        backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      {src !== null && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className={cx(
            "size-full object-cover",
            shape === "circle" ? "rounded-full" : "rounded-xl",
          )}
        />
      ) : (
        pluginInitial(name)
      )}
    </div>
  );
}
