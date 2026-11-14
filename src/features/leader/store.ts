import { create } from "zustand";
import { invoke, isWeb } from "@/lib/transport";
import { errorText } from "@/lib/errors";
import i18n from "@/lib/i18n";
import { archivedBranchIds, archivedGroupBranches, isDirectChild, leaderBranchSubtree, leaderGroupRoot, leaderGroupBranches, parentWorkspacePath, sameIdentity, type GroupCleanupExpectation, type LeaderBranch, type LeaderIdentity, type LeaderSnapshot } from "./types";
import { useChatStore, sessionKey } from "@/features/chat/store";
import { ipc } from "@/lib/ipc";
import { removeLeaderSessions } from "./session-cleanup";
import { sameLeaderWorkspace } from "./workspace-path";

interface LeaderStore {
  snapshot: LeaderSnapshot;
  error: string | null;
  managing: LeaderIdentity | null;
  deletingBranch: { parent: LeaderIdentity; branchId: string } | null;
  busy: boolean;
  refresh: () => Promise<void>;
  act: (parent: LeaderIdentity, branchId: string, action: "stop" | "renew" | "reclaim", ttlSeconds?: number) => Promise<LeaderBranch>;
  /** Restore and delete also accept a child-rooted archive record's root. */
  groupAction: (root: LeaderIdentity, action: "archive" | "restore" | "delete", expected?: GroupCleanupExpectation) => Promise<void>;
  /** Cleanup archive of one expired child subtree; its parent stays live. */
  archiveSubtree: (parent: LeaderIdentity, branchId: string, expected: GroupCleanupExpectation) => Promise<void>;
  deleteBranch: (parent: LeaderIdentity, branchId: string, expectedBranchIds?: string[]) => Promise<void>;
}

/** Shared menu/dialog/submit guards; the native command remains authoritative. */
export function branchDeletionState(snapshot: LeaderSnapshot, branchId: string, chat = useChatStore.getState()) {
  const branches = leaderBranchSubtree(snapshot, branchId);
  const members = branches.flatMap((b) => b.sessionId ? [{ engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath }] : []);
  const archived = archivedBranchIds(snapshot);
  const available = !isWeb && branches.length > 0 && !branches.some((b) => archived.has(b.id))
    && !members.some((m) => chat.archivedSessionKeys[sessionKey(m.engine, m.sessionId, m.workspacePath)] || chat.sessions.some((s) => sameIdentity(s, m) && s.remote));
  const active = branches.some((b) => ["starting", "running", "waiting", "awaiting_cost_approval", "reclaiming"].includes(b.state)) || members.some((m) => {
    const key = sessionKey(m.engine, m.sessionId, m.workspacePath), session = chat.bySession[key];
    return chat.streamingByKey[key] || chat.retryingByKey[key] || (session && (session.streaming || session.draftLaunching || session.queue.length > 0 || session.messages.some((message) =>
      message.question?.status === "pending" || message.grant?.status === "pending" || ["awaiting_review", "deferred", "submitting"].includes(message.planReview?.status ?? ""))));
  });
  return { branches, members, available, active: !!active };
}

let revision = 0;
export const useLeaderStore = create<LeaderStore>((set, get) => ({
  snapshot: { leaders: [], branches: [] }, error: null, managing: null, deletingBranch: null, busy: false,
  refresh: async () => {
    const ticket = ++revision;
    try {
      const snapshot = await invoke<LeaderSnapshot>("task_snapshot", {});
      if (ticket === revision) set({ snapshot, error: null });
    } catch (error) { if (ticket === revision) set({ error: errorText(error) }); }
  },
  act: async (parent, branchId, action, ttlSeconds) => {
    if (get().busy) throw new Error(i18n.t("leader.busy"));
    const branch = get().snapshot.branches.find((b) => b.id === branchId);
    if (!branch || !isDirectChild(branch, parent)) { const error = i18n.t("leader.parentOnly"); set({ error }); throw new Error(error); }
    ++revision;
    set({ busy: true, error: null });
    try {
      const result = await invoke<LeaderBranch>("task_branch_action", {
        parentEngine: parent.engine, parentSessionId: parent.sessionId,
        workspacePath: parent.workspacePath, branchId, action, ...(ttlSeconds == null ? {} : { ttlSeconds }),
      });
      ++revision;
      // Keep reclaimed in this notification so the runtime can clean caches,
      // then reconcile the entire descendant subtree with the native snapshot.
      set((s) => {
        const removed = new Set<string>();
        if (result.state === "reclaimed") {
          removed.add(branchId);
          let changed = true;
          while (changed) {
            changed = false;
            for (const candidate of s.snapshot.branches) {
              if (removed.has(candidate.id)) continue;
              if (s.snapshot.branches.some((parent) => removed.has(parent.id) && parent.sessionId &&
                parent.engine === candidate.parentEngine && parent.sessionId === candidate.parentSessionId && sameLeaderWorkspace(parent.workspacePath, parentWorkspacePath(candidate)))) {
                removed.add(candidate.id); changed = true;
              }
            }
          }
        }
        return { snapshot: { ...s.snapshot, branches: s.snapshot.branches
          .filter((b) => b.id === branchId || !removed.has(b.id))
          .map((b) => b.id === branchId ? result : b) } };
      });
      await get().refresh();
      return result;
    } catch (error) { set({ error: errorText(error) }); throw error; }
    finally { set({ busy: false }); }
  },
  deleteBranch: async (parent, branchId, expectedBranchIds) => {
    if (get().busy) throw new Error(i18n.t("leader.busy"));
    const before = branchDeletionState(get().snapshot, branchId);
    const expected = expectedBranchIds ?? before.branches.map((b) => b.id);
    ++revision;
    set({ busy: true, error: null });
    let affected = before.branches;
    const reconcile = (snapshot: LeaderSnapshot) => {
      const reclaimed = affected.filter((b) => snapshot.branches.some((current) => current.id === b.id && current.state === "reclaimed"));
      removeLeaderSessions(reclaimed.flatMap((b) => b.sessionId ? [{ engine: b.engine, sessionId: b.sessionId, workspacePath: b.workspacePath }] : []), reclaimed, true);
      ++revision; set({ snapshot });
    };
    try {
      const snapshot = await invoke<LeaderSnapshot>("task_snapshot", {});
      ++revision; set({ snapshot });
      const current = branchDeletionState(snapshot, branchId);
      if (!current.available || !isDirectChild(current.branches[0], parent)) throw new Error(i18n.t("leader.deleteBranchUnavailable"));
      if (current.active) throw new Error(i18n.t("leader.deleteBranchIdle"));
      if (current.branches.length !== expected.length || current.branches.some((b) => !expected.includes(b.id))) throw new Error(i18n.t("leader.deleteBranchChanged"));
      affected = current.branches;
      const result = await invoke<LeaderSnapshot>("task_delete_branch", {
        parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: parent.workspacePath, branchId, expectedBranchIds: expected,
      });
      reconcile(result);
      set({ deletingBranch: null });
    } catch (error) {
      try { reconcile(await invoke<LeaderSnapshot>("task_snapshot", {})); } catch { /* Preserve the original error and all unconfirmed survivors. */ }
      set({ error: errorText(error) }); throw error;
    } finally { set({ busy: false }); }
  },
  groupAction: async (root, action, expected) => {
    if (get().busy) throw new Error(i18n.t("leader.busy"));
    if (expected && action !== "archive") throw new Error("Cleanup expectations apply only to archive");
    const archivedRecord = action !== "archive" && get().snapshot.archivedGroups?.some((group) => sameIdentity(group.root, root));
    if (!archivedRecord && !sameIdentity(root, leaderGroupRoot(get().snapshot, root))) {
      const error = i18n.t("leader.rootOnly"); set({ error }); throw new Error(error);
    }
    ++revision;
    set({ busy: true, error: null });
    const before = get().snapshot;
    const archived = before.archivedGroups?.find((group) => sameIdentity(group.root, root));
    const branches = archived ? archivedGroupBranches(before, archived) : leaderGroupBranches(before, root);
    const members = [root, ...(archived?.members ?? branches.flatMap((branch) => branch.sessionId ? [{ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath }] : []))];
    try {
      const snapshot = expected
        ? await invoke<LeaderSnapshot>("task_group_archive_checked", { ...root, expected })
        : await invoke<LeaderSnapshot>("task_group_action", { ...root, action });
      ++revision;
      if (action !== "restore") {
        // The native transaction may have committed a newer complete group
        // than the snapshot used to start the action.
        const committed = action === "archive" ? snapshot.archivedGroups?.find((group) => sameIdentity(group.root, root)) : undefined;
        if (expected && !committed) {
          set({ snapshot });
          throw new Error("CLEANUP_GROUP_CHANGED: Task group archive was not present in the returned snapshot");
        }
        const committedBranches = committed ? archivedGroupBranches(snapshot, committed) : branches;
        removeLeaderSessions(committed?.members ?? members, committedBranches, action === "delete", action === "archive");
      }
      set({ snapshot });
      if (action === "restore") {
        useChatStore.setState((s) => {
          const archivedSessionKeys = { ...s.archivedSessionKeys };
          for (const member of members) delete archivedSessionKeys[sessionKey(member.engine, member.sessionId, member.workspacePath)];
          return { archivedSessionKeys };
        });
        await ipc.rescanSessions();
        await useChatStore.getState().refreshSessions();
      }
    } catch (error) {
      if (action === "delete") {
        // Transcript deletion may have partially committed. Reconcile its
        // durable marker without retrying or disguising the original failure.
        const ticket = ++revision;
        try {
          const snapshot = await invoke<LeaderSnapshot>("task_snapshot", {});
          if (snapshot.archivedGroups?.some((group) => sameIdentity(group.root, root))) {
            // Some real deletes may already have cleared their ordinary
            // archive rows. Close the original complete group as an archive,
            // without permanently retiring records that survived the failure.
            removeLeaderSessions(members, branches, false);
          }
          if (ticket === revision) set({ snapshot });
        } catch { /* Keep the original delete failure visible if reconciliation also fails. */ }
      }
      set({ error: errorText(error) }); throw error;
    }
    finally { set({ busy: false }); }
  },
  archiveSubtree: async (parent, branchId, expected) => {
    if (get().busy) throw new Error(i18n.t("leader.busy"));
    ++revision;
    set({ busy: true, error: null });
    try {
      const snapshot = await invoke<LeaderSnapshot>("task_subtree_archive_checked", {
        parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: parent.workspacePath, branchId, expected,
      });
      ++revision;
      const top = snapshot.branches.find((branch) => branch.id === branchId);
      const committed = top?.sessionId ? snapshot.archivedGroups?.find((group) => sameIdentity(group.root, {
        engine: top.engine, sessionId: top.sessionId!, workspacePath: top.workspacePath,
      })) : undefined;
      if (!committed) {
        set({ snapshot });
        throw new Error("CLEANUP_GROUP_CHANGED: Child task archive was not present in the returned snapshot");
      }
      // Clear exactly what the native transaction committed, including any
      // nested archive it absorbed.
      removeLeaderSessions(committed.members, archivedGroupBranches(snapshot, committed), false, true);
      set({ snapshot });
    } catch (error) { set({ error: errorText(error) }); throw error; }
    finally { set({ busy: false }); }
  },
}));

export function manageLeader(parent: LeaderIdentity) {
  useLeaderStore.setState({ managing: parent, error: null });
  void useLeaderStore.getState().refresh();
}
