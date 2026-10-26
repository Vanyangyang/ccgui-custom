import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type AgyQuotaSnapshot } from "@/lib/ipc";
import { listenAgyQuotaChanged } from "@/lib/events";
import { CLI_CONFIG_CHANGED_EVENT } from "@/features/settings/providers";
import { QUOTA_STALE_AGE, isNativeSubscriptionProvider, quotaReadFailed } from "../subscription-quota";
import { validAgyQuotaSnapshot } from "../agy-quota";

const EMPTY: AgyQuotaSnapshot = { status: "unavailable", groups: [], errorCode: "not_loaded" };
const READ_TIMEOUT_MS = 40_000;

export function useAgyQuota(engine: string, providerId: string | undefined, workspacePath?: string) {
  const enabled = engine === "agy" && isNativeSubscriptionProvider(providerId) && !/^(wsl:|ssh:|\\\\wsl)/i.test(workspacePath ?? "");
  const route = JSON.stringify([engine, providerId, workspacePath]);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const request = useRef<{ route: string; refresh: () => Promise<void> }>();
  const [state, setState] = useState({ route, snapshot: EMPTY, loading: false });
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    let disposed = false, subscribed = false;
    let generation = 0;
    let pending: Promise<void> | undefined;
    let pendingCacheOnly = true;
    let pendingManual = false;
    let queued: "cache" | "active" | "manual" | undefined;
    let unlisten: (() => void) | undefined;
    let configTimer: number | undefined;
    let readTimer: number | undefined;
    const current = () => !disposed && currentRoute.current === route;
    const visible = () => document.visibilityState !== "hidden";
    setState({ route, snapshot: EMPTY, loading: false });
    if (!enabled) { request.current = undefined; return; }
    // Only an explicit click may start a CLI probe. Lifecycle events read cache.
    const read = (cacheOnly = true, manual = false): Promise<void> => {
      if (!current() || !subscribed || (!cacheOnly && !visible())) return Promise.resolve();
      if (pending) {
        // Native change events during a query require one subsequent cache read.
        // A click during an automatic query still needs its own manual read.
        if (manual && !pendingManual) queued = "manual";
        else if (cacheOnly && !queued) queued = "cache";
        else if (!cacheOnly && pendingCacheOnly && queued !== "manual") queued = "active";
        return pending;
      }
      const startedGeneration = generation;
      pendingCacheOnly = cacheOnly;
      pendingManual = manual;
      if (manual) setState(previous => ({ ...previous, loading: true }));
      pending = (async () => {
        try {
          const result = await Promise.race([
            ipc.agyQuotaRead({ cacheOnly, force: manual, providerId, workspacePath }),
            new Promise<never>((_, reject) => {
              readTimer = window.setTimeout(() => reject(new Error("AGY quota read timed out")), READ_TIMEOUT_MS);
            }),
          ]);
          const snapshot = result.errorCode === "not_loaded" || result.errorCode === "quota_expired"
            ? { ...result, errorCode: "probe_requires_manual" } : result;
          if (current() && generation === startedGeneration) {
            setNow(Date.now() / 1000);
            setState({ route, snapshot, loading: false });
          }
        } catch {
          if (current() && generation === startedGeneration) setState(previous => ({ route, snapshot: quotaReadFailed(previous.snapshot, EMPTY), loading: false }));
        } finally {
          window.clearTimeout(readTimer);
          pending = undefined;
          if (current()) {
            setState(previous => ({ ...previous, loading: false }));
            const next = queued; queued = undefined;
            if (next === "manual") await read(false, true);
            else if (next === "active") await read(true);
            else if (next === "cache") await read(true);
          }
        }
      })();
      return pending;
    };
    request.current = { route, refresh: () => read(false, true) };
    const cacheChanged = () => { if (current()) { setNow(Date.now() / 1000); void read(true); } };
    const refreshVisible = () => { if (visible()) { setNow(Date.now() / 1000); void read(true); } };
    const configChanged = () => {
      generation++;
      setState({ route, snapshot: EMPTY, loading: false });
      window.clearTimeout(configTimer);
      configTimer = window.setTimeout(() => {
        if (pending && visible()) { if (queued !== "manual") queued = "active"; }
        else refreshVisible();
      }, 250);
    };
    void listenAgyQuotaChanged(cacheChanged).then(stop => {
      if (!current()) { stop(); return; }
      unlisten = stop; subscribed = true; cacheChanged();
    }).catch(() => { if (current()) { subscribed = true; cacheChanged(); } });
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, configChanged);
    return () => {
      disposed = true; unlisten?.();
      window.clearTimeout(configTimer); window.clearTimeout(readTimer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, configChanged);
      if (request.current?.route === route) request.current = undefined;
    };
  }, [route, enabled, providerId, workspacePath]);

  const snapshot = enabled && state.route === route ? validAgyQuotaSnapshot(state.snapshot, now) : undefined;
  const deadlines = snapshot?.collectedAt && Number.isFinite(snapshot.collectedAt) && snapshot.collectedAt <= now
    ? [snapshot.collectedAt + QUOTA_STALE_AGE,
      ...snapshot.groups.flatMap(group => Object.values(group.windows).map(window => window?.resetsAt ?? 0))].filter(time => time > now) : [];
  const nextDeadline = deadlines.length ? Math.min(...deadlines) : undefined;
  useEffect(() => {
    if (nextDeadline === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now() / 1000), Math.max(1, nextDeadline * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextDeadline]);
  const refresh = useCallback(async () => { if (request.current?.route === currentRoute.current) await request.current.refresh(); }, []);
  return { enabled, snapshot, now, loading: enabled && state.route === route && state.loading, refresh };
}

