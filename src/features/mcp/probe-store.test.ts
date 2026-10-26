import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfigEntry, McpProbeResult } from "./types";

const api = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("./api", () => ({ mcpApi: api }));

import {
  PROBE_CONCURRENCY,
  PROBE_TTL_MS,
  needsProbe,
  probeable,
  probeStateFor,
  useMcpProbeStore,
} from "./probe-store";

function entry(overrides: Partial<McpConfigEntry> = {}): McpConfigEntry {
  return {
    id: "claude_user:alpha",
    engine: "claude",
    name: "alpha",
    source: "claude_user",
    scope: "user",
    path: "/home/u/.claude.json",
    format: "json",
    enabled: true,
    transport: "stdio",
    command: "npx",
    argsCount: 1,
    url: null,
    envKeys: [],
    headerKeys: [],
    writable: true,
    readonlyReason: null,
    version: "v1",
    ...overrides,
  };
}

function connected(tools: string[] = []): McpProbeResult {
  return {
    status: "connected",
    message: null,
    tools,
    serverName: "fake",
    protocolVersion: "2025-06-18",
    elapsedMs: 4,
  };
}

function deferredProbe() {
  let resolve!: (result: McpProbeResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<McpProbeResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("probe store", () => {
  beforeEach(() => {
    api.probe.mockReset();
    useMcpProbeStore.setState({
      results: {},
      pending: {},
      runningAll: false,
      error: null,
    });
  });

  it("only entries with a command or url are checkable", () => {
    expect(probeable(entry())).toBe(true);
    expect(probeable(entry({ command: null, url: "https://x/mcp" }))).toBe(true);
    expect(probeable(entry({ command: null, url: null }))).toBe(false);
  });

  it("drops results whose config version changed", () => {
    const state = { result: connected(), checkedAt: 1, version: "v1" };
    expect(probeStateFor({ [entry().id]: state }, entry())).toBe(state);
    expect(probeStateFor({ [entry().id]: state }, entry({ version: "v2" }))).toBeNull();
    expect(probeStateFor({}, entry())).toBeNull();
  });

  it("records pending then the result, and survives a failure", async () => {
    let release: (value: McpProbeResult) => void = () => {};
    api.probe.mockImplementationOnce(
      () => new Promise<McpProbeResult>((resolve) => (release = resolve)),
    );
    const probing = useMcpProbeStore.getState().probe(entry(), null);
    expect(useMcpProbeStore.getState().pending[entry().id]).toBe(true);
    release(connected(["a"]));
    await probing;
    const state = useMcpProbeStore.getState();
    expect(state.pending[entry().id]).toBeUndefined();
    expect(state.results[entry().id].result.tools).toEqual(["a"]);
    expect(state.results[entry().id].version).toBe("v1");

    api.probe.mockRejectedValueOnce(new Error("boom"));
    await useMcpProbeStore.getState().probe(entry(), null);
    expect(useMcpProbeStore.getState().error).toBe("boom");
  });

  it("runs checks in parallel up to the cap, then reuses fresh results", async () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ id: `e:${index}`, name: `s${index}` }),
    );
    let active = 0;
    let maxActive = 0;
    api.probe.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return connected();
    });

    await useMcpProbeStore.getState().probeAll(entries, null, { force: true });
    expect(api.probe).toHaveBeenCalledTimes(6);
    // 并行但有上限：既不串行，也不会一次拉起全部（6 条）。
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(PROBE_CONCURRENCY);

    // 新鲜结果直接复用：再打开（非 force）不再启动任何服务。
    api.probe.mockClear();
    await useMcpProbeStore.getState().probeAll(entries, null);
    expect(api.probe).not.toHaveBeenCalled();

    // 超过 TTL 后重新检测。
    const stale = Date.now() - PROBE_TTL_MS - 1;
    useMcpProbeStore.setState((state) => ({
      results: Object.fromEntries(
        Object.entries(state.results).map(([id, value]) => [
          id,
          { ...value, checkedAt: stale },
        ]),
      ),
    }));
    await useMcpProbeStore.getState().probeAll(entries, null);
    expect(api.probe).toHaveBeenCalledTimes(6);

    // 停用条目无论强制与否都不启动。
    api.probe.mockClear();
    await useMcpProbeStore.getState().probeAll(
      [...entries, entry({ id: "off:x", name: "off", enabled: false })],
      null,
      { force: true },
    );
    expect(api.probe).toHaveBeenCalledTimes(6);
    expect(useMcpProbeStore.getState().pending).toEqual({});
    expect(useMcpProbeStore.getState().runningAll).toBe(false);
  });

  it("needsProbe skips disabled, unprobeable and still-fresh entries", () => {
    const fresh = { result: connected(), checkedAt: Date.now(), version: "v1" };
    expect(needsProbe(entry(), {})).toBe(true);
    expect(needsProbe(entry(), { [entry().id]: fresh })).toBe(false);
    expect(
      needsProbe(entry(), {
        [entry().id]: { ...fresh, checkedAt: Date.now() - PROBE_TTL_MS - 1 },
      }),
    ).toBe(true);
    expect(needsProbe(entry({ enabled: false }), {})).toBe(false);
    expect(needsProbe(entry({ command: null, url: null }), {})).toBe(false);
    // 配置版本变了：旧结果不算数。
    expect(needsProbe(entry({ version: "v2" }), { [entry().id]: fresh })).toBe(true);
  });

  it("shares the exact in-flight promise, including after clear", async () => {
    const deferred = deferredProbe();
    api.probe.mockReturnValue(deferred.promise);
    const store = useMcpProbeStore.getState();
    const first = store.probe(entry(), null);
    expect(store.probe(entry(), null)).toBe(first);
    store.clear();
    expect(store.probe(entry(), null)).toBe(first);
    expect(api.probe).toHaveBeenCalledTimes(1);
    deferred.resolve(connected());
    await first;
    expect(useMcpProbeStore.getState().pending).toEqual({});
  });

  it.each([false, true])("shares a single check with an automatic/forced batch (force=%s)", async (force) => {
    const deferred = deferredProbe();
    api.probe.mockReturnValue(deferred.promise);
    const store = useMcpProbeStore.getState();
    const single = store.probe(entry(), null);
    const batch = store.probeAll([entry()], null, { force });
    expect(api.probe).toHaveBeenCalledTimes(1);
    deferred.resolve(connected());
    await Promise.all([single, batch]);
    expect(useMcpProbeStore.getState().runningAll).toBe(false);
  });

  it("reserves queued batch items and caps all manual and batch work together", async () => {
    const deferreds = Array.from({ length: 8 }, deferredProbe);
    let active = 0;
    let maximum = 0;
    api.probe.mockImplementation((target: McpConfigEntry) => {
      active++;
      maximum = Math.max(maximum, active);
      return deferreds[Number(target.id)].promise.finally(() => { active--; });
    });
    const targets = deferreds.map((_, id) => entry({ id: String(id) }));
    const store = useMcpProbeStore.getState();
    const first = store.probe(targets[0], null);
    const batch = store.probeAll(targets.slice(1, 7), null);
    const queued = store.probe(targets[6], null);
    const last = store.probe(targets[7], null);
    expect(api.probe).toHaveBeenCalledTimes(PROBE_CONCURRENCY);
    expect(Object.keys(useMcpProbeStore.getState().pending)).toHaveLength(8);
    deferreds.forEach((deferred) => deferred.resolve(connected()));
    await Promise.all([first, batch, queued, last]);
    expect(api.probe).toHaveBeenCalledTimes(8);
    expect(maximum).toBe(PROBE_CONCURRENCY);
    expect(useMcpProbeStore.getState().pending).toEqual({});
  });

  it.each(["version", "workspace"])("keeps the newest result when %s changes and the older request finishes last", async (kind) => {
    const old = deferredProbe();
    const fresh = deferredProbe();
    api.probe.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const store = useMcpProbeStore.getState();
    const first = store.probe(entry(), null);
    const latestEntry = kind === "version" ? entry({ version: "v2" }) : entry();
    const second = store.probe(latestEntry, kind === "workspace" ? "/other" : null);
    expect(api.probe).toHaveBeenCalledTimes(2);
    fresh.resolve(connected(["new"]));
    await second;
    expect(useMcpProbeStore.getState().pending[entry().id]).toBe(true);
    old.resolve(connected(["old"]));
    await first;
    expect(useMcpProbeStore.getState().results[entry().id].result.tools).toEqual(["new"]);
    expect(useMcpProbeStore.getState().results[entry().id].version).toBe(latestEntry.version);
    expect(useMcpProbeStore.getState().pending).toEqual({});
  });

  it("releases rejected requests and lets queued work and a later retry run", async () => {
    const blocked = Array.from({ length: PROBE_CONCURRENCY }, deferredProbe);
    blocked.forEach((deferred) => api.probe.mockReturnValueOnce(deferred.promise));
    api.probe.mockResolvedValue(connected());
    const store = useMcpProbeStore.getState();
    const first = blocked.map((_, id) => store.probe(entry({ id: String(id) }), null));
    const queued = store.probe(entry({ id: "queued" }), null);
    expect(api.probe).toHaveBeenCalledTimes(PROBE_CONCURRENCY);
    blocked.forEach((deferred) => deferred.reject(new Error("boom")));
    await Promise.all([...first, queued]);
    await store.probe(entry({ id: "0" }), null);
    expect(api.probe).toHaveBeenCalledTimes(PROBE_CONCURRENCY + 2);
    expect(useMcpProbeStore.getState().pending).toEqual({});
  });
});
