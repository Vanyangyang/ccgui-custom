import { describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import type { Message } from "@/lib/ipc";
import { TaskPreSpawnError } from "@/features/plugins/runtime/task-facade";
import { createSessionCreateHandler, latestReplyPreview, sessionCreatePrompt, type SessionCreateDeps, type SessionCreateRequest, type SessionSpawnGrant } from "./session-create";

const grant = (patch: Partial<SessionSpawnGrant> = {}): SessionSpawnGrant => ({
  mode: "start", runId: "run-reserved", requestId: "req-1", engine: "codex", workspacePath: "G:/target",
  sessionId: null, state: "starting", error: null, ...patch,
});

const request = (spawn?: SessionSpawnGrant, args: Record<string, unknown> = {}): SessionCreateRequest => ({
  requestId: "relay-1",
  sender: { runId: "creator-run", engine: "agy", sessionId: "creator", workspacePath: "G:/human" },
  method: "session_create",
  arguments: { workspace_path: "G:/target", engine: "codex", message: "Fix the bug", request_id: "req-1", ...args },
  ...(spawn ? { sessionSpawn: spawn } : {}),
});

const row = (seq: number, role: string, text: string, live = false): Message => ({ seq, role, text, ts: null, ...(live ? { live } : {}) });

function setup(overrides: Partial<Awaited<ReturnType<SessionCreateDeps["facade"]>>> = {}) {
  const sendNewIsolated = vi.fn(async (_engine: string, _ws: string, _prompt: string, runId: string, _launch?: unknown, beforeSend?: () => Promise<void>) => {
    await beforeSend?.();
    return { runId, sessionId: "created" };
  });
  const facade = {
    ready: vi.fn(async () => {}),
    engines: () => [{ id: "codex", available: true, enabled: true, defaultModel: "gpt-x", defaultEffort: "high", defaultProvider: null }],
    workspaces: () => [{ id: "w", path: "G:/target", name: "target", remote: false, archived: false }],
    liveRun: vi.fn((_runId: string): string | null => null),
    settledRun: vi.fn((): { status: "completed" | "failed" | "cancelled"; error?: string } | null => null),
    loadPage: vi.fn(async () => ({ messages: [] as Message[], nextBefore: null })),
    sendNewIsolated,
    ...overrides,
  };
  const report = vi.fn(async () => {});
  const rename = vi.fn(async () => {});
  let active = true;
  const handler = createSessionCreateHandler({ facade: async () => facade as never, report, rename, isActive: () => active });
  return { handler, facade, report, rename, sendNewIsolated, deactivate: () => { active = false; } };
}

describe("session_create desktop handler", () => {
  it("keeps a started run uncertain when persisting its session binding fails, without renaming or resending", async () => {
    const { handler, report, rename, sendNewIsolated } = setup();
    report.mockRejectedValueOnce(new Error("session provenance write failed"));
    await expect(handler(request(grant(), { title: "Created title" }))).rejects.toThrow(/outcome is unknown/);
    expect(sendNewIsolated).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(report).toHaveBeenNthCalledWith(1, "run-reserved", "running", "created", null);
    expect(report).toHaveBeenNthCalledWith(2, "run-reserved", "unknown", null, "session provenance write failed");
  });
  it("preserves uncertain provenance with a known session id without presenting an idle success or resending", async () => {
    const { handler, facade, report, rename, sendNewIsolated } = setup();
    expect(await handler(request(grant({ mode: "replay", state: "unknown", sessionId: "created", error: "binding incomplete" })))).toMatchObject({
      status: "unknown", replayed: true, error: "binding incomplete",
      session: { engine: "codex", session_id: "created", workspace_path: "G:/target" },
    });
    expect(facade.loadPage).not.toHaveBeenCalled();
    expect(sendNewIsolated).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
  it("unsubscribes a late listener registration after disposal without sending", async () => {
    const registered = Promise.withResolvers<() => void>();
    const listen = vi.fn(() => registered.promise);
    const unlisten = vi.fn();
    const { handler, sendNewIsolated, report, rename } = setup({ listen });
    const started = handler(request(grant(), { title: "Late title" }));
    const rejected = expect(started).rejects.toThrow(/nothing was sent/);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    handler.dispose();
    registered.resolve(unlisten);
    await rejected;
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(sendNewIsolated).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    await expect(handler(request(grant()))).rejects.toThrow(/no longer active/);
  });

  it("immediately unsubscribes during send and preserves a late acknowledgement without side effects", async () => {
    const ack = Promise.withResolvers<{ runId: string; sessionId: string }>();
    const send = vi.fn(() => ack.promise);
    const unlisten = vi.fn();
    const { handler, report, rename } = setup({ listen: vi.fn(async () => unlisten), sendNewIsolated: send });
    const started = handler(request(grant(), { title: "Late title" }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    handler.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
    ack.resolve({ runId: "run-reserved", sessionId: "created" });
    expect(await started).toMatchObject({ status: "running", session: { session_id: "created" } });
    expect(report).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    handler.dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("clears the announcement timer on disposal and ignores late session events", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((events: EngineEventPayload[]) => void) | undefined;
      const unlisten = vi.fn();
      const { handler, report, rename } = setup({
        listen: vi.fn(async (cb) => { listener = cb; return unlisten; }),
        sendNewIsolated: vi.fn(async () => ({ runId: "run-reserved", sessionId: null })),
      });
      expect(await handler(request(grant(), { title: "Late title" }))).toMatchObject({ status: "starting" });
      expect(vi.getTimerCount()).toBe(1);
      handler.dispose();
      expect(unlisten).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      listener?.([{ runId: "run-reserved", sessionId: "late", engine: "codex", seq: 1, kind: "session", data: null }]);
      expect(report).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts an isolated root chat with the reserved run id and creator attribution", async () => {
    const { handler, sendNewIsolated, report, rename } = setup();
    const result = await handler(request(grant(), { title: "Fix task", model: "gpt-y" }));
    expect(sendNewIsolated).toHaveBeenCalledTimes(1);
    const [engine, workspace, prompt, runId, launch] = sendNewIsolated.mock.calls[0];
    expect([engine, workspace, runId]).toEqual(["codex", "G:/target", "run-reserved"]);
    expect(prompt).toBe(sessionCreatePrompt({ engine: "agy", sessionId: "creator" }, "Fix the bug"));
    expect(prompt.startsWith('[Message from CC GUI {"engine":"agy","session_id":"creator","origin":"session_create"}]\n\n')).toBe(true);
    expect(launch).toMatchObject({ model: "gpt-y", defaultModel: "gpt-x", defaultEffort: "high" });
    expect(report).toHaveBeenCalledWith("run-reserved", "running", "created", null);
    expect(rename).toHaveBeenCalledWith("codex", "created", "Fix task");
    expect(result).toEqual({ requestId: "req-1", status: "running", replayed: false,
      session: { engine: "codex", session_id: "created", workspace_path: "G:/target" } });
  });

  it("reports a pre-spawn refusal as failed and nothing sent", async () => {
    const { handler, report, sendNewIsolated } = setup({ workspaces: () => [] });
    await expect(handler(request(grant()))).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
    expect(sendNewIsolated).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("run-reserved", "failed", null, expect.stringContaining("WORKSPACE_UNAVAILABLE"));
  });

  it("distinguishes a host pre-spawn error from an unknown native outcome", async () => {
    const refused = setup({ sendNewIsolated: vi.fn(async () => { throw new TaskPreSpawnError("draft changed"); }) });
    await expect(refused.handler(request(grant()))).rejects.toThrow("draft changed");
    expect(refused.report).toHaveBeenCalledWith("run-reserved", "failed", null, "draft changed");

    const unknown = setup({ sendNewIsolated: vi.fn(async () => { throw new Error("transport lost"); }) });
    await expect(unknown.handler(request(grant()))).rejects.toThrow(/outcome is unknown.*same request_id/);
    expect(unknown.report).toHaveBeenCalledWith("run-reserved", "unknown", null, "transport lost");
  });

  it("refuses requests without native admission or with a mismatched request id", async () => {
    const { handler, sendNewIsolated } = setup();
    await expect(handler(request())).rejects.toThrow(/admission is missing/);
    await expect(handler(request(grant({ requestId: "other" })))).rejects.toThrow(/does not match/);
    expect(sendNewIsolated).not.toHaveBeenCalled();
  });

  it("replays status without launching: running, then idle with a bounded reply preview", async () => {
    const live = setup({ liveRun: vi.fn(() => "key") });
    const replay = grant({ mode: "replay", sessionId: "created", state: "running" });
    expect(await live.handler(request(replay))).toMatchObject({ status: "running", replayed: true });
    expect(live.sendNewIsolated).not.toHaveBeenCalled();

    const done = setup({ loadPage: vi.fn(async () => ({ nextBefore: null, messages: [row(1, "user", "task"), row(2, "assistant", "Done: fixed"), row(3, "tool", "x")] })) });
    expect(await done.handler(request(replay))).toMatchObject({ status: "idle", resultPreview: "Done: fixed", replayed: true });
    expect(await done.handler(request(grant({ mode: "replay", state: "failed", error: "nothing was sent" }))))
      .toEqual({ requestId: "req-1", status: "failed", error: "nothing was sent", replayed: true });
    expect(await done.handler(request(grant({ mode: "replay" })))).toEqual({ requestId: "req-1", status: "starting", replayed: true });
  });

  it("bounds the preview and skips live or empty assistant rows", () => {
    const long = "字".repeat(2500);
    expect(latestReplyPreview([row(1, "assistant", long), row(2, "assistant", "partial", true)]))
      .toEqual({ text: "字".repeat(2000), truncated: true });
    expect(latestReplyPreview([row(1, "user", "hi"), row(2, "assistant", "  ")])).toBeNull();
  });

  it("binds asynchronously announced session ids and renames after start resolves", async () => {
    let listener: ((events: EngineEventPayload[]) => void) | undefined;
    const unlisten = vi.fn();
    const { handler, report, rename } = setup({
      listen: vi.fn(async (cb) => { listener = cb; return unlisten; }),
      sendNewIsolated: vi.fn(async (_e, _ws, _p, runId) => ({ runId, sessionId: null })),
    });
    const result = await handler(request(grant(), { title: "Async title" }));
    expect(result).toEqual({ requestId: "req-1", status: "starting", replayed: false });
    expect(report).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled();

    listener?.([{ runId: "run-reserved", sessionId: "async-created", engine: "codex", seq: 1, kind: "session", data: null }]);
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith("run-reserved", "running", "async-created", null);
    expect(rename).toHaveBeenCalledWith("codex", "async-created", "Async title");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("uses session announced before sendNewIsolated resolves", async () => {
    let listener: ((events: EngineEventPayload[]) => void) | undefined;
    const unlisten = vi.fn();
    const { handler, report, rename } = setup({
      listen: vi.fn(async (cb) => { listener = cb; return unlisten; }),
      sendNewIsolated: vi.fn(async (_e, _ws, _p, runId) => {
        listener?.([{ runId: "run-reserved", sessionId: "early-created", engine: "codex", seq: 1, kind: "session", data: null }]);
        return { runId, sessionId: null };
      }),
    });
    const result = await handler(request(grant(), { title: "Early title" }));
    expect(result).toEqual({
      requestId: "req-1",
      status: "running",
      replayed: false,
      session: { engine: "codex", session_id: "early-created", workspace_path: "G:/target" },
    });
    expect(report).toHaveBeenCalledWith("run-reserved", "running", "early-created", null);
    expect(rename).toHaveBeenCalledWith("codex", "early-created", "Early title");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
