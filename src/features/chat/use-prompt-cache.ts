import { useEffect, useState } from "react";
import type { PromptCacheWindow } from "@/lib/ipc";
import { getSessionCacheHeat, nextCacheBoundary } from "./prompt-cache";

export function usePromptCacheHeat(cache: PromptCacheWindow | null | undefined) {
  const [, tick] = useState(0);
  // Read the clock on every render: switching sessions must not reuse the
  // previous session's clock. A timeout also expires a completely idle row.
  const now = Date.now();
  useEffect(() => {
    const refresh = () => tick((n) => n + 1);
    const boundary = nextCacheBoundary(cache, Date.now());
    const timer =
      boundary === undefined
        ? undefined
        : window.setTimeout(
            refresh,
            Math.min(15_000, Math.max(1, boundary - Date.now() + 1)),
          );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [cache, now]);
  return getSessionCacheHeat(cache, now);
}
