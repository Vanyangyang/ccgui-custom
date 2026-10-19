import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { MessageAnchor } from "./MessageAnchorRail";

type AnchorWithRow = MessageAnchor & { rowIndex: number };

/** Active anchor dash follows scroll (ported from the reference client,
 * adapted to the virtualizer: row offsets replace DOM queries). Jumping to a
 * dash pauses tail-follow unless the target IS the tail. */
export function useAnchorRailScroll({
  scrollRef,
  anchors,
  virtualizer,
  rowCount,
  atBottomRef,
  userPausedRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  anchors: AnchorWithRow[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  rowCount: number;
  atBottomRef: MutableRefObject<boolean>;
  userPausedRef: MutableRefObject<boolean>;
}) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const anchorsRef = useRef(anchors);
  useEffect(() => {
    anchorsRef.current = anchors;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || anchors.length === 0) {
      setActiveAnchorId(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const list = anchorsRef.current;
      if (list.length === 0) return;
      // Pinned to the tail → the latest anchor is always active (reference W1
      // rule); streaming growth must not churn the active dash per frame.
      if (atBottomRef.current && !userPausedRef.current) {
        const latest = list[list.length - 1].id;
        setActiveAnchorId((prev) => (prev === latest ? prev : latest));
        return;
      }
      const anchorY = el.scrollTop + Math.min(96, el.clientHeight * 0.32);
      let rowIndex = 0;
      for (const item of virtualizer.getVirtualItems()) {
        if (item.start <= anchorY) rowIndex = item.index;
        else break;
      }
      let next = list[0].id;
      for (const anchor of list) {
        if (anchor.rowIndex <= rowIndex) next = anchor.id;
        else break;
      }
      setActiveAnchorId((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [anchors.length, virtualizer, scrollRef, atBottomRef, userPausedRef]);

  const handleScrollToAnchor = useCallback(
    (anchorId: string) => {
      const anchor = anchorsRef.current.find((a) => a.id === anchorId);
      if (!anchor) return;
      // Jumping is explicit navigation: pause tail-follow unless the target
      // IS the tail, so the pin effect does not fight the jump.
      const isTail = anchor.rowIndex >= rowCount - 1;
      userPausedRef.current = !isTail;
      atBottomRef.current = isTail;
      setActiveAnchorId(anchorId);
      virtualizer.scrollToIndex(anchor.rowIndex, { align: "start" });
    },
    [rowCount, virtualizer, atBottomRef, userPausedRef],
  );

  return { activeAnchorId, handleScrollToAnchor };
}
