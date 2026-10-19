import { useLayoutEffect, useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { StreamReveal } from "./stream-reveal";

/** One reveal controller for a live text surface (assistant markdown, living
 * thinking panel). Stored text is always complete; this only paces what is
 * shown. Settling, a hidden document and reduced motion publish the exact
 * text instead of animating, so completion never leaves text half revealed. */
export function useLiveReveal(text: string | { text: string }, live: boolean): StreamReveal {
  const controller = useMemo(() => new StreamReveal(false), []);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    controller.update(typeof text === "string" ? text : text.text, live && !reducedMotion && !document.hidden);
  }, [controller, text, live, reducedMotion]);
  useLayoutEffect(() => {
    const onVisibility = () => { if (document.hidden) controller.finish(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      // Tear-down must not freeze a half-finished reveal: a cleanup between
      // the last commit and the next one (Fast Refresh re-running effects,
      // StrictMode, remount) would otherwise leave the pending tail hidden
      // until the provider happens to send more text. Publish it instead.
      // (A real unmount has no listeners left, so this is a no-op there.)
      controller.finish();
      controller.cancel();
    };
  }, [controller]);
  return controller;
}
