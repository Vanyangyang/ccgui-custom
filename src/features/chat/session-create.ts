import { invoke } from "@/lib/transport";
import { ipc, type Message } from "@/lib/ipc";
import { desktopTaskFacade, TaskPreSpawnError, type HostTaskFacade, type TaskLaunchChoices, type TaskSessionRef } from "@/features/plugins/runtime/task-facade";
import { sameTaskPath } from "@/features/plugins/runtime/task-paths";

/** Native admission attached by the relay; tool arguments cannot supply it. */
export interface SessionSpawnGrant {
  mode: "start" | "replay";
  runId: string;
  requestId: string;
  engine: string;
  workspacePath: string;
  sessionId: string | null;
  state: string;
  error: string | null;
}

export interface SessionCreateRequest {
  requestId: string;
  sender: { runId: string; engine: string; sessionId: string | null; workspacePath: string };
  method: string;
  arguments: Record<string, unknown>;
  sessionSpawn?: SessionSpawnGrant;
}

export type SessionCreateStatus = "starting" | "running" | "idle" | "failed" | "unknown";

export interface SessionCreateResult {
  requestId: string;
  status: SessionCreateStatus;
  session?: { engine: string; session_id: string; workspace_path: string };
  resultPreview?: string;
  resultTruncated?: boolean;
  error?: string;
  replayed: boolean;
}

export interface SessionCreateDeps {
  facade: () => Promise<Pick<HostTaskFacade, "ready" | "engines" | "workspaces" | "liveRun" | "settledRun" | "loadPage"> & Partial<Pick<HostTaskFacade, "sendNewIsolated" | "listen">>>;
  report: (runId: string, state: "running" | "failed" | "unknown", sessionId: string | null, error: string | null) => Promise<void>;
  rename: (engine: string, sessionId: string, title: string) => Promise<void>;
  isActive: () => boolean;
}

const PREVIEW_CHARS = 2000;
const SESSION_ANNOUNCE_TIMEOUT_MS = 120_000;

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
};

/** The same host wrapper as cross-session messages: the new chat sees which
 *  chat created it, and the sidebar title is derived from the task text. */
export function sessionCreatePrompt(sender: { engine: string; sessionId: string }, message: string): string {
  return `[Message from CC GUI ${JSON.stringify({ engine: sender.engine, session_id: sender.sessionId, origin: "session_create" })}]\n\n${message}`;
}

/** Latest assistant reply text, bounded; tool/thinking rows are skipped. */
export function latestReplyPreview(messages: readonly Message[]): { text: string; truncated: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row.role !== "assistant" || row.live || !row.text?.trim()) continue;
    const chars = Array.from(row.text.trim());
    return { text: chars.slice(0, PREVIEW_CHARS).join(""), truncated: chars.length > PREVIEW_CHARS };
  }
  return null;
}

export function createSessionCreateHandler(deps: SessionCreateDeps) {
  let disposed = false;
  const pending = new Set<() => void>();
  const isActive = () => !disposed && deps.isActive();
  const assertActive = () => { if (!isActive()) throw new Error("Desktop chat host is no longer active"); };

  async function status(grant: SessionSpawnGrant, replayed: boolean): Promise<SessionCreateResult> {
    const base = { requestId: grant.requestId, replayed };
    if (grant.state === "failed") return { ...base, status: "failed", ...(grant.error ? { error: grant.error } : {}) };
    if (grant.state === "unknown") return {
      ...base, status: "unknown",
      ...(grant.sessionId ? { session: { engine: grant.engine, session_id: grant.sessionId, workspace_path: grant.workspacePath } } : {}),
      ...(grant.error ? { error: grant.error } : {}),
    };
    if (!grant.sessionId) {
      return { ...base, status: "starting" };
    }
    const session = { engine: grant.engine, session_id: grant.sessionId, workspace_path: grant.workspacePath };
    const facade = await deps.facade();
    assertActive();
    if (facade.liveRun(grant.runId)) return { ...base, status: "running", session };
    const ref: TaskSessionRef = { engine: grant.engine, sessionId: grant.sessionId, workspacePath: grant.workspacePath };
    const settled = facade.settledRun(grant.runId, ref);
    let preview: { text: string; truncated: boolean } | null = null;
    try { preview = latestReplyPreview((await facade.loadPage(ref, 20, null)).messages); } catch { /* history unavailable */ }
    assertActive();
    return {
      ...base, status: settled?.status === "failed" ? "failed" : "idle", session,
      ...(settled?.error ? { error: settled.error } : {}),
      ...(preview ? { resultPreview: preview.text, ...(preview.truncated ? { resultTruncated: true } : {}) } : {}),
    };
  }

  async function start(request: SessionCreateRequest, grant: SessionSpawnGrant): Promise<SessionCreateResult> {
    const args = request.arguments;
    const message = typeof args.message === "string" ? args.message : "";
    if (!message.trim()) throw new Error("message must be nonblank");
    const model = optionalString(args.model, "model");
    const effort = optionalString(args.effort, "effort");
    const title = optionalString(args.title, "title");
    const senderSession = request.sender.sessionId;
    let unlisten: (() => void) | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const stopListen = () => {
      pending.delete(stopListen);
      if (waitTimer !== undefined) {
        clearTimeout(waitTimer);
        waitTimer = undefined;
      }
      if (unlisten) {
        const fn = unlisten;
        unlisten = undefined;
        fn();
      }
    };
    pending.add(stopListen);
    try {
      if (!senderSession) throw new TaskPreSpawnError("The creating chat has no saved session id");
      const facade = await deps.facade();
      await facade.ready();
      assertActive();
      if (!facade.sendNewIsolated) throw new TaskPreSpawnError("Independent chat start is unavailable in this host");
      const workspace = facade.workspaces().find(w => sameTaskPath(w.path, grant.workspacePath));
      if (!workspace || workspace.remote || workspace.archived) throw new TaskPreSpawnError("WORKSPACE_UNAVAILABLE: workspace_path must be a registered, local, non-archived workspace");
      const engine = facade.engines().find(e => e.id === grant.engine);
      if (!engine?.available || !engine.enabled) throw new TaskPreSpawnError(`ENGINE_UNAVAILABLE: engine ${grant.engine} is not installed or enabled`);
      const launch: TaskLaunchChoices = {
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        defaultModel: engine.defaultModel ?? null,
        defaultEffort: grant.engine === "agy" ? null : engine.defaultEffort ?? null,
        defaultProvider: engine.defaultProvider ?? null,
      };
      const prompt = sessionCreatePrompt({ engine: request.sender.engine, sessionId: senderSession }, message);
      if (prompt.length > 131_072) throw new TaskPreSpawnError("Attributed message exceeds host prompt limit");

      let announcedSessionId: string | null = null;
      let spawnSettled = false;
      let bound = false;
      const bindAsyncSession = (sid: string) => {
        if (bound || !isActive()) {
          stopListen();
          return;
        }
        bound = true;
        stopListen();
        void deps.report(grant.runId, "running", sid, null).catch(() => {});
        // The saved row appears after the first history scan; rename waits for it.
        if (title && isActive()) void deps.rename(grant.engine, sid, title).catch(() => {});
      };
      if (facade.listen) {
        unlisten = await facade.listen((events) => {
          if (!isActive()) return;
          for (const ev of events) {
            if (ev.runId !== grant.runId) continue;
            if (ev.kind === "session" && typeof ev.sessionId === "string" && ev.sessionId) {
              announcedSessionId = ev.sessionId;
              if (spawnSettled) {
                bindAsyncSession(ev.sessionId);
                return;
              }
            } else if (ev.kind === "done" || ev.kind === "error") {
              if (typeof ev.sessionId === "string" && ev.sessionId) {
                announcedSessionId ||= ev.sessionId;
                if (spawnSettled) {
                  bindAsyncSession(announcedSessionId);
                  return;
                }
              } else if (spawnSettled) {
                stopListen();
                return;
              }
            }
          }
        }).catch(() => undefined);
        if (!isActive()) {
          stopListen();
          throw new TaskPreSpawnError("Desktop chat host is no longer active; nothing was sent");
        }
      }

      const ack = await facade.sendNewIsolated(grant.engine, workspace.path, prompt, grant.runId, launch, async () => {
        if (!isActive()) throw new TaskPreSpawnError("Desktop chat host is no longer active; nothing was sent");
      });
      if (ack.runId !== grant.runId) throw Object.assign(new Error("Independent chat run identity was not acknowledged"), { outcomeUnknown: true });
      const resolvedId = ack.sessionId || announcedSessionId;
      if (resolvedId) {
        bound = true;
        stopListen();
        const session = { engine: grant.engine, session_id: resolvedId, workspace_path: workspace.path };
        if (isActive()) await deps.report(grant.runId, "running", resolvedId, null);
        // The saved row appears after the first history scan; rename waits for it.
        if (title && isActive()) void deps.rename(grant.engine, resolvedId, title).catch(() => {});
        return { requestId: grant.requestId, status: "running", session, replayed: false };
      }
      if (unlisten && isActive()) {
        spawnSettled = true;
        waitTimer = setTimeout(stopListen, SESSION_ANNOUNCE_TIMEOUT_MS);
      } else {
        stopListen();
      }
      return { requestId: grant.requestId, status: "starting", replayed: false };
    } catch (error) {
      stopListen();
      const text = error instanceof Error ? error.message : String(error);
      // TaskPreSpawnError is the host's proof that no native send happened.
      const nothingSent = error instanceof TaskPreSpawnError;
      if (isActive()) await deps.report(grant.runId, nothingSent ? "failed" : "unknown", null, text).catch(() => {});
      if (nothingSent) throw new Error(text);
      throw new Error(`session_create outcome is unknown: ${text}. Call session_create again with the same request_id to read its status.`);
    }
  }

  const handle = async (request: SessionCreateRequest): Promise<SessionCreateResult> => {
    if (request.method !== "session_create") throw new Error("Unknown session create method");
    const grant = request.sessionSpawn;
    if (!grant || (grant.mode !== "start" && grant.mode !== "replay")) throw new Error("Native session_create admission is missing");
    if (typeof args(request).request_id !== "string" || args(request).request_id !== grant.requestId) {
      throw new Error("session_create admission does not match its request");
    }
    assertActive();
    return grant.mode === "replay" ? status(grant, true) : start(request, grant);
  };
  // Disposal releases frontend observers only; an already submitted native run
  // remains owned by the host and must never be cancelled or resent here.
  return Object.assign(handle, { dispose() {
    disposed = true;
    for (const stop of pending) stop();
  } });
}

const args = (request: SessionCreateRequest) => request.arguments;

/** Native dependencies of the desktop owner; `isActive` belongs to its runtime. */
export function desktopSessionCreateDeps(isActive: () => boolean): SessionCreateDeps {
  return {
    facade: desktopTaskFacade,
    report: async (runId, state, sessionId, error) => { await invoke("session_spawn_report", { runId, state, sessionId, error }); },
    rename: async (engine, sessionId, title) => {
      // rename_session only updates an existing saved row; the first history
      // scan creates it shortly after the first turn starts. Bounded wait.
      for (let attempt = 0; attempt < RENAME_ATTEMPTS && isActive(); attempt++) {
        const rows = await ipc.listSessions().catch(() => null);
        if (!isActive()) return;
        if (rows?.some(row => row.engine === engine && row.sessionId === sessionId)) {
          const { useChatStore } = await import("@/features/chat/store");
          if (!isActive()) return;
          await useChatStore.getState().renameSession(engine, sessionId, title);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, RENAME_INTERVAL_MS));
      }
    },
    isActive,
  };
}
const RENAME_ATTEMPTS = 40;
const RENAME_INTERVAL_MS = 3000;
