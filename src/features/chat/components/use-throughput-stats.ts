import { useEffect, useRef, useState } from "react";
import { ipc, type ThroughputStatsScope, type ThroughputStatsSnapshot } from "@/lib/ipc";
import { listenThroughputChanged, listenTransportConnected } from "@/lib/events";
import { parseThroughputStats } from "../throughput-stats";

/** Only observes the host ledger; mounting another window never records a turn. */
export function useThroughputStats(scope?: ThroughputStatsScope) {
  const enabled = scope !== undefined;
  const engine = scope?.engine;
  const sessionId = scope?.sessionId;
  const workspacePath = scope?.workspacePath;
  const route = JSON.stringify([enabled, engine, sessionId, workspacePath]);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const [state, setState] = useState<{route: string; snapshot?: ThroughputStatsSnapshot; loading: boolean; error: boolean}>({route, loading: false, error: false});

  useEffect(() => {
    let disposed = false;
    let subscribed = false;
    let inFlight = false;
    let queued = false;
    let unlisten: (() => void) | undefined;
    let unlistenConnected: (() => void) | undefined;
    const current = () => !disposed && currentRoute.current === route;
    setState({route, loading: enabled, error: false});
    if (!enabled) return;
    const read = async (): Promise<void> => {
      if (!current() || !subscribed) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      setState(previous => ({...previous, loading: true}));
      try {
        const snapshot = parseThroughputStats(await ipc.throughputStatsRead({engine, sessionId, workspacePath}));
        if (!snapshot) throw new Error("Invalid throughput statistics");
        if (current()) setState({route, snapshot, loading: true, error: false});
      } catch {
        // A stale scope must not display another conversation's totals. An
        // unavailable read is not an empty, successfully measured history.
        if (current()) setState(previous => ({route, snapshot: previous.route === route ? previous.snapshot : undefined, loading: true, error: true}));
      } finally {
        inFlight = false;
        if (current()) {
          setState(previous => ({...previous, loading: false}));
          if (queued) { queued = false; await read(); }
        }
      }
    };
    const refresh = () => { void read(); };
    void listenTransportConnected(refresh).then(stop => {
      if (!current()) { stop(); return; }
      unlistenConnected = stop;
    }).catch(() => {});
    void listenThroughputChanged(refresh).then(stop => {
      if (!current()) { stop(); return; }
      unlisten = stop;
      subscribed = true;
      refresh();
    }).catch(() => {
      if (current()) { subscribed = true; refresh(); }
    });
    window.addEventListener("focus", refresh);
    return () => { disposed = true; unlisten?.(); unlistenConnected?.(); window.removeEventListener("focus", refresh); };
  }, [route, enabled, engine, sessionId, workspacePath]);

  return state.route === route && enabled ? state : {route, snapshot: undefined, loading: enabled, error: false};
}
