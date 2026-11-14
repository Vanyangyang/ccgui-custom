import { runRouting, type SessionState } from "./stream";

/** Host task first turns never share a user's workspace draft key. This source
 * identity travels with bySession through the normal runtime checkpoint. */
export interface HostTaskOrigin {
  engine: string;
  workspacePath: string;
  runId: string;
  sessionId?: string;
}

export const hostPendingKey = (engine: string, runId: string) => `new:${engine}:@host-task/${runId}`;

export function pendingHostOrigin(key: string, session: SessionState | undefined): HostTaskOrigin | undefined {
  const origin = session?.hostTaskOrigin;
  return origin && !origin.sessionId && typeof origin.runId === "string" && !!origin.runId &&
    typeof origin.engine === "string" && !!origin.engine && typeof origin.workspacePath === "string" && !!origin.workspacePath &&
    key === hostPendingKey(origin.engine, origin.runId) ? origin : undefined;
}

export const hasPendingHostEngine = (sessions: Record<string, SessionState>, engine: string): boolean =>
  Object.entries(sessions).some(([key, session]) => {
    const origin = pendingHostOrigin(key, session);
    // Parking retains uncertain delivery evidence; it is not a live owner of
    // the engine once the exact run has ended or lost its confirmed route.
    return origin?.engine === engine && !session.settledRunIds?.includes(origin.runId) &&
      (!!session.draftLaunching || session.streaming && runRouting.get(origin.runId) === key);
  });
