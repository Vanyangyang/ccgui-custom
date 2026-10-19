import { create } from "zustand";

/**
 * Factory for the composer pickers' per-root caches (@-mention file index,
 * `/` command catalog), both with the same stale-while-revalidate model:
 * - Entries are fetched ONCE per workspace root, then revalidated in the
 *   background after the TTL while stale entries stay visible.
 * - Concurrent ensure() calls share one in-flight fetch.
 * - A failed refresh keeps serving the stale entries; only a failed first
 *   fetch leaves the picker empty.
 * - prune() drops a removed workspace's cache so the per-root map does not
 *   accumulate every root ever opened.
 * Matching stays with each picker — pure JS over the cached entries.
 */

/** One root's cached entries: a stale-while-revalidate snapshot. */
export interface RootCache<T> {
  entries: T[];
  status: "loading" | "ready" | "error";
  fetchedAt: number;
}

interface RootCacheStore<T> {
  byRoot: Record<string, RootCache<T>>;
  /** Fetch entries for a root: once, then again only once it is stale.
   *  Never throws; failures keep the previous entries and mark "error". */
  ensure: (root: string) => void;
}

export function createRootCacheStore<T>({
  fetch,
  ttlMs,
}: {
  fetch: (root: string) => Promise<T[]>;
  ttlMs: number;
}) {
  /** In-flight fetches keyed by root: concurrent ensure() calls share one IPC. */
  const inFlight = new Map<string, Promise<void>>();

  const useStore = create<RootCacheStore<T>>()((set, get) => ({
    byRoot: {},
    ensure: (root) => {
      if (!root) return;
      const cur = get().byRoot[root];
      if (inFlight.has(root)) return;
      if (cur && cur.status === "ready" && Date.now() - cur.fetchedAt < ttlMs) return;
      if (!cur) {
        set((s) => ({
          byRoot: { ...s.byRoot, [root]: { entries: [], status: "loading", fetchedAt: 0 } },
        }));
      }
      const p = fetch(root)
        .then((entries) => {
          set((s) => {
            // Pruned while the fetch was in flight (workspace removed): stay gone.
            if (!(root in s.byRoot)) return {};
            return {
              byRoot: {
                ...s.byRoot,
                [root]: { entries, status: "ready", fetchedAt: Date.now() },
              },
            };
          });
        })
        .catch(() => {
          set((s) => {
            if (!(root in s.byRoot)) return {};
            const prev = s.byRoot[root];
            return {
              byRoot: {
                ...s.byRoot,
                // A failed refresh keeps serving the stale entries; only a
                // failed first fetch leaves the picker empty.
                [root]: {
                  entries: prev?.entries ?? [],
                  status: "error",
                  fetchedAt: prev?.fetchedAt ?? 0,
                },
              },
            };
          });
        })
        .finally(() => {
          inFlight.delete(root);
        });
      inFlight.set(root, p);
    },
  }));

  /** Drop one workspace root's cache when its workspace is removed. */
  function prune(root: string) {
    useStore.setState((s) => {
      if (!(root in s.byRoot)) return {};
      const byRoot = { ...s.byRoot };
      delete byRoot[root];
      return { byRoot };
    });
  }

  /** Mark every cached root stale without dropping its rows: the next
   *  `ensure()` refetches immediately (stale entries stay visible meanwhile).
   *  Used when a mutation changed what the picker would list — installing a
   *  skill must not wait out the TTL. */
  function invalidate() {
    useStore.setState((s) => {
      const roots = Object.keys(s.byRoot);
      if (roots.length === 0) return {};
      const byRoot: Record<string, RootCache<T>> = {};
      for (const root of roots) {
        byRoot[root] = { ...s.byRoot[root], fetchedAt: 0 };
      }
      return { byRoot };
    });
  }

  return { useStore, prune, invalidate };
}
