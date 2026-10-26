import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type CodexQuotaSnapshot } from "@/lib/ipc";
import { listenCodexQuotaChanged, listenTransportConnected } from "@/lib/events";
import { QUOTA_STALE_AGE, isNativeSubscriptionProvider, quotaReadFailed, validSubscriptionQuotaSnapshot } from "../subscription-quota";

const EMPTY: CodexQuotaSnapshot = { status: "unavailable", windows: {}, errorCode: "not_loaded" };

export function useCodexQuota(engine: string, providerId: string | undefined, workspacePath?: string) {
  const enabled = engine === "codex" && isNativeSubscriptionProvider(providerId) && !/^(wsl:|ssh:|\\\\wsl)/i.test(workspacePath ?? "");
  const route = JSON.stringify([engine, providerId, workspacePath]);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const request = useRef<{ route: string; refresh: () => Promise<void> }>();
  const [state, setState] = useState({ route, snapshot: EMPTY, loading: false });
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    let disposed = false;
    let subscribed = false;
    let inFlight = false;
    let queued = false;
    let missingAttempted = false;
    let loadMissing = false;
    let unlisten: (() => void) | undefined;
    let unlistenConnected: (() => void) | undefined;
    const current = () => !disposed && currentRoute.current === route;
    setState({ route, snapshot: EMPTY, loading: false });
    if (!enabled) { request.current = undefined; return; }

    const read = async (cacheOnly = true): Promise<void> => {
      if (!current() || !subscribed) return;
      if (inFlight) { if (cacheOnly) queued = true; return; }
      inFlight = true;
      setState(previous => ({ ...previous, loading: true }));
      try {
        const snapshot = await ipc.codexQuotaRead({ cacheOnly, force: !cacheOnly, providerId, workspacePath });
        // A changed native auth/config binding has a new, explicitly missing
        // cache. Revalidate it once, including after mount; repeated missing
        // replies never loop into account queries. Ready/stale reads remain passive.
        loadMissing = cacheOnly && snapshot.errorCode === "not_loaded" && !missingAttempted;
        if (loadMissing) missingAttempted = true;
        if (snapshot.status === "ready" || snapshot.status === "stale") missingAttempted = false;
        if (current()) {
          setNow(Date.now() / 1000);
          setState({ route, snapshot, loading: true });
        }
      } catch {
        if (current()) setState(previous => ({ route, snapshot: quotaReadFailed(previous.snapshot, EMPTY), loading: true }));
      } finally {
        inFlight = false;
        if (current()) {
          setState(previous => ({ ...previous, loading: false }));
          // Invalidation during a query needs a subsequent read of the newest cache.
          if (loadMissing) { loadMissing = false; queued = false; await read(false); }
          else if (queued) { queued = false; await read(); }
        }
      }
    };
    request.current = { route, refresh: () => read(false) };
    const refreshCache = () => { if (current()) { setNow(Date.now() / 1000); void read(); } };
    void listenTransportConnected(refreshCache).then(stop => {
      if (!current()) { stop(); return; }
      unlistenConnected = stop;
    }).catch(() => {});
    // Subscribe before reading to avoid missing an update during mount.
    void listenCodexQuotaChanged(refreshCache).then(stop => {
      if (!current()) { stop(); return; }
      unlisten = stop;
      subscribed = true;
      refreshCache();
    }).catch(() => {
      if (current()) { subscribed = true; refreshCache(); }
    });
    window.addEventListener("focus", refreshCache);
    const timer = window.setInterval(refreshCache, 60_000);
    return () => {
      disposed = true;
      unlisten?.();
      unlistenConnected?.();
      window.removeEventListener("focus", refreshCache);
      window.clearInterval(timer);
      if (request.current?.route === route) request.current = undefined;
    };
  }, [route, engine, providerId, workspacePath, enabled]);

  const snapshot = enabled && state.route === route ? validSubscriptionQuotaSnapshot(state.snapshot, now) : undefined;
  // Update stale/reset labels exactly between minute cache reads.
  const deadlines = snapshot?.collectedAt && Number.isFinite(snapshot.collectedAt) && snapshot.collectedAt <= now
    ? [snapshot.collectedAt + QUOTA_STALE_AGE,
      ...Object.values(snapshot.windows).map(window => window?.resetsAt ?? 0)].filter(time => time > now)
    : [];
  const nextDeadline = deadlines.length ? Math.min(...deadlines) : undefined;
  useEffect(() => {
    if (nextDeadline === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now() / 1000), Math.max(1, nextDeadline * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextDeadline]);

  const refresh = useCallback(async () => {
    if (request.current?.route === currentRoute.current) await request.current.refresh();
  }, []);
  return { enabled, snapshot, now, loading: enabled && state.route === route && state.loading, refresh };
}
