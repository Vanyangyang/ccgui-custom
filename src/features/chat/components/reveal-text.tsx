import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { StreamReveal, createVisibleTextReader } from "./stream-reveal";

/** Subscribe to the reveal cursor for one text range. The server-render /
 * remount fallback shows everything: history must never animate in. */
export function useRevealed(controller: StreamReveal, start: number, length: number) {
  const subscribe = useCallback((notify: () => void) => controller.subscribe(start, length, notify), [controller, start, length]);
  const snapshot = useCallback(() => controller.read(start, length), [controller, start, length]);
  return useSyncExternalStore(subscribe, snapshot, () => length);
}

/** Only the text runs crossing the reveal cursor rerender each frame.
 * Markdown parsing, code highlighting and the timeline stay out of this loop.
 */
export const RevealText = memo(function RevealText({ controller, start, children, windowSize }: {
  controller: StreamReveal;
  start: number;
  children: string;
  windowSize?: number;
}) {
  const count = useRevealed(controller, start, children.length);
  const reader = useMemo(() => createVisibleTextReader(children), [children]);
  return <span>{windowSize ? reader.window(count, windowSize) : reader.prefix(count)}</span>;
});
