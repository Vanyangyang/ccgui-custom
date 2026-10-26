/**
 * MCP 连接检测结果（内存态，不落盘，模块级单例：设置页与 `/mcp` 面板共用）。
 *
 * 与 `useMcpInventory` 的运行时分区是两回事：运行时是某个 CLI 会话自己上报
 * 的连接状态，这里是**本应用发起**的一次检测。三条策略：
 *
 * - **打开即检测**：面板/页签出现时自动跑一次，但只针对「启用 + 可检测 + 没有
 *   新鲜结果」的条目（`useAutoProbe`），所以重复打开只是复用缓存；
 * - **缓存**：结果按「条目 id + 配置哈希」存放，配置一变旧结果立即失效；新鲜度
 *   窗口 `PROBE_TTL_MS` 内的结果自动检测直接复用，手动点「检测全部」才强制重跑；
 * - **有限并行**：同时最多 `PROBE_CONCURRENCY` 个检测在飞（stdio 启动是 I/O 等待，
 *   串行太慢，全并行又会同时拉起一堆 npx），失败只影响自己那一条。
 */
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { mcpApi } from "./api";
import type { McpConfigEntry, McpProbeState } from "./types";

/** 自动检测复用结果的窗口：超过则视为需要重新检测。 */
export const PROBE_TTL_MS = 3 * 60_000;
/** 同时进行的检测数上限。 */
export const PROBE_CONCURRENCY = 4;

interface McpProbeStore {
  /** 条目 id → 检测结果；`pending` 里的条目正在检测。 */
  results: Record<string, McpProbeState>;
  pending: Record<string, true>;
  /** 「检测全部」是否在跑（含队列）。 */
  runningAll: boolean;
  error: string | null;
  probe: (entry: McpConfigEntry, workspace: string | null) => Promise<void>;
  probeAll: (
    entries: McpConfigEntry[],
    workspace: string | null,
    options?: { force?: boolean },
  ) => Promise<void>;
  clear: () => void;
}

/** 配置版本一致的旧结果才有效。 */
export function probeStateFor(
  results: Record<string, McpProbeState>,
  entry: McpConfigEntry,
): McpProbeState | null {
  const state = results[entry.id];
  if (!state || state.version !== entry.version) return null;
  return state;
}

/** 可以检测的条件：配置里真有命令或地址。 */
export function probeable(entry: McpConfigEntry): boolean {
  return Boolean(entry.command || entry.url);
}

/** 需要（重新）检测吗：停用的、没命令/地址的、还有新鲜结果的都跳过。 */
export function needsProbe(
  entry: McpConfigEntry,
  results: Record<string, McpProbeState>,
  now = Date.now(),
): boolean {
  if (!entry.enabled || !probeable(entry)) return false;
  const state = probeStateFor(results, entry);
  if (!state) return true;
  return now - state.checkedAt > PROBE_TTL_MS;
}

export const useMcpProbeStore = create<McpProbeStore>((set, get) => {
  interface Request {
    promise: Promise<void>;
    run: () => Promise<void>;
  }
  const inflight = new Map<string, Request>();
  const latest = new Map<string, Request>();
  const pendingCounts = new Map<string, number>();
  const queue: Request[] = [];
  let active = 0;
  const drain = () => {
    while (active < PROBE_CONCURRENCY && queue.length) {
      const request = queue.shift()!;
      active++;
      void request.run().finally(() => {
        active--;
        drain();
      });
    }
  };
  return {
    results: {},
    pending: {},
    runningAll: false,
    error: null,

    probe: (entry, workspace) => {
      if (!probeable(entry)) return Promise.resolve();
      const key = JSON.stringify([entry.id, entry.version, workspace]);
      const existing = inflight.get(key);
      if (existing) {
        latest.set(entry.id, existing);
        return existing.promise;
      }
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      const request: Request = {
        promise,
        run: async () => {
          try {
            const result = await mcpApi.probe(entry, workspace);
            // 缺字段的响应不能当成「已连接」写进状态。
            if (!result || typeof result.status !== "string") {
              throw new Error("MCP 检测返回了无法识别的结果");
            }
            if (latest.get(entry.id) === request) {
              set((state) => ({
                results: {
                  ...state.results,
                  [entry.id]: { result, checkedAt: Date.now(), version: entry.version },
                },
              }));
            }
          } catch (probeError) {
            if (latest.get(entry.id) === request) {
              set({ error: probeError instanceof Error ? probeError.message : String(probeError) });
            }
          } finally {
            inflight.delete(key);
            if (latest.get(entry.id) === request) latest.delete(entry.id);
            const remaining = (pendingCounts.get(entry.id) ?? 1) - 1;
            if (remaining) pendingCounts.set(entry.id, remaining);
            else pendingCounts.delete(entry.id);
            if (!remaining) {
              set((state) => {
                const pending = { ...state.pending };
                delete pending[entry.id];
                return { pending };
              });
            }
            resolve();
          }
        },
      };
      // Register queued requests too: a manual check must join a batch item
      // even before a concurrency slot is available for that item.
      inflight.set(key, request);
      latest.set(entry.id, request);
      pendingCounts.set(entry.id, (pendingCounts.get(entry.id) ?? 0) + 1);
      set((state) => ({ pending: { ...state.pending, [entry.id]: true }, error: null }));
      queue.push(request);
      drain();
      return promise;
    },

    probeAll: async (entries, workspace, options) => {
      const force = options?.force ?? false;
      const targets = entries.filter((entry) =>
        force ? entry.enabled && probeable(entry) : needsProbe(entry, get().results),
      );
      if (targets.length === 0 || get().runningAll) return;
      set({ runningAll: true, error: null });
      try {
        await Promise.all(targets.map((entry) => get().probe(entry, workspace)));
      } finally {
        set({ runningAll: false });
      }
    },

    clear: () => set({ results: {}, error: null }),
  };
});

/**
 * 打开（或切到某个引擎）时自动检测：指纹由「启用且可检测条目的 id + 配置
 * 哈希」组成，指纹没变就不再跑（重复打开只吃缓存），变了的条目里只补那些
 * 没有新鲜结果的。
 */
export function useAutoProbe(
  entries: McpConfigEntry[] | undefined,
  workspacePath: string | null,
  enabled = true,
): void {
  const probeAll = useMcpProbeStore((state) => state.probeAll);
  const runningAll = useMcpProbeStore((state) => state.runningAll);
  const fingerprint = useMemo(
    () =>
      (entries ?? [])
        .filter((entry) => entry.enabled && probeable(entry))
        .map((entry) => `${entry.id}@${entry.version}`)
        .join("|"),
    [entries],
  );
  const probed = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || runningAll) return;
    if (probed.current === fingerprint) return;
    probed.current = fingerprint;
    void probeAll(entries ?? [], workspacePath);
  }, [enabled, fingerprint, runningAll, entries, probeAll, workspacePath]);
}

/** 当前可见条目里最新一次检测的时间（用于「状态更新于 …」）。 */
export function latestCheckedAt(
  entries: McpConfigEntry[],
  results: Record<string, McpProbeState>,
): number | null {
  let latest: number | null = null;
  for (const entry of entries) {
    const state = probeStateFor(results, entry);
    if (!state) continue;
    latest = latest === null ? state.checkedAt : Math.max(latest, state.checkedAt);
  }
  return latest;
}
