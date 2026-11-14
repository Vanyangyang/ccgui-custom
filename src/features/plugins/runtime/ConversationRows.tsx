import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";

export type ConversationRowLayout = { ref: (node: HTMLDivElement | null) => void; style: CSSProperties; "data-index": number };

/** The embedder owns scrolling. Never introduce a competing scroll viewport. */
function scrollParent(node: HTMLElement) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

export function ConversationRows({ keys, pinned, renderRow, footer, label, busy }: {
  keys: string[]; pinned: number[]; renderRow: (index: number, layout?: ConversationRowLayout) => ReactNode;
  footer: ReactNode; label: string; busy: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<HTMLElement | null | undefined>(undefined);
  const [margin, setMargin] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const following = useRef(false);
  const virtual = keys.length >= 80 && scroll !== null;
  const getItemKey = useCallback((index: number) => keys[index], [keys]);
  const retained = useMemo(() => focused === null ? pinned : [...pinned, keys.indexOf(focused)], [keys, pinned, focused]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) =>
    [...new Set([...defaultRangeExtractor(range), ...retained.filter(index => index >= 0 && index < range.count)])].sort((a, b) => a - b), [retained]);
  const rows = useVirtualizer({ count: keys.length, getScrollElement: () => scroll ?? null,
    enabled: virtual, getItemKey, estimateSize: () => 96, overscan: 6, gap: 12,
    initialRect: { width: 0, height: 600 }, scrollMargin: margin, rangeExtractor });
  useEffect(() => {
    // TanStack caches measured heights by key. Release removed sources too,
    // rather than retaining measurements from every previously opened thread.
    const present = new Set(keys);
    for (const key of rows.itemSizeCache.keys()) if (!present.has(String(key))) rows.itemSizeCache.delete(key);
  }, [keys, rows]);

  useLayoutEffect(() => {
    if (root.current) setScroll(scrollParent(root.current));
  });
  useLayoutEffect(() => {
    if (!virtual || !scroll || !root.current || !list.current) return;
    const measureMargin = () => {
      if (!list.current) return;
      const next = list.current.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop;
      setMargin(previous => Math.abs(previous - next) < 0.5 ? previous : next);
    };
    let lastTop = scroll.scrollTop;
    following.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
    const onScroll = () => {
      const nearEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
      if (!nearEnd) following.current = false;
      else if (scroll.scrollTop >= lastTop) following.current = true;
      lastTop = scroll.scrollTop;
      measureMargin();
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) following.current = false; };
    const onResize = () => {
      measureMargin();
      // The embedder's layout effect runs before async Markdown/image sizing.
      // Carry its established tail intent through those later measurements.
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
    };
    const observer = new ResizeObserver(onResize);
    const observeLayout = () => {
      observer.disconnect();
      observer.observe(scroll);
      if (root.current) observer.observe(root.current);
      if (list.current) observer.observe(list.current);
      // Prefixes can move our origin inside a fixed-height viewport. Rebuild
      // this set on sibling replacement so detached history DOM is released.
      for (let node: HTMLElement | null = root.current; node && node !== scroll; node = node.parentElement) {
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling);
      }
    };
    const siblings = new MutationObserver(() => { observeLayout(); onResize(); });
    for (let node: HTMLElement | null = root.current; node && node !== scroll; node = node.parentElement) {
      if (node.parentElement) siblings.observe(node.parentElement, { childList: true });
    }
    observeLayout();
    measureMargin();
    // Update intent before the virtualizer synchronously renders a new range.
    scroll.addEventListener("scroll", onScroll, { passive: true, capture: true });
    scroll.addEventListener("wheel", onWheel, { passive: true });
    return () => { siblings.disconnect(); observer.disconnect(); scroll.removeEventListener("scroll", onScroll, true); scroll.removeEventListener("wheel", onWheel); };
  }, [scroll, virtual]);

  return <div ref={root} className="flex min-w-0 flex-col gap-3" role="log" aria-label={label} aria-busy={busy}
    style={virtual ? { position: "relative", overflowAnchor: "none" } : undefined}
    onFocusCapture={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
      setFocused(row ? keys[Number(row.dataset.index)] : null);
    }} onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
    }}>
    {virtual && <div ref={list} data-conversation-virtual="" aria-hidden="true" style={{ height: rows.getTotalSize(), flexShrink: 0 }} />}
    {/* Keep the same keyed children under the log when crossing the threshold,
        so a pending form does not remount when message 80 arrives. */}
    {virtual ? rows.getVirtualItems().map(row => renderRow(row.index, { ref: rows.measureElement, "data-index": row.index,
      style: { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - margin}px)` } }))
      : keys.map((_, index) => renderRow(index))}
    {footer}
  </div>;
}
