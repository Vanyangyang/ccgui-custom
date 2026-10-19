import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { Button } from "@/components/base/buttons/button";
import { Select, SelectItem } from "@/components/base/select/select";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ConfirmDialog } from "@/components/dialogs";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { listenSessionsChanged } from "@/lib/events";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { useLeaderStore } from "@/features/leader/store";
import { isDirectChild, type LeaderArchivedGroup, type LeaderBranch, type LeaderIdentity } from "@/features/leader/types";
import { listen } from "@/lib/transport";

const ALL_WORKSPACES = "*";

const sessionTitle = (session: SessionMeta) =>
  session.customTitle || session.title || session.sessionId.slice(0, 8);

const pathName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path;

/** Settings archive manager: app-owned markers hide sessions without moving
 * native CLI files. The archived snapshot keeps remote/plugin sessions
 * restorable and deletable even though they have no local history row. */
export function ArchivedSessionsSection() {
  const { t, i18n } = useTranslation();
  const workspaces = useChatStore((s) => s.workspaces);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [workspacePath, setWorkspacePath] = useState(ALL_WORKSPACES);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionMeta | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<LeaderArchivedGroup | null>(null);
  const snapshot = useLeaderStore((s) => s.snapshot);
  const leaderBusy = useLeaderStore((s) => s.busy);
  const actionPending = useRef(false);
  const mounted = useRef(false);
  const refreshTicket = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++refreshTicket.current;
    try {
      const [archived] = await Promise.all([ipc.listArchivedSessions(), useLeaderStore.getState().refresh()]);
      if (!mounted.current || ticket !== refreshTicket.current) return;
      if (useLeaderStore.getState().error) throw new Error(useLeaderStore.getState().error!);
      setSessions(archived);
      setError(null);
    } catch (e) {
      if (mounted.current && ticket === refreshTicket.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && ticket === refreshTicket.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void refresh();
    const unlisteners: Array<() => void> = [];
    for (const subscription of [listenSessionsChanged(() => { if (!disposed) void refresh(); }), listen("transport://connected", () => { if (!disposed) void refresh(); })]) {
      void subscription.then((off) => { if (disposed) off(); else unlisteners.push(off); })
        .catch((e) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    }
    return () => {
      disposed = true;
      mounted.current = false;
      ++refreshTicket.current;
      unlisteners.forEach((off) => off());
    };
  }, [refresh]);

  // Building an Intl formatter is slow; do it once per locale, not per row.
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [i18n.language],
  );
  const workspaceLabels = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.path, workspace.name])),
    [workspaces],
  );
  const workspacePaths = useMemo(
    () => [...new Set([...sessions.map((session) => session.workspacePath), ...(snapshot.archivedGroups ?? []).map((group) => group.root.workspacePath)])],
    [sessions, snapshot.archivedGroups],
  );
  const grouped = useMemo(() => {
    const archivedGroups = snapshot.archivedGroups ?? [];
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const memberKeys = new Set(archivedGroups.flatMap((group) => [group.root, ...group.members].map((member) => JSON.stringify([member.engine, member.sessionId, member.workspacePath]))));
    const filtered =
      workspacePath === ALL_WORKSPACES
        ? sessions
        : sessions.filter((session) => session.workspacePath === workspacePath);
    const groups = new Map<string, { sessions: SessionMeta[]; taskGroups: LeaderArchivedGroup[] }>();
    for (const session of filtered) {
      if (memberKeys.has(JSON.stringify([session.engine, session.sessionId, session.workspacePath]))) continue;
      if (
        normalizedQuery &&
        !sessionTitle(session).toLocaleLowerCase().includes(normalizedQuery) &&
        !session.sessionId.toLocaleLowerCase().includes(normalizedQuery) &&
        !`${session.engine}/${session.sessionId}`.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      const list = groups.get(session.workspacePath) ?? { sessions: [], taskGroups: [] };
      list.sessions.push(session);
      groups.set(session.workspacePath, list);
    }
    for (const group of archivedGroups) {
      if (workspacePath !== ALL_WORKSPACES && group.root.workspacePath !== workspacePath) continue;
      if (
        normalizedQuery &&
        !group.title.toLocaleLowerCase().includes(normalizedQuery) &&
        ![group.root, ...group.members].some(
          (m) =>
            m.sessionId.toLocaleLowerCase().includes(normalizedQuery) ||
            `${m.engine}/${m.sessionId}`.toLocaleLowerCase().includes(normalizedQuery),
        )
      ) {
        continue;
      }
      const list = groups.get(group.root.workspacePath) ?? { sessions: [], taskGroups: [] };
      list.taskGroups.push(group); groups.set(group.root.workspacePath, list);
    }
    return [...groups.entries()];
  }, [sessions, workspacePath, searchQuery, snapshot.archivedGroups]);

  const run = async (key: string, action: () => Promise<void>) => {
    if (actionPending.current || useLeaderStore.getState().busy) return;
    actionPending.current = true;
    setBusyKey(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusyKey(null);
    }
  };

  const restore = (session: SessionMeta) =>
    run(JSON.stringify([session.engine, session.sessionId, session.workspacePath]), () => ipc.restoreSession(session.engine, session.sessionId));

  const permanentlyDelete = (session: SessionMeta) =>
    run(JSON.stringify([session.engine, session.sessionId, session.workspacePath]), async () => {
      if (session.remote && session.remotePath) {
        await ipc.deleteRemoteSession(
          session.workspacePath,
          session.engine,
          session.remotePath,
        );
        // Remote rows have no local sessions-table record, so their archive
        // marker is cleared explicitly after the original remote delete path.
        await ipc.restoreSession(session.engine, session.sessionId);
      } else {
        // Local deletion also removes the archive marker in the same DB tx.
        await ipc.deleteSession(session.engine, session.sessionId);
      }
    });
  const runGroup = (group: LeaderArchivedGroup, action: "restore" | "delete") =>
    run(JSON.stringify(group.root), () => useLeaderStore.getState().groupAction(group.root, action));

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <SettingsSectionLabel className="px-0">
            {t("settings.archivedSessions")}
          </SettingsSectionLabel>
          <p className="text-body-2-regular text-text-secondary">
            {t("settings.archivedSessionsDesc")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            data-testid="archived-session-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("chat.searchSessions")}
            aria-label={t("chat.searchSessions")}
            className="h-8 w-44 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder focus:border-border-brand"
          />
          <Select
            aria-label={t("settings.archivedWorkspaceFilter")}
            size="sm"
            selectedKey={workspacePath}
            onSelectionChange={(key: Key | null) =>
              key != null && setWorkspacePath(String(key))
            }
            triggerClassName="min-w-44"
          >
            <SelectItem id={ALL_WORKSPACES}>
              {t("settings.archivedAllWorkspaces")}
            </SelectItem>
            {workspacePaths.map((path) => (
              <SelectItem key={path} id={path}>
                {workspaceLabels.get(path) || pathName(path)}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}

      {!loading && grouped.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border-button-default px-4 py-8 text-center text-body-regular text-text-secondary">
          {t("settings.archivedEmpty")}
        </div>
      ) : (
        grouped.map(([path, rows]) => (
          <div key={path} className="flex w-full flex-col gap-2">
            <SettingsSectionLabel>
              {workspaceLabels.get(path) || pathName(path) || t("settings.archivedUnknownWorkspace")}
            </SettingsSectionLabel>
            <SettingsCard>
              {rows.taskGroups.map((group) => <ArchivedLeaderGroupCard key={JSON.stringify(group.root)} group={group}
                branches={snapshot.branches.filter((branch) => group.branchIds.includes(branch.id))} when={dateFormatter.format(new Date(group.archivedAt))}
                busy={busyKey != null || leaderBusy} onRestore={() => void runGroup(group, "restore")} onDelete={() => setDeletingGroup(group)} />)}
              {rows.sessions.map((session) => {
                const key = JSON.stringify([session.engine, session.sessionId, session.workspacePath]);
                const busy = busyKey != null || leaderBusy;
                const when = session.updatedAt
                  ? dateFormatter.format(new Date(session.updatedAt))
                  : "";
                return (
                  <div
                    key={key}
                    className="flex min-h-[60px] items-center gap-3 border-b border-separator-border py-2.5 pr-2.5 last:border-b-0"
                  >
                    <EngineIcon
                      engine={session.engine}
                      size={18}
                      className="shrink-0 text-foreground-icon-secondary"
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-body-regular text-text-primary"
                        title={sessionTitle(session)}
                      >
                        {sessionTitle(session)}
                      </p>
                      <p
                        className="truncate text-body-2-regular text-text-secondary"
                        title={`${session.engine}/${session.sessionId}`}
                      >
                        {session.engine}/{session.sessionId.slice(0, 8)}{when ? ` · ${when}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        leadingIcon={ArchiveRestore}
                        disabled={busy}
                        onClick={() => void restore(session)}
                      >
                        {t("settings.restoreSession")}
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        leadingIcon={Trash2}
                        disabled={busy}
                        onClick={() => setDeleting(session)}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </SettingsCard>
          </div>
        ))
      )}

      {deleting && (
        <ConfirmDialog
          danger
          message={t("settings.confirmDeleteArchivedSession", {
            name: sessionTitle(deleting),
          })}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const session = deleting;
            setDeleting(null);
            void permanentlyDelete(session);
          }}
        />
      )}
      {deletingGroup && <ConfirmDialog danger confirmLabel={t("leader.deleteGroup")}
        message={t("leader.deleteGroupConfirm", { title: deletingGroup.title, count: deletingGroup.branchIds.length })}
        onCancel={() => setDeletingGroup(null)} onConfirm={() => {
          const group = deletingGroup; setDeletingGroup(null); void runGroup(group, "delete");
        }} />}
    </div>
  );
}

function ArchivedLeaderGroupCard({ group, branches, when, busy, onRestore, onDelete }: {
  group: LeaderArchivedGroup; branches: LeaderBranch[]; when: string; busy: boolean; onRestore: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const seen = new Set<string>();
  const descendants = (parent: LeaderIdentity): ReactNode => branches.filter((branch) => isDirectChild(branch, parent) && !seen.has(branch.id)).map((branch) => {
    seen.add(branch.id);
    return <li key={branch.id} className="mt-2 border-l border-separator-border pl-3">
      <p className="break-words text-body-2-medium text-text-primary">{branch.title} · {branch.engine} · {t(`leader.state.${branch.state}`)}</p>
      <p className="break-all text-caption-1-medium text-text-tertiary">{t("leader.groupParent", { parent: `${branch.parentEngine}/${branch.parentSessionId}` })}</p>
      {branch.task && <p className="mt-1 whitespace-pre-wrap break-words text-body-2-regular text-text-secondary">{branch.task}</p>}
      {branch.error && <p className="mt-1 break-words text-body-2-regular text-text-error-primary">{branch.error}</p>}
      {branch.result && <details className="mt-1 text-body-2-regular text-text-secondary"><summary>{t("leader.result")}{branch.resultTruncated ? ` · ${t("leader.truncated")}` : ""}</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{branch.result}</pre></details>}
      {branch.sessionId && <ul>{descendants({ engine: branch.engine, sessionId: branch.sessionId, workspacePath: branch.workspacePath })}</ul>}
    </li>;
  });
  return <div className="border-b border-separator-border py-3 pr-2.5 last:border-b-0" data-leader-archived-group>
    <div className="flex items-center gap-3">
      <EngineIcon engine={group.root.engine} size={18} className="shrink-0 text-foreground-icon-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-regular text-text-primary" title={group.title}>{group.title}</p>
        <p className="text-body-2-regular text-text-secondary">{t("leader.archivedGroup")} · {when}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="small" variant="secondary" leadingIcon={ArchiveRestore} disabled={busy || group.deletionStarted === true} onClick={onRestore}>{t("leader.restoreGroup")}</Button>
        <Button size="small" variant="danger" leadingIcon={Trash2} disabled={busy} onClick={onDelete}>{t(group.deletionStarted ? "leader.retryDeleteGroup" : "leader.deleteGroup")}</Button>
      </div>
    </div>
    {group.deletionStarted && <p role="alert" className="mt-2 text-body-2-regular text-text-error-primary">{t("leader.groupDeletionIncomplete")}</p>}
    <details className="mt-2 text-body-2-regular text-text-secondary">
      <summary>{t("leader.groupDetails", { count: group.branchIds.length })}</summary>
      <p className="mt-2 break-all text-caption-1-medium text-text-tertiary">{group.root.engine}/{group.root.sessionId}</p>
      <ul>{descendants(group.root)}</ul>
    </details>
  </div>;
}
