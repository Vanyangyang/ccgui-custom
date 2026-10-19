import type {
  EngineInfo,
  Message,
  SessionMeta,
  WorkspaceGroup,
} from "@/lib/ipc";
import { EMPTY_SESSION, type SessionState } from "./stream";
import { sessionKey } from "./persistence";
import type { ChatStore } from "./types";

/** Sidebar workspace groups (工作区二级分类), ordered by sortOrder then name. */
export function sortedWorkspaceGroups(
  groups: WorkspaceGroup[],
): WorkspaceGroup[] {
  return groups.slice().sort((a, b) => {
    const diff =
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

/** History lists hide sessions of CLIs the user disabled in settings. An
 * empty engines list means listEngines failed — keep sessions rather than
 * blanking the sidebar. */
export function visibleSessions(
  sessions: SessionMeta[],
  engines: EngineInfo[],
): SessionMeta[] {
  if (engines.length === 0) return sessions;
  const enabled = new Set<string>();
  for (const e of engines) {
    if (e.enabled) enabled.add(e.id);
  }
  return sessions.filter((s) => enabled.has(s.engine));
}

/** Merge plugin-sourced external sessions under the local scan: local wins
 *  on the same engine/sessionId/workspacePath, rows outside registered
 *  workspaces are dropped (the sidebar groups by workspacePath). */
export function mergeExternalSessions(
  local: SessionMeta[],
  external: SessionMeta[],
  workspacePaths: Iterable<string>,
): SessionMeta[] {
  if (external.length === 0) return local;
  const known = new Set(workspacePaths);
  const seen = new Set(
    local.map((s) => sessionKey(s.engine, s.sessionId, s.workspacePath)),
  );
  const extra = external.filter(
    (e) =>
      known.has(e.workspacePath) &&
      !seen.has(sessionKey(e.engine, e.sessionId, e.workspacePath)),
  );
  return extra.length === 0 ? local : [...local, ...extra];
}

/**
 * Keep locally-live sessions a refresh has not caught up to. A new session
 * is upserted optimistically the moment its id is announced, but the scanner
 * only lists it after the CLI flushes the file and a scan completes — a
 * refresh landing in between (window focus, another turn's rescan, the
 * remember-model `sessions_changed` that adopting the id itself triggers)
 * would otherwise wipe the sidebar row until the next manual sync.
 * Locally-live = the session has state in `bySession` (messages, streaming);
 * `deleteSession` removes that state, so deleted rows are never resurrected.
 * Rows the scan ingested always win over the optimistic copy.
 */
export function preserveUnscannedSessions(
  refreshed: SessionMeta[],
  current: SessionMeta[],
  bySession: Record<string, SessionState>,
): SessionMeta[] {
  if (current.length === 0) return refreshed;
  const scanned = new Set(
    refreshed.map((s) => sessionKey(s.engine, s.sessionId, s.workspacePath)),
  );
  const missing = current.filter((s) => {
    const key = sessionKey(s.engine, s.sessionId, s.workspacePath);
    return !scanned.has(key) && bySession[key];
  });
  return missing.length === 0 ? refreshed : [...refreshed, ...missing];
}

/** Append committed timeline rows, assigning seq after the session's last
 * row; `patch` carries any extra per-site session changes. */
export function appendCommittedRows(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  rows: Omit<Message, "seq">[],
  patch: Partial<SessionState> = {},
) {
  set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const lastSeq = prev.messages.length
      ? prev.messages[prev.messages.length - 1].seq
      : 0;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          ...patch,
          messages: [
            ...prev.messages,
            ...rows.map((row, i) => ({ ...row, seq: lastSeq + 1 + i })),
          ],
        },
      },
    };
  });
}
