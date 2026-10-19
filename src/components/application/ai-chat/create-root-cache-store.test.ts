import { describe, expect, it, vi } from "vitest";
import { createRootCacheStore } from "./create-root-cache-store";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createRootCacheStore", () => {
  it("serves a fresh root without refetching, then refetches after invalidate", async () => {
    const fetch = vi.fn(async (_root: string) => ["a"]);
    const { useStore, invalidate } = createRootCacheStore<string>({
      fetch,
      ttlMs: 60_000,
    });

    useStore.getState().ensure("/ws");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useStore.getState().byRoot["/ws"].entries).toEqual(["a"]);

    // Fresh within TTL: no second fetch.
    useStore.getState().ensure("/ws");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Invalidate keeps stale rows visible until the refetch lands.
    fetch.mockResolvedValue(["b"]);
    invalidate();
    expect(useStore.getState().byRoot["/ws"].entries).toEqual(["a"]);
    useStore.getState().ensure("/ws");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useStore.getState().byRoot["/ws"].entries).toEqual(["b"]);
  });

  it("invalidate on an empty cache is a no-op", () => {
    const { useStore, invalidate } = createRootCacheStore<string>({
      fetch: async () => [],
      ttlMs: 60_000,
    });
    invalidate();
    expect(useStore.getState().byRoot).toEqual({});
  });
});
