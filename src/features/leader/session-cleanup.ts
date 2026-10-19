import { useChatStore, sessionKey } from "@/features/chat/store";
import { persistTabs } from "@/features/chat/store/persistence";
import { activateChatTab } from "@/features/chat/store/tabs";
import { drainPending, runRouting, untrackRun } from "@/features/chat/store/stream";
import { dropRunUsage } from "@/features/chat/store/engine-events";
import { retireLeaderBranch } from "./event-state";
import type { LeaderBranch, LeaderIdentity } from "./types";

/** Close the complete batch before choosing a survivor, so no descendant is
 * activated midway through group removal. Archive markers are reversible;
 * only actual deletion may create permanent event tombstones. */
export function removeLeaderSessions(members: LeaderIdentity[], branches: LeaderBranch[], permanent: boolean) {
  const keys = new Set(members.map((m) => sessionKey(m.engine, m.sessionId, m.workspacePath)));
  if (permanent) {
    for (const branch of branches) retireLeaderBranch(branch.id, branch.sessionId ? sessionKey(branch.engine, branch.sessionId, branch.workspacePath) : undefined);
    for (const member of members) retireLeaderBranch(`leader-session:${JSON.stringify(member)}`, sessionKey(member.engine, member.sessionId, member.workspacePath));
  }
  if (!keys.size) return;
  for (const key of keys) drainPending(key);
  for (const [runId, owner] of runRouting) if (keys.has(owner)) { runRouting.delete(runId); untrackRun(runId); dropRunUsage(runId); }
  const before = useChatStore.getState();
  const removedActive = !!before.active && keys.has(sessionKey(before.active.engine, before.active.sessionId, before.active.workspacePath));
  useChatStore.setState((s) => {
    const bySession = { ...s.bySession }, drafts = { ...s.drafts }, streamingByKey = { ...s.streamingByKey }, retryingByKey = { ...s.retryingByKey }, unseen = { ...s.unseen };
    const archivedSessionKeys = { ...s.archivedSessionKeys };
    for (const key of keys) {
      delete bySession[key]; delete drafts[key]; delete streamingByKey[key]; delete retryingByKey[key]; delete unseen[key];
      archivedSessionKeys[key] = true;
    }
    const openTabs = s.openTabs.filter((t) => !keys.has(sessionKey(t.engine, t.sessionId, t.workspacePath)));
    const active = removedActive ? null : s.active;
    persistTabs(openTabs, active);
    return { bySession, drafts, streamingByKey, retryingByKey, unseen, openTabs, active,
      sessions: s.sessions.filter((meta) => !keys.has(sessionKey(meta.engine, meta.sessionId, meta.workspacePath))), archivedSessionKeys };
  });
  if (removedActive) activateChatTab({ set: useChatStore.setState, get: useChatStore.getState }, useChatStore.getState().openTabs.at(-1) ?? null);
}
