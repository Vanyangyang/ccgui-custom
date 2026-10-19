import { useId, useState, type KeyboardEvent } from "react";
import { cx } from "@/utils/cx";

export type MessageAnchor = {
  id: string;
  title: string;
  description?: string;
};

type VisibleMessageAnchor = {
  anchor: MessageAnchor;
  originalIndex: number;
  placement: "down" | "center" | "up";
};

type MessageAnchorRailProps = {
  activeAnchorId: string | null;
  anchors: MessageAnchor[];
  navigationLabel: string;
  getFallbackTitle: (index: number) => string;
  onScrollToAnchor: (anchorId: string) => void;
};

/** Beyond this many user messages the rail buckets anchors into a bounded
 * dash count, preferring the active anchor inside its bucket. */
const MAX_VISIBLE_ANCHOR_DASHES = 32;
/** Edge rows flip the preview card so it never clips outside the rail. */
const PREVIEW_EDGE_ROW_COUNT = 6;
/**
 * Horizontal band the rail occupies, as the timeline's left padding class.
 * The rail is absolutely positioned (`left-3` = 12px offset + `w-[52px]` dash
 * width = 64px) so it claims no layout space of its own; the timeline pads its
 * scroll container by that footprint plus an 8px gutter. Without it a narrow
 * window slides the centered message column under the dashes and message text
 * renders over the quick-jump targets. Keep in sync with the `nav` classes below.
 */
export const MESSAGE_ANCHOR_RAIL_BAND_CLASS = "pl-[72px]";

function getVisibleAnchorDashes(
  anchors: MessageAnchor[],
  activeAnchorId: string | null,
): VisibleMessageAnchor[] {
  const activeIndex = activeAnchorId
    ? anchors.findIndex((anchor) => anchor.id === activeAnchorId)
    : -1;
  const visibleAnchorIndexes =
    anchors.length <= MAX_VISIBLE_ANCHOR_DASHES
      ? anchors.map((_, index) => index)
      : Array.from({ length: MAX_VISIBLE_ANCHOR_DASHES }, (_, bucketIndex) => {
          const start = Math.floor(
            (bucketIndex * anchors.length) / MAX_VISIBLE_ANCHOR_DASHES,
          );
          const end = Math.floor(
            ((bucketIndex + 1) * anchors.length) / MAX_VISIBLE_ANCHOR_DASHES,
          );
          const bucketEnd = Math.max(start + 1, end);
          return activeIndex >= start && activeIndex < bucketEnd
            ? activeIndex
            : Math.floor((start + bucketEnd - 1) / 2);
        });

  return visibleAnchorIndexes.map((originalIndex, visibleIndex) => {
    const hasMiddleRows =
      visibleAnchorIndexes.length > PREVIEW_EDGE_ROW_COUNT * 2;
    return {
      anchor: anchors[originalIndex],
      originalIndex,
      placement:
        visibleIndex < PREVIEW_EDGE_ROW_COUNT
          ? "down"
          : hasMiddleRows &&
              visibleIndex >= visibleAnchorIndexes.length - PREVIEW_EDGE_ROW_COUNT
            ? "up"
            : "center",
    };
  });
}

/** Dash bar width by preview proximity: the hovered dash and its neighbors
 * grow in a small gradient so the rail reads as one interactive stack. */
const PROXIMITY_WIDTHS = ["w-8", "w-[26px]", "w-[22px]", "w-[18px]"] as const;

/**
 * Left-side message anchor rail (ported from the reference client's
 * MessagesAnchorRail): one dash per user message, active dash follows
 * scroll, click jumps, hover/focus reveals a bounded preview card. The rail
 * never expands into a full conversation outline.
 */
export function MessageAnchorRail({
  activeAnchorId,
  anchors,
  navigationLabel,
  getFallbackTitle,
  onScrollToAnchor,
}: MessageAnchorRailProps) {
  const previewId = useId();
  const [previewAnchorId, setPreviewAnchorId] = useState<string | null>(null);

  if (anchors.length === 0) {
    return null;
  }

  const visibleAnchors = getVisibleAnchorDashes(anchors, activeAnchorId);
  const previewAnchorIndex = previewAnchorId
    ? visibleAnchors.findIndex(({ anchor }) => anchor.id === previewAnchorId)
    : -1;

  const handleJump = (anchorId: string) => {
    setPreviewAnchorId(null);
    onScrollToAnchor(anchorId);
  };

  const handleDashKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    anchorId: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleJump(anchorId);
  };

  return (
    <nav
      aria-label={navigationLabel}
      onMouseLeave={() => setPreviewAnchorId(null)}
      className="pointer-events-none absolute top-[66px] bottom-4 left-3 z-10 flex w-[52px] flex-col items-start gap-0.5"
    >
      {visibleAnchors.map(({ anchor, originalIndex, placement }, visibleIndex) => {
        const isActive = activeAnchorId === anchor.id;
        const isPreviewVisible = previewAnchorId === anchor.id;
        const previewDistance =
          previewAnchorIndex < 0
            ? -1
            : Math.abs(visibleIndex - previewAnchorIndex);
        const label = anchor.title.trim() || getFallbackTitle(originalIndex);
        return (
          <div key={anchor.id} className="pointer-events-auto relative h-2 w-[52px] shrink-0">
            <button
              type="button"
              onMouseEnter={() => setPreviewAnchorId(anchor.id)}
              onFocus={() => setPreviewAnchorId(anchor.id)}
              onBlur={() => setPreviewAnchorId(null)}
              onClick={() => handleJump(anchor.id)}
              onKeyDown={(event) => handleDashKeyDown(event, anchor.id)}
              aria-current={isActive ? "location" : undefined}
              aria-describedby={isPreviewVisible ? previewId : undefined}
              aria-label={label}
              title={label}
              data-anchor-id={anchor.id}
              className="relative block h-2 w-[52px] cursor-pointer appearance-none rounded border-0 bg-transparent p-0 outline-none focus-visible:shadow-[0_0_0_1px_var(--color-accent-500)]"
            >
              <span
                aria-hidden
                className={cx(
                  "absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none",
                  previewDistance >= 0 && previewDistance <= 3
                    ? PROXIMITY_WIDTHS[previewDistance]
                    : "w-[13px]",
                  isActive
                    ? "bg-text-primary"
                    : previewDistance === 0
                      ? "bg-text-secondary"
                      : "bg-separator-border-strong",
                )}
              />
            </button>
            {isPreviewVisible ? (
              <div
                id={previewId}
                role="tooltip"
                className={cx(
                  "absolute left-9 z-10 grid w-[clamp(240px,42vw,420px)] gap-1.5 rounded-[10px] border border-separator-border bg-background-primary-default px-3 py-2.5 shadow-[0_8px_22px_rgba(0,0,0,0.16)]",
                  placement === "down" && "top-[-2px]",
                  placement === "up" && "bottom-[-2px]",
                  placement === "center" && "top-1/2 -translate-y-1/2",
                )}
              >
                <strong className="line-clamp-2 text-body-medium [overflow-wrap:anywhere] text-text-primary">
                  {originalIndex + 1}. {label}
                </strong>
                {anchor.description ? (
                  <span className="line-clamp-3 text-caption-1-regular [overflow-wrap:anywhere] text-text-secondary">
                    {anchor.description}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
