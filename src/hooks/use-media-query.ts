import { useEffect, useState } from "react";

/** Below Tailwind's md breakpoint the layout switches to mobile patterns
 *  (overlay sidebar drawer, modal drill-downs instead of hover flyouts). */
export const MOBILE_MEDIA = "(max-width: 767px)";

/** Live matchMedia binding: initializes from the current value and tracks
 *  changes so responsive behavior flips without a reload. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
