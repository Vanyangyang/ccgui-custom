import { listen } from "@/lib/transport";
import {
  crossSessionParticipantKey,
  useCrossSessionActivityStore,
  type CrossSessionCommunicationRecord,
  type CrossSessionCommunicationStatus,
} from "@/features/chat/cross-session";
import { useChatStore } from "@/features/chat/store";
import { subscribeLeaderStream } from "./event-state";
import { removeLeaderSessions } from "./session-cleanup";
import { useLeaderStore } from "./store";
import type { LeaderBranch, LeaderSnapshot } from "./types";
import { sameLeaderWorkspace } from "./workspace-path";

function removeReclaimed(branches: LeaderBranch[]) {
  removeLeaderSessions(branches.flatMap((branch) => branch.sessionId ? [{ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath }] : []), branches, true);
}

function branchToCommsStatus(state: LeaderBranch["state"]): CrossSessionCommunicationStatus | null {
  switch (state) {
    case "starting":
      return "received";
    case "running":
      return "executing";
    case "waiting":
      return "awaiting_permission";
    case "completed":
      return "completed";
    case "failed":
    case "stopped":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

export function syncLeaderBranchComms(
  snapshot: LeaderSnapshot,
  options?: { markInitialTerminalReviewed?: boolean },
) {
  const archivedIds = new Set((snapshot.archivedGroups ?? []).flatMap((group) => group.branchIds));
  const activeBranches = snapshot.branches.filter(
    (b) => b.state !== "reclaimed" && b.state !== "reclaiming" && !archivedIds.has(b.id),
  );
  const store = useCrossSessionActivityStore.getState();
  const sessions = useChatStore.getState().sessions;
  const existingById = new Map(store.records.map((r) => [r.scopedId, r]));
  const validScopedIds = new Set<string>();

  for (const branch of activeBranches) {
    const status = branchToCommsStatus(branch.state);
    if (!status) continue;
    const scopedId = `leader:${branch.id}`;
    validScopedIds.add(scopedId);
    const existing = existingById.get(scopedId);
    const parentMeta = sessions.find(
      (s) => s.engine === branch.parentEngine && s.sessionId === branch.parentSessionId && sameLeaderWorkspace(s.workspacePath, branch.workspacePath),
    );
    const childMeta = branch.sessionId
      ? sessions.find((s) => s.engine === branch.engine && s.sessionId === branch.sessionId && sameLeaderWorkspace(s.workspacePath, branch.workspacePath))
      : undefined;
    const sender = {
      engine: branch.parentEngine,
      sessionId: branch.parentSessionId,
      workspacePath: branch.workspacePath,
      title: parentMeta?.customTitle || parentMeta?.title || undefined,
    };
    const target = {
      engine: branch.engine,
      sessionId: branch.sessionId ?? `leader-branch:${branch.id}`,
      workspacePath: branch.workspacePath,
      title: childMeta?.customTitle || childMeta?.title || branch.title,
    };
    const isTerminal = status === "completed" || status === "failed" || status === "unknown";
    const initialReviewed =
      !existing && options?.markInitialTerminalReviewed && isTerminal
        ? [crossSessionParticipantKey(sender), crossSessionParticipantKey(target)]
        : undefined;
    const acceptedAt =
      existing && existing.runId === (branch.runId ?? undefined)
        ? existing.acceptedAt
        : branch.createdAt || branch.updatedAt || Date.now();
    const replyText =
      branch.result ||
      (status === "executing" && existing && existing.runId === (branch.runId ?? undefined)
        ? existing.replyText
        : undefined);
    const record: CrossSessionCommunicationRecord = {
      scopedId,
      requestId: branch.id,
      runId: branch.runId ?? undefined,
      kind: "subtask",
      sender,
      target,
      message: branch.task || branch.title,
      status,
      replyText,
      truncated: branch.resultTruncated || undefined,
      error: branch.error ?? undefined,
      acceptedAt,
      updatedAt: branch.updatedAt || branch.lastActivityAt || acceptedAt,
      ...(initialReviewed ? { reviewedBy: initialReviewed } : {}),
    };
    store.upsertRecord(record);
  }

  const staleIds = store.records
    .filter((r) => r.scopedId.startsWith("leader:") && !validScopedIds.has(r.scopedId))
    .map((r) => r.scopedId);
  if (staleIds.length) {
    store.removeRecords(staleIds);
  }
}

export function startLeaderRuntime() {
  let disposed = false;
  const offEvents: Array<() => void> = [];
  let known = useLeaderStore.getState().snapshot.branches;
  let knownArchived = useLeaderStore.getState().snapshot.archivedGroups;
  let initialSnapshotHydrated = known.length > 0;
  if (initialSnapshotHydrated) {
    syncLeaderBranchComms(useLeaderStore.getState().snapshot, { markInitialTerminalReviewed: true });
  }
  const offStore = useLeaderStore.subscribe((s) => {
    const next = s.snapshot.branches;
    const nextArchived = s.snapshot.archivedGroups;
    if (next === known && nextArchived === knownArchived) return;
    const isFirstHydration = !initialSnapshotHydrated && known.length === 0;
    initialSnapshotHydrated = true;
    syncLeaderBranchComms(s.snapshot, { markInitialTerminalReviewed: isFirstHydration });
    if (next === known) {
      knownArchived = nextArchived;
      return;
    }
    // Archival hides a retained group; it must never permanently retire its
    // identities, even while a snapshot is being reconciled.
    const archivedIds = new Set((s.snapshot.archivedGroups ?? []).flatMap((group) => group.branchIds));
    const ids = new Set([...next.filter((b) => b.state !== "reclaimed").map((b) => b.id), ...archivedIds]);
    const reclaimed = new Map(known.filter((branch) => !ids.has(branch.id)).map((branch) => [branch.id, branch]));
    for (const branch of next) if (branch.state === "reclaimed" && !archivedIds.has(branch.id)) reclaimed.set(branch.id, branch);
    known = next;
    knownArchived = nextArchived;
    removeReclaimed([...reclaimed.values()]);
  });
  const offStream = subscribeLeaderStream((branchId, delta) => {
    if (disposed) return;
    const scopedId = `leader:${branchId}`;
    const store = useCrossSessionActivityStore.getState();
    const existing = store.records.find((r) => r.scopedId === scopedId);
    if (!existing || (existing.status !== "executing" && existing.status !== "received")) return;
    store.upsertRecord({
      ...existing,
      status: "executing",
      replyText: `${existing.replyText ?? ""}${delta}`,
      updatedAt: Date.now(),
    });
  });
  const refresh = () => { if (!disposed) void useLeaderStore.getState().refresh(); };
  for (const event of ["task://changed", "transport://connected"]) {
    void listen(event, refresh)
      .then((off) => {
        if (disposed) off();
        else { offEvents.push(off); if (event === "task://changed") refresh(); }
      })
      .catch((error) => { if (!disposed) useLeaderStore.setState({ error: String(error) }); });
  }
  return () => { disposed = true; offStream(); offEvents.forEach((off) => off()); offStore(); };
}
