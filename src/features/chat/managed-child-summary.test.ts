import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createManagedChildSummaryService, managedChildHistoryText } from "./managed-child-summary";
import type { CrossSessionCommunicationRecord } from "./cross-session";
import type { ipc } from "@/lib/ipc";

const held = (): CrossSessionCommunicationRecord => ({ scopedId: "leader:child", requestId: "held", status: "awaiting_cost_approval",
  sender: { engine: "codex", sessionId: "parent", workspacePath: "G:/project" },
  target: { engine: "agy", sessionId: "child", workspacePath: "G:/project" },
  leaderCostApproval: { branchId: "child", requestId: "held", model: "gemini-4-argon" },
  message: "完整的新任务🙂".repeat(200), acceptedAt: 1, updatedAt: 1 });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); localStorage.clear(); });
function fixture() {
  const record = held(), records = new Map<string, string>();
  let current: CrossSessionCommunicationRecord | undefined = record;
  let finish!: (text: string) => void;
  const native = vi.fn(async (_input: Parameters<typeof ipc.summarizeSessionHandoff>[0]) => new Promise<string>(resolve => { finish = resolve; }));
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: vi.fn((key: string, text: string) => { records.set(key, text); }) };
  const options = { storage, currentRecord: () => current, summarize: native, fullHistorySupported: vi.fn(async () => true),
    preferences: () => ({ enabled: false, model: "compress-model", selection: { engine: "cursor" as const, model: "compress-model" } }),
    checkpoint: { assertAllowed: () => {}, registerBlocker: () => () => {} } };
  const service = createManagedChildSummaryService(options);
  const start = (retry = false) => service.prepare(record, "目标子会话历史，不包含新任务。", "metadata-v1", () => true, retry);
  return { service, start, record, records, native, storage, options, finish: (value: string) => finish(value), change: (value?: CrossSessionCommunicationRecord) => { current = value; } };
}
describe("managed child full-history summary preparation", () => {
  it("rejects changed pending image identities before generation and ignores results after another image replaces them", async () => {
    const f = fixture();
    f.record.imageRefs = [`task-image:${"a".repeat(64)}`];
    f.change({ ...f.record, imageRefs: [`task-image:${"b".repeat(64)}`] });
    await expect(f.start()).rejects.toThrow("changed");
    expect(f.native).not.toHaveBeenCalled();
    f.change(f.record);
    const running = await f.start();
    f.change({ ...f.record, imageRefs: [] });
    f.finish("不应应用到已经更换附件的新任务的历史摘要。");
    await vi.waitFor(async () => expect((await f.service.inspect(running.handoffId))?.status).toBe("failed"));
    expect((await f.service.inspect(running.handoffId))?.summary).toBeUndefined();
    expect(f.native).toHaveBeenCalledTimes(1);
  });
  it("compresses once with /handoff selection even when global automatic compression is off, without persisting history or the new task", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.start(), f.start()]);
    expect(a).toEqual(b); expect(a.status).toBe("running");
    expect(f.native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ engine: "agy", sessionId: "child",
      historyScope: "full", compressionSelection: { engine: "cursor", model: "compress-model" } }));
    expect(f.native.mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
    expect(JSON.stringify([...f.records.values()])).not.toContain("目标子会话历史");
    expect(JSON.stringify([...f.records.values()])).not.toContain(f.record.message);
    expect(f.storage.setItem).toHaveBeenCalled();
    f.finish("压缩结果：已核对约束、结论、未完成任务和待验证事项。");
    await vi.waitFor(async () => expect((await f.service.inspect(a.handoffId))?.status).toBe("completed"));
    expect((await f.start()).summary).toContain("已核对约束"); expect(f.native).toHaveBeenCalledTimes(1);
  });
  it("restores an unresolved compression as unknown and only inspects, never replays", async () => {
    const f = fixture(), running = await f.start();
    const restored = createManagedChildSummaryService(f.options);
    expect((await restored.prepare(f.record, "目标子会话历史，不包含新任务。", "metadata-v1", () => true)).status).toBe("unknown");
    expect(f.native).toHaveBeenCalledTimes(1);
    await restored.discard(running.handoffId, running.requestId);
    expect((await restored.inspect(running.handoffId))?.status).toBe("discarded");
    f.finish("迟到的压缩结果也不能直接发送任何新任务。 ");
    await vi.waitFor(async () => expect((await f.service.inspect(running.handoffId))?.status).not.toBe("running"));
    expect((JSON.parse([...f.records.values()][0]) as Record<string, { snapshot: { status: string } }>)[running.handoffId].snapshot.status).toBe("discarded");
  });
  it("cannot bypass a restored unknown generation by choosing another model", async () => {
    const f = fixture(), original = await f.start();
    const cold = createManagedChildSummaryService(f.options);
    const recovered = await cold.prepare(f.record, "source", "metadata-v1", () => true, true, { engine: "claude", model: "different-model" });
    expect(recovered).toMatchObject({ handoffId: original.handoffId, requestId: original.requestId, status: "unknown", selection: original.selection });
    expect(f.native).toHaveBeenCalledTimes(1);
    await cold.discard(original.handoffId, original.requestId); f.finish("discarded stale generation");
  });
  it("does not start after the original task/model/source changes or persistence fails", async () => {
    const f = fixture(); f.change({ ...f.record, message: "不同的新任务" });
    await expect(f.start()).rejects.toThrow("changed"); expect(f.native).not.toHaveBeenCalled();
    f.change(f.record); f.storage.setItem.mockImplementation(() => { throw Error("disk full"); });
    await expect(f.start()).rejects.toThrow("disk full"); expect(f.native).not.toHaveBeenCalled();
  });
  it("uses only a source marker even for a single long historical message", () => {
    const text = managedChildHistoryText([{ role: "assistant", text: "🙂".repeat(30000) }]);
    expect(text).toBe("managed-child-full-v2");
    expect(text).not.toContain("🙂");
  });
  it("freezes explicit selection and gives a changed model a new generation under the same source fence", async () => {
    const f = fixture();
    const choice = { engine: "claude" as const, model: "chosen-model", providerId: "relay", effort: "high" };
    const a = await f.service.prepare(f.record, "source", "metadata-v1", () => true, false, choice);
    expect(a.selection).toEqual(choice);
    expect(f.native).toHaveBeenLastCalledWith(expect.objectContaining({ historyScope: "full", compressionSelection: choice }));
    f.finish("completed selected model summary");
    await vi.waitFor(async () => expect((await f.service.inspect(a.handoffId))?.status).toBe("completed"));
    const b = await f.start();
    expect(b.handoffId).toBe(a.handoffId);
    expect(b.requestId).not.toBe(a.requestId);
    expect(b.selection).toEqual({ engine: "cursor", model: "compress-model" });
    f.finish("new selected model summary");
  });
  it("rejects unsupported full history before calling the model", async () => {
    const f = fixture(); f.options.fullHistorySupported.mockResolvedValue(false);
    await expect(f.start()).rejects.toThrow("full-history");
    expect(f.native).not.toHaveBeenCalled();
  });
  it("does not start another model after discard until the original native call finishes", async () => {
    const f = fixture(), running = await f.start();
    await f.service.discard(running.handoffId, running.requestId);
    const another = () => f.service.prepare(f.record, "source", "metadata-v1", () => true, true, { engine: "claude", model: "other" });
    await expect(another()).rejects.toThrow("still running");
    expect(f.native).toHaveBeenCalledTimes(1);
    f.finish("discarded late result");
    await vi.waitFor(async () => expect((await another()).status).toBe("running"));
    expect(f.native).toHaveBeenCalledTimes(2);
  });
  it.each(["record", "source"])("rejects late results after %s changes", async changed => {
    const f = fixture(); let live = true;
    const running = await f.service.prepare(f.record, "source", "metadata-v1", () => live);
    if (changed === "record") f.change({ ...f.record, message: "changed" }); else live = false;
    f.finish("stale result");
    await vi.waitFor(async () => expect((await f.service.inspect(running.handoffId))?.status).toBe("failed"));
    expect((await f.service.inspect(running.handoffId))?.summary).toBeUndefined();
  });
});
