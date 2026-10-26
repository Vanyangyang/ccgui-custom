import type { HostTaskStatus } from "@ccgui/plugin-sdk";
import { plausibleSessionId, type TaskSessionRef } from "./task-facade";
import { normalizeTaskWritePaths, sameTaskPath, type TaskWriteScope } from "./task-paths";

export interface PersistedTaskClaim extends TaskWriteScope {
  pluginId: string;
  requestId: string;
  runId: string;
  session: TaskSessionRef | null;
  status: HostTaskStatus;
  sessionProven?: boolean;
  identityMismatch?: boolean;
  cancelRequested?: boolean;
}

/** The native scan returns lock metadata from every retained owner, including
 * disabled/uninstalled plugins. Malformed metadata must block admission rather
 * than silently omit an unresolved write claim. */
export function decodePersistedTaskClaims(value: unknown): PersistedTaskClaim[] {
  const invalid = () => new Error("Could not restore persisted task write claims");
  if (!Array.isArray(value) || value.length > 8192) throw invalid();
  const ids = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object") throw invalid();
    const r = raw as Record<string, unknown>;
    if (typeof r.pluginId !== "string" || !r.pluginId || r.pluginId.length > 256 || /[\u0000-\u001f]/.test(r.pluginId) ||
      typeof r.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.requestId) ||
      typeof r.workspacePath !== "string" || !r.workspacePath.trim() || r.workspacePath.length > 4096 ||
      typeof r.runId !== "string" || r.runId.length > 256 || r.status !== "unknown") throw invalid();
    const id = `${r.pluginId}\u0000${r.requestId}`;
    if (ids.has(id)) throw invalid();
    ids.add(id);
    const writePaths = normalizeTaskWritePaths(r.writePaths === null ? undefined : r.writePaths as string[], r.workspacePath);
    let session: TaskSessionRef | null = null;
    let identityMismatch = r.identityMismatch === true;
    if (r.session != null) {
      const ref = r.session as Partial<TaskSessionRef>;
      if (typeof ref.engine !== "string" || typeof ref.sessionId !== "string" || typeof ref.workspacePath !== "string" ||
        !plausibleSessionId(ref.engine, ref.sessionId) || !sameTaskPath(ref.workspacePath, r.workspacePath)) {
        identityMismatch = true;
      } else session = { engine: ref.engine, sessionId: ref.sessionId, workspacePath: ref.workspacePath };
    }
    return { pluginId: r.pluginId, requestId: r.requestId, runId: r.runId, workspacePath: r.workspacePath,
      writePaths, session, status: "unknown", sessionProven: r.sessionProven === true,
      identityMismatch, cancelRequested: r.cancelRequested === true };
  });
}
