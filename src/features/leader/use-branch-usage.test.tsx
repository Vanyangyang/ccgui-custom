import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type Message, type SessionPage } from "@/lib/ipc";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import type { SessionState } from "@/features/chat/store";
import type { LeaderBranch } from "./types";
import { useBranchUsage } from "./use-branch-usage";
import { leaderContextInfo } from "./branch-health";

vi.mock("@/lib/ipc", () => ({ ipc: { loadSessionPage: vi.fn() } }));
const branch = (id = "child", engine = "claude"): LeaderBranch => ({ id, engine, sessionId: id, parentEngine: "claude", parentSessionId: "root", workspacePath: "/workspace", title: id,
  task: "task", model: null, effort: null, runId: "run", state: "running", createdAt: 1, updatedAt: 2, lastActivityAt: 2, deadlineAt: 10_000, expired: false,
  result: "", resultTruncated: false, error: null });
const page = (usage: unknown): SessionPage => ({ messages: [{ seq: 1, role: "assistant", text: "history", usage, model: "actual-model", ts: null }], nextBefore: null, subagentHistory: [] });
let node: HTMLDivElement, root: Root, current: ReturnType<typeof useBranchUsage>;
function Probe({ branches, bySession = {} }: { branches: LeaderBranch[]; bySession?: Record<string, SessionState> }) {
  current = useBranchUsage(branches, bySession);
  return <div>{JSON.stringify(branches.map((child) => current.sampleFor(child)))}</div>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(ipc.loadSessionPage).mockReset().mockResolvedValue(page({ input_tokens: 100 }));
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("bounded Leader history occupancy reading", () => {
  it("reads the latest single historical report for both engines and retains only usage metadata", async () => {
    const children = [branch("claude"), branch("codex", "codex")];
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({ ...page({ input_tokens: 25 }), messages: [
      { seq: 1, role: "assistant", text: "old", usage: { input_tokens: 800_000 }, ts: null },
      { seq: 2, role: "assistant", text: "new", usage: { input_tokens: 25 }, model: "actual-model", ts: null },
    ] });
    await act(async () => root.render(<Probe branches={children} />));
    expect(ipc.loadSessionPage).toHaveBeenNthCalledWith(1, "claude", "claude", 100);
    expect(ipc.loadSessionPage).toHaveBeenNthCalledWith(2, "codex", "codex", 100);
    for (const child of children) expect(current.sampleFor(child)).toEqual({ usage: { input_tokens: 25 }, model: "actual-model", fetchedAt: expect.any(Number) });
  });
  it("does not reread for streaming text, live billing, or a deadline-only native checkpoint", async () => {
    const child = branch("codex", "codex");
    await act(async () => root.render(<Probe branches={[child]} bySession={{ "codex/codex": { ...EMPTY_SESSION, streaming: true } }} />));
    await act(async () => root.render(<Probe branches={[{ ...child, updatedAt: 100, lastActivityAt: 100, expired: true }]} bySession={{ "codex/codex": {
      ...EMPTY_SESSION, streaming: true, usage: { input_tokens: 9_000_000 }, messages: [{ seq: 1, role: "assistant", text: "new delta", ts: null }],
    } }} />));
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(1);
    expect(current.sampleFor(child)?.usage).toEqual({ input_tokens: 100 });
  });
  it("rereads after settling and ignores an old run response arriving later", async () => {
    const child = branch(); let resolve!: (value: SessionPage) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValueOnce(page({ input_tokens: 25 }));
    await act(async () => root.render(<Probe branches={[child]} bySession={{ "claude/child": { ...EMPTY_SESSION, streaming: true } }} />));
    await act(async () => root.render(<Probe branches={[{ ...child, runId: "next-run", state: "completed" }]} bySession={{ "claude/child": { ...EMPTY_SESSION } }} />));
    expect(current.sampleFor(child)?.usage).toEqual({ input_tokens: 25 });
    await act(async () => resolve(page({ input_tokens: 900_000 })));
    expect(current.sampleFor(child)?.usage).toEqual({ input_tokens: 25 });
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2);
  });
  it("refreshes a high snapshot to an unknown latest snapshot without falling back to an older high message", async () => {
    const child = branch("codex", "codex");
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(page({ input_tokens: 900_000 })).mockResolvedValueOnce({ ...page(null), messages: [
      { seq: 1, role: "assistant", text: "older", usage: { input_tokens: 900_000 }, ts: null },
      { seq: 2, role: "assistant", text: "latest", usage: { info: { model_context_window: 1_000_000, total_token_usage: { input_tokens: 9_000_000 } } }, ts: null },
    ] });
    await act(async () => root.render(<Probe branches={[child]} />));
    await act(async () => current.refresh());
    expect(current.sampleFor(child)?.usage).toEqual({ info: { model_context_window: 1_000_000, total_token_usage: { input_tokens: 9_000_000 } } });
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2);
  });
  it.each(["claude", "codex"].flatMap((engine) => [null, false, 0].map((usage) => [engine, usage] as const)))("preserves an explicit unknown latest usage for %s: %s", async (engine, usage) => {
    const child = { ...branch("child", engine), expired: true, deadlineAt: 1234 };
    const highUsage = { input_tokens: 900_000, model_context_window: 1_000_000 };
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce(page(highUsage)).mockResolvedValueOnce({ ...page(null), messages: [
      { seq: 1, role: "assistant", text: "older", usage: highUsage, ts: null },
      { seq: 2, role: "assistant", text: "latest unknown", usage, ts: null },
    ] });
    await act(async () => root.render(<Probe branches={[child]} />));
    expect(current.sampleFor(child)?.usage).toEqual(highUsage);
    await act(async () => current.refresh());
    const sample = current.sampleFor(child);
    expect(sample).toBeTruthy(); expect(sample?.usage).toBe(usage);
    const context = leaderContextInfo({ branch: child, sample, cachedUsage: highUsage, claudeConfigKnown: true });
    expect(context.tokens).toBeUndefined(); expect(context.suggestCompact).toBe(false);
  });
  it.each([false, true])("keeps the latest reported snapshot when a subsequent row has no usage (explicit undefined: %s)", async (explicit) => {
    const child = branch(); const highUsage = { input_tokens: 900_000, model_context_window: 1_000_000 };
    const unreported: Message = { seq: 2, role: "tool", text: "no usage report", ts: null };
    if (explicit) unreported.usage = undefined;
    vi.mocked(ipc.loadSessionPage).mockResolvedValue({ ...page(null), messages: [
      { seq: 1, role: "assistant", text: "last report", usage: highUsage, ts: null }, unreported,
    ] });
    await act(async () => root.render(<Probe branches={[child]} />));
    expect(current.sampleFor(child)?.usage).toEqual(highUsage);
  });
  it("bounds a panel to 128 samples and four concurrent reads", async () => {
    let active = 0, peak = 0;
    vi.mocked(ipc.loadSessionPage).mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return page({ input_tokens: 100 });
    });
    const children = Array.from({ length: 130 }, (_, index) => branch(`child-${index}`));
    await act(async () => root.render(<Probe branches={children} />));
    expect(peak).toBe(4); expect(ipc.loadSessionPage).toHaveBeenCalledTimes(128);
    expect(current.sampleFor(children[127])).toBeTruthy(); expect(current.sampleFor(children[128])).toBeUndefined();
  });
  it("reuses in-flight requests during StrictMode and stops queued reads after unmount", async () => {
    const resolvers: Array<(value: SessionPage) => void> = [];
    vi.mocked(ipc.loadSessionPage).mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const children = Array.from({ length: 8 }, (_, index) => branch(`strict-${index}`));
    await act(async () => root.render(<StrictMode><Probe branches={children} /></StrictMode>));
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(4);
    await act(async () => root.render(null));
    await act(async () => resolvers.forEach((resolve) => resolve(page({ input_tokens: 100 }))));
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(4);
  });
  it("clears an unavailable reading and allows a later explicit refresh", async () => {
    const child = branch();
    vi.mocked(ipc.loadSessionPage).mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValueOnce(page({ input_tokens: 25 }));
    await act(async () => root.render(<Probe branches={[child]} />));
    expect(current.sampleFor(child)).toBeNull();
    expect(current.readFailedFor(child)).toBe(true); expect(current.hasReadFailure()).toBe(true);
    await act(async () => current.refresh());
    expect(current.sampleFor(child)?.usage).toEqual({ input_tokens: 25 });
    expect(current.readFailedFor(child)).toBe(false); expect(current.hasReadFailure()).toBe(false);
  });
});
