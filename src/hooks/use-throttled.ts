import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ThrottledText, nextParseInterval, streamParseInterval } from "./throttled-text";
import { performanceRecorder } from "@/lib/performance-diagnostics";

export { nextParseInterval, streamParseInterval };

/** Parse interval for one live row: cadence from the reply length, backed off
 * by the measured cost of the previous commit. Settled rows pass 0 (no
 * throttle). The measurement spans render + commit, so it includes the
 * markdown parse, highlighting and React's reconciliation. */
export function useLiveParseInterval(live: boolean, length: number): number {
  const commitMs = useRef(0);
  // Timestamp taken in render and captured by this render's layout effect:
  // same render + commit measurement, without mutating a ref during render
  // (React may replay or discard render work).
  const renderStartedAt = performance.now();
  useLayoutEffect(() => {
    commitMs.current = performance.now() - renderStartedAt;
    if (live) performanceRecorder.duration("liveRenderCommit", commitMs.current);
  });
  return live ? nextParseInterval(streamParseInterval(length), commitMs.current) : 0;
}

/** Coalesce streaming appends before expensive Markdown parsing. Completion,
 * replacements and truncation pass through in the current render. Publish
 * idle arrivals before paint, without queuing captured text in React state. */
export function useThrottled(value: string, ms: number): string {
  const [controller] = useState(() => new ThrottledText(value));
  const visible = useSyncExternalStore(controller.subscribe, controller.read, () => value);
  useLayoutEffect(() => { controller.update(value, ms); }, [controller, value, ms]);
  useLayoutEffect(() => () => controller.cancel(), [controller]);
  return controller.bypass(value, ms) ? value : visible;
}
