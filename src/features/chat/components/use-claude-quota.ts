import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type ClaudeQuotaSnapshot } from "@/lib/ipc";
import { listenClaudeQuotaChanged } from "@/lib/events";
import { CLAUDE_QUOTA_MAX_AGE, CLAUDE_QUOTA_STALE_AGE, isClaudeNativeProvider, validClaudeQuotaSnapshot } from "../claude-quota";

const EMPTY: ClaudeQuotaSnapshot = { status: "unavailable", windows: {}, errorCode: "not_loaded" };

function hasQuotaWindows(snapshot: ClaudeQuotaSnapshot): boolean {
  return Object.values(snapshot.windows).some(window => window !== undefined && Number.isFinite(window.usedPercentage));
}

// 【对话额度】空结果和过期结果不盖掉已显示的窗口。账号、渠道或令牌变化后缓存会变成 not_loaded，必须立刻换成新结果。
function keepUntilNextQuota(previous: ClaudeQuotaSnapshot, next: ClaudeQuotaSnapshot): ClaudeQuotaSnapshot {
  if (next.errorCode && /auth|provider|custom_channel|^not_loaded$/.test(next.errorCode)) return next;
  if (hasQuotaWindows(next)) return next;
  if (hasQuotaWindows(previous)) return previous;
  return next;
}

export function useClaudeQuota(engine: string, providerId: string | undefined, workspacePath?: string) {
  const enabled = engine === "claude" && isClaudeNativeProvider(providerId) && !/^(wsl:|ssh:|\\\\wsl)/i.test(workspacePath ?? "");
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
    let unlisten: (() => void) | undefined;
    const current = () => !disposed && currentRoute.current === route;
    setState(previous => (
      previous.route === route && hasQuotaWindows(previous.snapshot)
        ? { ...previous, loading: false }
        : { route, snapshot: EMPTY, loading: false }
    ));
    if (!enabled) { request.current = undefined; return; }

    const read = async (cacheOnly = true): Promise<void> => {
      if (!current() || !subscribed) return;
      if (inFlight) { if (cacheOnly) queued = true; return; }
      inFlight = true;
      setState(previous => ({ ...previous, loading: true }));
      try {
        const snapshot = await ipc.claudeQuotaRead({ cacheOnly, force: !cacheOnly, providerId, workspacePath });
        if (current()) {
          setNow(Date.now() / 1000);
          setState(previous => ({ route, snapshot: keepUntilNextQuota(previous.snapshot, snapshot), loading: true }));
        }
      } catch {
        // A transport failure cannot confirm that the account still matches.
        // Native validated stale replies may retain values; an IPC rejection may not.
        // 【对话额度】读取失败时留下上次窗口，等下一次成功的额度再替换。
        if (current()) setState(previous => ({
          route,
          snapshot: hasQuotaWindows(previous.snapshot) ? previous.snapshot : { ...EMPTY, errorCode: "read_failed" },
          loading: true,
        }));
      } finally {
        inFlight = false;
        if (current()) {
          setState(previous => ({ ...previous, loading: false }));
          // Invalidation during a query needs a subsequent read of the newest cache.
          if (queued) { queued = false; await read(); }
        }
      }
    };
    // 【对话额度】手动刷新也只重读缓存。额度来自正常对话里的 CLI 事件，不另起进程。
    request.current = { route, refresh: () => read(true) };
    const refreshCache = () => { if (current()) { setNow(Date.now() / 1000); void read(); } };
    // Subscribe before reading to avoid missing an update during mount.
    void listenClaudeQuotaChanged(refreshCache).then(stop => {
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
      window.removeEventListener("focus", refreshCache);
      window.clearInterval(timer);
      if (request.current?.route === route) request.current = undefined;
    };
  }, [route, engine, providerId, workspacePath, enabled]);

  const snapshot = enabled && state.route === route ? validClaudeQuotaSnapshot(state.snapshot, now) : undefined;
  // Expire reset windows and freshness exactly between minute cache reads.
  const deadlines = snapshot?.collectedAt && Number.isFinite(snapshot.collectedAt) && snapshot.collectedAt <= now
    ? [snapshot.collectedAt + CLAUDE_QUOTA_STALE_AGE, snapshot.collectedAt + CLAUDE_QUOTA_MAX_AGE,
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
