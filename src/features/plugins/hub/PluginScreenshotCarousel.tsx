import { useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ImageOff from "lucide-react/dist/esm/icons/image-off";
import X from "lucide-react/dist/esm/icons/x";
import { ModalShell } from "@/components/dialogs";
import { cx } from "@/utils/cx";

const NAV_BUTTON =
  "absolute top-1/2 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background-primary-default/90 text-foreground-icon-primary shadow-md transition-colors hover:bg-background-primary-hover";

/** Lightbox dismiss. Pinned to the viewport corner instead of the image corner:
 *  the picture's aspect ratio changes per screenshot, and an image-anchored X
 *  either covers content (the top-right corner of these shots carries badges)
 *  or drifts off-screen with a very wide image. Backdrop press and Escape also
 *  close, so this is the visible affordance, not the only one. */
const ZOOM_CLOSE =
  "fixed top-5 right-5 flex size-9 cursor-pointer items-center justify-center rounded-full bg-background-primary-default/90 text-foreground-icon-primary shadow-md transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:outline-none motion-reduce:transition-none";

/**
 * Screenshot gallery for a market detail page: one 16:9-ish stage, arrow /
 * dot navigation, and a click-to-zoom lightbox. Remote images may 404 (an
 * index row can outlive its assets), so a failed slot renders a placeholder
 * instead of a broken-image glyph. Arrow keys work while any control inside
 * the gallery has focus — keydown bubbles up to the section.
 */
export function PluginScreenshotCarousel({
  images,
  name,
}: {
  images: string[];
  name: string;
}) {
  const { t } = useTranslation();
  const [rawIndex, setRawIndex] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
  const [zoomed, setZoomed] = useState(false);
  const total = images.length;
  // Clamp instead of storing an effect: the index survives live entries
  // changes (market refresh) without a render fighting the store.
  const index = total > 0 ? Math.min(rawIndex, total - 1) : 0;

  if (total === 0) return null;

  const step = (delta: number) =>
    setRawIndex((current) => (current + delta + total) % total);
  const failedHere = failed.has(index);
  const alt = t("plugins.hub.screenshotAlt", { name, n: index + 1 });

  return (
    <section
      aria-label={t("plugins.hub.screenshotsTitle")}
      className="flex flex-col gap-2"
      onKeyDown={(event) => {
        if (total < 2) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1);
        }
      }}
    >
      <div className="relative overflow-hidden rounded-2xl border border-separator-border bg-background-secondary-default">
        <button
          type="button"
          disabled={failedHere}
          aria-label={t("plugins.hub.screenshotZoom")}
          onClick={() => setZoomed(true)}
          className="block w-full cursor-zoom-in disabled:cursor-default"
        >
          <div className="flex h-[320px] w-full items-center justify-center">
            {failedHere ? (
              <span className="flex flex-col items-center gap-2 text-body-2-regular text-text-tertiary">
                <ImageOff className="size-6" aria-hidden />
                {t("plugins.hub.screenshotFailed")}
              </span>
            ) : (
              <img
                src={images[index]}
                alt={alt}
                className="size-full object-contain"
                onError={() =>
                  setFailed((previous) => new Set(previous).add(index))
                }
              />
            )}
          </div>
        </button>
        {total > 1 && (
          <>
            <button
              type="button"
              aria-label={t("plugins.hub.screenshotPrev")}
              onClick={() => step(-1)}
              className={cx(NAV_BUTTON, "left-3")}
            >
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t("plugins.hub.screenshotNext")}
              onClick={() => step(1)}
              className={cx(NAV_BUTTON, "right-3")}
            >
              <ChevronRight className="size-5" aria-hidden />
            </button>
          </>
        )}
      </div>

      {total > 1 && (
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-1.5">
            {images.map((image, dotIndex) => (
              <button
                key={image}
                type="button"
                aria-label={t("plugins.hub.screenshotDot", { n: dotIndex + 1 })}
                aria-current={dotIndex === index}
                onClick={() => setRawIndex(dotIndex)}
                className={cx(
                  "h-1.5 cursor-pointer rounded-full transition-all",
                  dotIndex === index
                    ? "w-5 bg-accent-500"
                    : "w-1.5 bg-foreground-icon-secondary/40 hover:bg-foreground-icon-secondary",
                )}
              />
            ))}
          </div>
          <span className="text-caption-1-regular text-text-tertiary">
            {t("plugins.hub.screenshotCounter", { current: index + 1, total })}
          </span>
        </div>
      )}

      {zoomed && (
        <ModalShell
          onClose={() => setZoomed(false)}
          label={alt}
          className="w-auto max-w-[92vw] border-0 bg-transparent p-0 shadow-none"
          dialogClassName="flex items-center justify-center"
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label={t("plugins.hub.screenshotClose")}
            title={t("plugins.hub.screenshotClose")}
            className={ZOOM_CLOSE}
          >
            <X className="size-5" aria-hidden />
          </button>
          <img
            src={images[index]}
            alt={alt}
            className="max-h-[86vh] max-w-[92vw] rounded-xl object-contain"
          />
        </ModalShell>
      )}
    </section>
  );
}
