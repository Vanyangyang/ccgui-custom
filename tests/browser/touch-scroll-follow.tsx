// Open /tests/browser/touch-scroll-follow.html in a touch-emulated viewport.
// Harness for the timeline's tail-follow hooks: the DOM shape matches
// MessageTimeline (a scroll container + [data-virtual-inner] whose height
// grows), and the hooks under test are the real ones. The failure this
// guards: on touch there is no wheel event and no scrollbar press, so the
// intent model never marked the user as "not at bottom" and every content
// growth yanked the viewport back to the tail.
import { createElement, useCallback, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { useScrollFollow, useTailPin } from "../../src/features/chat/components/use-scroll-follow";

const ROW_H = 72;

function Harness({ children }: { children?: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(40);
  const { atBottomRef, userPausedRef, isFollowing, scrollToBottom } = useScrollFollow({ scrollRef });

  // The timeline's own pin driver: a growing list re-measures, which is what
  // used to re-follow the tail behind the reader's back.
  useTailPin({
    scrollRef,
    count: rows,
    items: [],
    streaming: false,
    isFollowing,
    scrollToBottom,
  });

  const grow = useCallback(() => setRows((n) => n + 8), []);

  // Live probe: the refs are not reactive, so read them directly instead of
  // through a rendered readout.
  (window as unknown as { __live: () => unknown }).__live = () => ({
    atBottom: atBottomRef.current,
    paused: userPausedRef.current,
    following: isFollowing(),
    top: Math.round(scrollRef.current?.scrollTop ?? -1),
    distFromBottom: Math.round(
      (scrollRef.current?.scrollHeight ?? 0) -
        (scrollRef.current?.scrollTop ?? 0) -
        (scrollRef.current?.clientHeight ?? 0),
    ),
  });

  return createElement(
    "div",
    { className: "relative flex h-[844px] w-[390px] flex-col" },
    createElement(
      "div",
      { className: "flex-1 overflow-y-auto", ref: scrollRef, "data-scroller": "" },
      createElement("div", {
        "data-virtual-inner": "",
        style: { height: rows * ROW_H, position: "relative" },
        children: Array.from({ length: rows }, (_, i) =>
          createElement(
            "div",
            {
              key: i,
              "data-row": "",
              style: { position: "absolute", top: i * ROW_H, left: 0, right: 0, height: ROW_H },
              className: "border-b border-separator-border px-4 py-3 text-body-medium",
            },
            `row ${i}`,
          ),
        ),
      }),
    ),
    createElement(
      "div",
      { className: "flex gap-2 p-2" },
      createElement("button", { onClick: grow, "data-grow": "" }, "grow"),
      createElement(
        "button",
        {
          onClick: scrollToBottom,
          "data-jump": "",
        },
        "jump",
      ),
      createElement(
        "output",
        { "data-state": "" },
        JSON.stringify({ atBottom: atBottomRef.current, paused: userPausedRef.current }),
      ),
    ),
  );
}

createRoot(document.getElementById("fixture")!).render(createElement(Harness));
