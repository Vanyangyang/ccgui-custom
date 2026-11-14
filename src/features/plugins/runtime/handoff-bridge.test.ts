import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { HostHandoffPreferences, HostHandoffSnapshot } from "@ccgui/plugin-sdk";
import { createHostHandoffBridge, HOST_HANDOFF_KEY_PREFIX } from "./handoff-bridge";
import { HANDOFF_PREFERENCES_KEY } from "@/features/chat/handoff-preferences";

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const request = { handoffId: "topic", requestId: "request-1", expectedRevision: 0, text: "私有交接原文中文🙂", title: "原话题", childContext: "子任务仍需验证" };
const summary = "整理后的交接摘要：已完成本地检查，原生任务尚未执行。";
function fixture() {
  const records = new Map<string, unknown>();
  const native = deferred<string>();
  const blockers: Array<() => readonly string[]> = [];
  let paused = false;
  let prefs: HostHandoffPreferences = { enabled: false, selection: { engine: "cursor", model: "host-model", providerId: "host-provider", effort: "high" } };
  const backend = {
    get: vi.fn(async (plugin: string, key: string) => structuredClone(records.get(plugin + key))),
    set: vi.fn(async (plugin: string, key: string, value: unknown) => { records.set(plugin + key, structuredClone(value)); }),
    delete: vi.fn(async () => {}), bridgeInvoke: vi.fn(async (_command: string, _args: Record<string, unknown>) => native.promise),
  };
  const create = (plugin = "test") => createHostHandoffBridge(plugin, backend, {
    preferences: () => prefs,
    supportsFullHistory: async () => true,
    checkpoint: { assertAllowed: () => { if (paused) throw Error("checkpoint paused"); }, registerBlocker: (_id, read) => { blockers.push(read); return () => {}; } },
  });
  const api = create();
  const settle = async (status = "completed") => vi.waitFor(async () => {
    expect((await api.inspect(request.handoffId))?.status).toBe(status); expect(blockers[0]()).toEqual([]);
  });
  return { api, create, backend, records, native, blockers, settle, pause: () => { paused = true; }, preferences: (next: HostHandoffPreferences) => { prefs = next; } };
}

describe("host handoff compressor", () => {
  it("routes coordinator sources only to their full-history owner resolver", async () => {
    const f = fixture(), coordinator = vi.fn(async () => summary), child = vi.fn();
    const api = createHostHandoffBridge("coordinator-source", f.backend, { supportsFullHistory: async () => true,
      summarizeCoordinatorHandoff: coordinator, summarizeManagedChild: child });
    const source = { kind: "coordinator" as const, conversationRequestId: "root", expectedRevision: 2 };
    const selection = { engine: "codex" as const, model: "chosen" };
    const input = { handoffId: "coordinator", requestId: "gen-1", expectedRevision: 0, source, selection };
    await api.summarize(input);
    await vi.waitFor(async () => expect((await api.inspect(input.handoffId))?.status).toBe("completed"));
    await api.summarize(input);
    expect(coordinator).toHaveBeenCalledExactlyOnceWith(source, selection, expect.any(Function));
    expect(child).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled(); api.dispose();
  });
  it.each(["resolver", "native"])("rejects coordinator compression without %s support, never falling back to text", async missing => {
    const f = fixture(), coordinator = vi.fn(), child = vi.fn();
    const api = createHostHandoffBridge(`old-coordinator-${missing}`, f.backend, { supportsFullHistory: async () => missing !== "native",
      summarizeCoordinatorHandoff: missing === "resolver" ? undefined : coordinator, summarizeManagedChild: child });
    await api.summarize({ handoffId: "root", requestId: "gen-1", expectedRevision: 0,
      source: { kind: "coordinator", conversationRequestId: "root", expectedRevision: 1 } });
    await vi.waitFor(async () => expect((await api.inspect("root"))?.status).toBe("failed"));
    expect(coordinator).not.toHaveBeenCalled(); expect(child).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled(); api.dispose();
  });
  it("reads the shared catalog without a modal, persistence or inference and detaches input/output", async () => {
    const f = fixture();
    const catalog = vi.fn(async (options: { selection?: import("@ccgui/plugin-sdk").HostHandoffSelection }) => ({ selection: options.selection!, engines: [] }));
    const api = createHostHandoffBridge("catalog-only", f.backend, { catalog });
    const options = { selection: { engine: "codex" as const, model: "catalog-model", providerId: "channel", effort: "high" } };
    const pending = api.catalog!(options);
    options.selection.model = "mutated";
    const result = await pending;
    expect(result.selection.model).toBe("catalog-model");
    expect(catalog).toHaveBeenCalledExactlyOnceWith({ selection: { engine: "codex", model: "catalog-model", providerId: "channel", effort: "high" } });
    result.selection.model = "caller-mutated";
    expect((await catalog.mock.results[0].value).selection.model).toBe("catalog-model");
    expect(f.backend.get).not.toHaveBeenCalled(); expect(f.backend.set).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled();
    api.dispose();
    await expect(api.catalog!()).rejects.toThrow("disposed");
  });
  it("rejects invalid catalog options before discovery", async () => {
    const f = fixture(), catalog = vi.fn();
    const api = createHostHandoffBridge("catalog-validation", f.backend, { catalog });
    for (const options of [{ sessionId: "secret" }, { selection: { engine: "agy", model: "unsupported" } }, { selection: { engine: "codex", model: "" } }]) {
      await expect(api.catalog!(options as never)).rejects.toThrow("Invalid handoff model catalog options");
    }
    expect(catalog).not.toHaveBeenCalled(); expect(f.backend.set).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled(); api.dispose();
  });
  it("lets the user select or cancel a compressor without storage or inference", async () => {
    const f = fixture();
    const chooseModel = vi.fn(async (_options: unknown): Promise<import("@ccgui/plugin-sdk").HostHandoffSelection | null> => ({ engine: "codex", model: "chosen-model" }));
    const picker = createHostHandoffBridge("picker-only", f.backend, { chooseModel, supportsFullHistory: async () => true });
    const options = { workspacePath: "G:/Synthetic", selection: { engine: "cursor" as const, model: "original" } };
    const choice = picker.chooseModel!(options); options.selection.model = "mutated";
    expect(await choice).toEqual({ engine: "codex", model: "chosen-model" });
    expect(chooseModel).toHaveBeenCalledWith({ workspacePath: "G:/Synthetic", selection: { engine: "cursor", model: "original" } });
    chooseModel.mockResolvedValueOnce(null);
    expect(await picker.chooseModel!(options)).toBeNull();
    expect(f.backend.get).not.toHaveBeenCalled(); expect(f.backend.set).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled();
    picker.dispose();
  });
  it("does not degrade a full-history request to an excerpt on an older native host", async () => {
    const f = fixture();
    const api = createHostHandoffBridge("legacy-native", f.backend, { supportsFullHistory: async () => false });
    await api.summarize(request);
    await vi.waitFor(async () => expect(await api.inspect(request.handoffId)).toMatchObject({ status: "failed", error: expect.stringContaining("updated native host") }));
    expect(f.backend.bridgeInvoke).not.toHaveBeenCalled(); api.dispose();
  });
  it("resolves an owned child through the task owner without exposing or submitting a clipped history", async () => {
    const f = fixture(), resolve = vi.fn(async () => summary);
    const api = createHostHandoffBridge("child-source", f.backend, { supportsFullHistory: async () => true, summarizeManagedChild: resolve });
    const source = { kind: "managedChild" as const, conversationRequestId: "parent", expectedRevision: 4, approvalId: "leader:child", approvalRequestId: "held", sourceStamp: "a".repeat(64) };
    const selection = { engine: "codex" as const, model: "chosen" };
    const input = { handoffId: "source-child", requestId: "gen-1", expectedRevision: 0, source, selection };
    await api.summarize(input);
    await vi.waitFor(async () => expect((await api.inspect(input.handoffId))?.status).toBe("completed"));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(source, selection, expect.any(Function));
    expect(f.backend.bridgeInvoke).not.toHaveBeenCalled();
    await api.summarize(input); expect(resolve).toHaveBeenCalledOnce(); api.dispose();
  });
  it("durably fingerprints before native submission, freezes host preferences, and never persists source text", async () => {
    const f = fixture(); const events: HostHandoffSnapshot[] = []; f.api.onEvent(event => events.push(event));
    f.backend.bridgeInvoke.mockImplementation(async () => {
      expect(f.records.size).toBe(1);
      expect(JSON.stringify([...f.records.values()])).not.toContain(request.text);
      expect(JSON.stringify([...f.records.values()])).not.toContain(request.childContext);
      return f.native.promise;
    });
    expect(await f.api.preferences()).toMatchObject({ enabled: false, selection: { model: "host-model" } });
    const running = await f.api.summarize(request);
    expect(running).toMatchObject({ status: "running", requestId: request.requestId, revision: 1, selection: { model: "host-model" } });
    f.preferences({ enabled: true, selection: { engine: "claude", model: "changed-model" } });
    expect(f.backend.bridgeInvoke).toHaveBeenCalledExactlyOnceWith("plugin_summarize_handoff", {
      pluginId: "test", transcriptExcerpt: request.text, title: request.title, childContext: request.childContext,
      compressionSelection: { engine: "cursor", model: "host-model", providerId: "host-provider", effort: "high" },
      fullHistory: true,
    });
    expect(f.blockers[0]()).not.toEqual([]);
    f.native.resolve(summary); await f.settle();
    expect(await f.api.inspect("topic")).toMatchObject({ status: "completed", summary, revision: 2, selection: running.selection });
    expect(events.map(event => event.status)).toEqual(["running", "completed"]);
  });

  it("deduplicates concurrent and terminal retries, rejects changed input and stale revisions", async () => {
    const f = fixture();
    const [first, retry] = await Promise.all([f.api.summarize(request), f.api.summarize({ ...request })]);
    expect(first).toEqual(retry); expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
    for (const change of [{ text: "changed" }, { title: "changed" }, { childContext: "changed" }, { expectedRevision: 1 }]) {
      await expect(f.api.summarize({ ...request, ...change })).rejects.toThrow("different input");
    }
    await expect(f.api.summarize({ ...request, requestId: "new" })).rejects.toThrow("Stale");
    await expect(f.api.summarize({ ...request, requestId: "new", expectedRevision: 1 })).rejects.toThrow("still running");
    f.native.resolve(summary); await f.settle();
    expect(await f.api.summarize(request)).toMatchObject({ status: "completed", summary });
    expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
  });

  it("restores a persisted running request as unknown without replaying it, then permits explicit discard", async () => {
    const f = fixture(); await f.api.summarize(request);
    const cold = f.create();
    const unknown = await cold.inspect("topic");
    expect(unknown).toMatchObject({ status: "unknown", revision: 2, requestId: request.requestId });
    expect(await cold.summarize(request)).toEqual(unknown);
    await expect(cold.summarize({ ...request, requestId: "new", expectedRevision: 2 })).rejects.toThrow("unknown");
    expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
    const discarded = await cold.discard("topic", request.requestId);
    expect(discarded).toMatchObject({ status: "discarded", revision: 3 });
    await expect(cold.discard("topic", "wrong")).rejects.toThrow("identity mismatch");
    f.native.resolve(summary); await f.settle("discarded");
    expect((await f.backend.get("test", HOST_HANDOFF_KEY_PREFIX + "topic") as { snapshot: HostHandoffSnapshot }).snapshot).toMatchObject({ status: "discarded", revision: 3 });
  });

  it("discards late output but holds the native blocker and per-handoff flight until inference settles", async () => {
    const f = fixture(); const events: HostHandoffSnapshot[] = []; f.api.onEvent(event => events.push(event));
    await f.api.summarize(request);
    const discarded = await f.api.discard("topic", request.requestId);
    expect(discarded?.status).toBe("discarded"); expect(f.blockers[0]()).not.toEqual([]);
    await expect(f.api.summarize({ ...request, requestId: "next", expectedRevision: discarded!.revision })).rejects.toThrow("still running");
    f.native.resolve(summary); await f.settle("discarded");
    expect(await f.api.inspect("topic")).not.toHaveProperty("summary");
    expect(events.map(event => event.status)).toEqual(["running", "discarded"]);
    expect(f.backend.bridgeInvoke.mock.calls.map(call => call[0])).toEqual(["plugin_summarize_handoff"]);
  });

  it("does not invoke native after an intent write failure or checkpoint pause during the write", async () => {
    const f = fixture(); f.backend.set.mockRejectedValueOnce(Error("disk unavailable"));
    await expect(f.api.summarize(request)).rejects.toThrow("disk unavailable");
    expect(f.backend.bridgeInvoke).not.toHaveBeenCalled(); expect(f.blockers[0]()).toEqual([]);
    const gate = deferred<void>();
    f.backend.set.mockImplementationOnce(async (plugin, key, value) => { await gate.promise; f.records.set(plugin + key, structuredClone(value)); });
    const pending = f.api.summarize(request);
    await vi.waitFor(() => expect(f.backend.set).toHaveBeenCalledTimes(2));
    expect(f.blockers[0]()).not.toEqual([]); f.pause(); gate.resolve();
    await expect(pending).rejects.toThrow("checkpoint paused");
    expect(f.backend.bridgeInvoke).not.toHaveBeenCalled();
    expect(await f.api.inspect("topic")).toMatchObject({ status: "failed" });
  });

  it("records native failures and persistence uncertainty without automatic resubmission", async () => {
    const f = fixture(); await f.api.summarize(request); f.native.reject(Error("native timeout")); await f.settle("failed");
    expect(await f.api.summarize(request)).toMatchObject({ status: "failed", error: "native timeout" });
    expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
    const next = fixture(); await next.api.summarize(request); next.backend.set.mockRejectedValueOnce(Error("disk offline")); next.native.resolve(summary);
    await next.settle("unknown");
    expect(await next.api.inspect("topic")).toMatchObject({ status: "unknown", summary, error: expect.stringContaining("could not be saved") });
    expect(await next.api.summarize(request)).toMatchObject({ status: "unknown" });
    expect(next.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
  });

  it("rejects source identities and unbounded input before native or storage access", async () => {
    const f = fixture();
    for (const patch of [{ sessionId: "secret" }, { text: "x".repeat(48001) }, { childContext: "x".repeat(6001) }, { title: "x".repeat(513) }, { selection: { engine: "codex" } }, { handoffId: "../other" }]) {
      await expect(f.api.summarize({ ...request, ...patch } as unknown as import("@ccgui/plugin-sdk").HostHandoffRequest)).rejects.toThrow(/Invalid handoff/);
    }
    expect(f.backend.get).not.toHaveBeenCalled(); expect(f.backend.bridgeInvoke).not.toHaveBeenCalled();
  });

  it("isolates plugin namespaces and keeps the latest durable record after terminal cache eviction", async () => {
    const f = fixture(); f.backend.bridgeInvoke.mockResolvedValue(summary);
    for (let index = 0; index < 66; index++) {
      const handoffId = "topic-" + index;
      await f.api.summarize({ ...request, handoffId });
      await vi.waitFor(async () => expect((await f.api.inspect(handoffId))?.status).toBe("completed"));
    }
    const reads = f.backend.get.mock.calls.length;
    expect(await f.api.inspect("topic-0")).toMatchObject({ status: "completed" });
    expect(f.backend.get.mock.calls.length).toBeGreaterThan(reads);
    expect(f.records.size).toBe(66);
    expect(await f.create("other").inspect("topic-0")).toBeNull();
    await f.api.summarize({ ...request, handoffId: "topic-0" });
    expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(66);
    expect(f.records.has("test" + HOST_HANDOFF_KEY_PREFIX + "topic-0")).toBe(true);
  });

  it("preserves singleton flights across plugin reload and detaches only disposed listeners", async () => {
    const f = fixture();
    localStorage.setItem(HANDOFF_PREFERENCES_KEY, JSON.stringify({ enabled: false, selection: { engine: "pi", model: "host-pi" } }));
    const first = createHostHandoffBridge("reload-test", f.backend, { singleton: true, supportsFullHistory: async () => true });
    const oldEvent = vi.fn(); first.onEvent(oldEvent);
    await first.summarize(request); first.dispose();
    const second = createHostHandoffBridge("reload-test", f.backend, { singleton: true, supportsFullHistory: async () => true });
    const newEvent = vi.fn(); second.onEvent(newEvent);
    expect(await second.inspect("topic")).toMatchObject({ status: "running", selection: { engine: "pi", model: "host-pi" } });
    await second.summarize(request); expect(f.backend.bridgeInvoke).toHaveBeenCalledTimes(1);
    f.native.resolve(summary);
    await vi.waitFor(async () => expect((await second.inspect("topic"))?.status).toBe("completed"));
    expect(oldEvent).toHaveBeenCalledTimes(1); expect(newEvent).toHaveBeenCalledTimes(1);
    second.dispose();
  });
});
