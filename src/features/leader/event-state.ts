// Leaf state shared by event adoption and the runtime. No chat-store import:
// events can beat the first snapshot and must never borrow a user's draft.
const reclaimedBranches = new Set<string>();
const reclaimedSessions = new Set<string>();
const hydrationNeeded = new Set<string>();
const assignmentSeen = new Set<string>();
const managedSessions = new Set<string>();

export function leaderEventAllowed(branchId: string, key: string) {
  return !reclaimedBranches.has(branchId) && !reclaimedSessions.has(key);
}
export function isReclaimedLeaderSession(key: string) { return reclaimedSessions.has(key); }
export function rememberLeaderSession(key: string) { managedSessions.add(key); }
export function isManagedLeaderSession(key: string) { return managedSessions.has(key); }
export function markLeaderSession(key: string) { hydrationNeeded.add(key); }
export function needsLeaderHistory(key: string) { return hydrationNeeded.has(key); }
export function leaderHistoryLoaded(key: string) { hydrationNeeded.delete(key); }
export function claimLeaderAssignment(key: string) {
  if (assignmentSeen.has(key)) return false;
  assignmentSeen.add(key);
  return true;
}
export function retireLeaderBranch(id: string, key?: string) {
  reclaimedBranches.add(id);
  if (key) { reclaimedSessions.add(key); hydrationNeeded.delete(key); }
}

type LeaderStreamObserver = (branchId: string, delta: string) => void;
const streamObservers = new Set<LeaderStreamObserver>();
export function subscribeLeaderStream(cb: LeaderStreamObserver): () => void {
  streamObservers.add(cb);
  return () => { streamObservers.delete(cb); };
}
export function emitLeaderStreamDelta(branchId: string, delta: string) {
  if (reclaimedBranches.has(branchId) || !delta) return;
  for (const cb of streamObservers) cb(branchId, delta);
}
