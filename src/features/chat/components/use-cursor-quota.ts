import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type CursorQuotaSnapshot } from "@/lib/ipc";
import { quotaReadFailed } from "../subscription-quota";

const EMPTY: CursorQuotaSnapshot = { status: "unavailable", errorCode: "not_loaded" };

/** Cursor 会话可见时读取账号用量。后端自己做短缓存，这里只在前台每分钟问一次。 */
export function useCursorQuota(engine: string) {
  const enabled = engine === "cursor";
  const route = useRef(engine);
  route.current = engine;
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const [state, setState] = useState({ engine, snapshot: EMPTY, loading: false });
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | undefined;
    setState({ engine, snapshot: EMPTY, loading: false });
    if (!enabled) return;
    const current = () => !disposed && route.current === engine;
    const visible = () => document.visibilityState !== "hidden";
    const read = (force: boolean): Promise<void> => {
      if (!current() || (!force && !visible())) return Promise.resolve();
      if (pending) return pending;
      setState(previous => ({ ...previous, loading: true }));
      pending = (async () => {
        try {
          const snapshot = await ipc.cursorQuotaRead({ force });
          if (current()) {
            setNow(Date.now() / 1000);
            setState({ engine, snapshot, loading: false });
          }
        } catch {
          if (current()) setState(previous => ({ engine, snapshot: quotaReadFailed(previous.snapshot, EMPTY), loading: false }));
        } finally {
          pending = undefined;
          if (current()) setState(previous => ({ ...previous, loading: false }));
        }
      })();
      return pending;
    };
    refreshRef.current = () => read(true);
    const refreshVisible = () => { setNow(Date.now() / 1000); void read(false); };
    void read(false);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = window.setInterval(refreshVisible, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [engine, enabled]);

  const refresh = useCallback(async () => { await refreshRef.current(); }, []);
  return {
    enabled,
    snapshot: enabled && state.engine === engine ? state.snapshot : undefined,
    now,
    loading: enabled && state.engine === engine && state.loading,
    refresh,
  };
}
