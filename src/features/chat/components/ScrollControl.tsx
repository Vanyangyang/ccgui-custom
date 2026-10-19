import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import { IconButton } from "@/components/base/buttons/icon-button";
import type { ScrollEdge } from "./use-scroll-follow";

/** Tail farther out of view than this (px) counts as "away from the bottom". */
const AWAY_THRESHOLD_PX = 100;

/** Wheel idle this long and the control fades back out. */
const HIDE_DELAY_MS = 1500;

/** Floating edge-jump control (ported from the reference client's
 * ScrollControl): wheel up shows the back-to-top arrow, wheel down the
 * back-to-bottom one, and the click glides to that edge. Only the wheel
 * shows it — scroll/resize merely retire it once the tail (or the end of
 * the content) is in view — so the stream's programmatic tail pins cannot
 * flash the control. Hidden on short content, at the tail, and 1.5s after
 * the last wheel. */
export function ScrollControl({
  scrollRef,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Reports the edge the arrow points at; the owner lands the viewport. */
  onJump: (edge: ScrollEdge) => void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [edge, setEdge] = useState<ScrollEdge>("bottom");
  const hideTimerRef = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setVisible(false);
  }, []);

  // Scroll/resize/hide checks never show the control, only retire it.
  const checkPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollHeight <= el.clientHeight || away < AWAY_THRESHOLD_PX) hide();
  }, [scrollRef, hide]);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const away = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el.scrollHeight <= el.clientHeight || away < AWAY_THRESHOLD_PX) {
        hide();
        return;
      }
      // deltaY === 0 (horizontal wheel) keeps the previous direction.
      if (e.deltaY < 0) setEdge("top");
      else if (e.deltaY > 0) setEdge("bottom");
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
      setVisible(true);
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setVisible(false);
      }, HIDE_DELAY_MS);
    },
    [scrollRef, hide],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        checkPosition();
      });
    };
    checkPosition();
    el.addEventListener("wheel", handleWheel, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    };
  }, [checkPosition, handleWheel, scrollRef]);

  if (!visible) return null;

  const label = edge === "top" ? t("chat.backToTop") : t("chat.backToBottom");
  return (
    <IconButton
      icon={edge === "top" ? ArrowUp : ArrowDown}
      size="small"
      aria-label={label}
      title={label}
      onClick={() => {
        hide();
        onJump(edge);
      }}
      className="absolute right-4 bottom-4 z-10 shadow-dropdown"
    />
  );
}
