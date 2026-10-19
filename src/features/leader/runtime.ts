import { listen } from "@/lib/transport";
import { removeLeaderSessions } from "./session-cleanup";
import { useLeaderStore } from "./store";
import type { LeaderBranch } from "./types";

function removeReclaimed(branches: LeaderBranch[]) {
  removeLeaderSessions(branches.flatMap((branch) => branch.sessionId ? [{ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath }] : []), branches, true);
}

export function startLeaderRuntime() {
  let disposed = false;
  const offEvents: Array<() => void> = [];
  let known = useLeaderStore.getState().snapshot.branches;
  const offStore = useLeaderStore.subscribe((s) => {
    const next = s.snapshot.branches;
    if (next === known) return;
    // Archival hides a retained group; it must never permanently retire its
    // identities, even while a snapshot is being reconciled.
    const archivedIds = new Set((s.snapshot.archivedGroups ?? []).flatMap((group) => group.branchIds));
    const ids = new Set([...next.filter((b) => b.state !== "reclaimed").map((b) => b.id), ...archivedIds]);
    const reclaimed = new Map(known.filter((branch) => !ids.has(branch.id)).map((branch) => [branch.id, branch]));
    for (const branch of next) if (branch.state === "reclaimed" && !archivedIds.has(branch.id)) reclaimed.set(branch.id, branch);
    known = next;
    removeReclaimed([...reclaimed.values()]);
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
  return () => { disposed = true; offEvents.forEach((off) => off()); offStore(); };
}
