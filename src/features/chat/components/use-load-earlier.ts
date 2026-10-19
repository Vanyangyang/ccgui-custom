import { useEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { rowKey, type TimelineRow } from "./timeline-rows";

/** Top sentinel: load earlier pages, preserving the first visible item. */
export function useLoadEarlier({
  scrollRef,
  virtualizer,
  rows,
  itemCount,
  nextBefore,
  onLoadEarlier,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  rows: TimelineRow[];
  itemCount: number;
  nextBefore: number | null;
  onLoadEarlier: () => void;
}) {
  // Refs hold the latest rows/handler so the observer effect does not need
  // to re-subscribe per flush. The writes run in an effect declared
  // before the observer effect below, so every commit refreshes the refs
  // before any observer/rAF callback can read them.
  const loadingRef = useRef(false);
  const itemsRef = useRef(rows);
  const onLoadEarlierRef = useRef(onLoadEarlier);
  const frameRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    itemsRef.current = rows;
    onLoadEarlierRef.current = onLoadEarlier;
  });
  // Unmount-only: cancel a pending anchor-restore frame. Not cancelled in
  // the observer effect below — that effect re-subscribes when a load
  // lands (nextBefore/itemCount change), and cancelling there would leave
  // loadingRef stuck on.
  useEffect(() => {
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sentinel = el.querySelector<HTMLDivElement>("[data-sentinel]");
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || loadingRef.current || !nextBefore) return;
        loadingRef.current = true;
        const firstVisible = virtualizer.getVirtualItems()[1]?.index ?? 0;
        const anchorSeq =
          firstVisible < itemsRef.current.length
            ? rowKey(itemsRef.current[firstVisible])
            : undefined;
        onLoadEarlierRef.current();
        // Restore anchor after prepend: find the same seq in the new list.
        frameRef.current = requestAnimationFrame(() => {
          // Read the freshest rows via the ref; the store update lands
          // before this frame.
          const idx = anchorSeq
            ? itemsRef.current.findIndex((r) => rowKey(r) === anchorSeq)
            : -1;
          if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "start" });
          loadingRef.current = false;
          frameRef.current = undefined;
        });
      },
      { root: el, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [nextBefore, itemCount, virtualizer, scrollRef]);
}
