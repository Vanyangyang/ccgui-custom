import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Archive from "lucide-react/dist/esm/icons/archive";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Copy from "lucide-react/dist/esm/icons/copy";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  sessionMenuRegistry,
  useRegistry,
  type SessionMenuItemDef,
  type SessionMenuTarget,
} from "@ccgui/plugin-sdk";
import { ContextMenu, type ContextMenuEntry } from "@/components/context-menu";
import type { ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import { openSessionBeside, sessionFromThreadId } from "@/features/chat/split/store";
import { useChatStore } from "@/features/chat/store";
import { useLeaderStore, manageLeader, branchDeletionState } from "@/features/leader/store";
import { isLeaderGroupMember, parentWorkspacePath } from "@/features/leader/types";
import { isManagedLeaderSession } from "@/features/leader/event-state";
import { parentOfBranch } from "@/features/leader/tree";
import type { SessionMeta } from "@/lib/ipc";
import { isLocalSidebarWorkspace } from "./session-sidebar-workspace-dialog";
import { workspaceCatalogPathKey } from "@/lib/workspace-path";

export interface ThreadMenuState {
  x: number;
  y: number;
  threadId: string;
  workspacePath?: string;
}

type MenuEntry = ContextMenuEntry | "separator";

/** Join non-empty entry groups with a separator between each. */
function joinSections(sections: MenuEntry[][]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (entries.length > 0) entries.push("separator");
    entries.push(...section);
  }
  return entries;
}

// threadId 约定为 "<engine>/<sessionId>"（侧栏行 id），引擎段不含 "/"。
function parseThreadTarget(threadId: string): SessionMenuTarget | null {
  const slash = threadId.indexOf("/");
  return slash > 0
    ? { engine: threadId.slice(0, slash), sessionId: threadId.slice(slash + 1) }
    : null;
}

/** Host entries: rename/copy in one group, delete in its own (separated) group. */
function buildHostSections({
  threadId,
  isDraft,
  t,
  onThreadAction,
  onCopyId,
  protectedFromDeletion,
}: {
  threadId: string;
  isDraft: boolean;
  t: TFunction;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onCopyId?: (id: string) => void;
  protectedFromDeletion?: boolean;
}): MenuEntry[][] {
  const actions: MenuEntry[] = [];
  if (onThreadAction && !isDraft) {
    actions.push({
      id: "rename",
      label: t("chat.renameSession"),
      icon: <Pencil className="size-4" aria-hidden />,
      onSelect: () => onThreadAction(threadId, "rename"),
    });
  }
  if (onCopyId && !isDraft) {
    actions.push({
      id: "copy-id",
      label: t("chat.copySessionId"),
      icon: <Copy className="size-4" aria-hidden />,
      onSelect: () => onCopyId(threadId),
    });
  }
  if (onThreadAction && !isDraft && !protectedFromDeletion) {
    actions.push({
      id: "archive",
      label: t("chat.archiveSession"),
      icon: <Archive className="size-4" aria-hidden />,
      onSelect: () => onThreadAction(threadId, "archive"),
    });
  }
  const danger: MenuEntry[] = onThreadAction && !protectedFromDeletion
    ? [
        {
          id: "delete",
          label: t("chat.deleteSession"),
          icon: <Trash2 className="size-4" aria-hidden />,
          danger: true,
          onSelect: () => onThreadAction(threadId, "delete"),
        },
      ]
    : [];
  return [actions, danger];
}

/** 插件追加行（ctx.ui.registerSessionMenuItem）：label 是 thunk，
 *  语言切换即时重命名；run 收到菜单所在的会话。 */
function buildPluginEntries(
  defs: readonly SessionMenuItemDef[],
  target: SessionMenuTarget | null,
): MenuEntry[] {
  if (!target) return [];
  return defs.map((def) => {
    const Icon = def.icon;
    return {
      id: def.id,
      label: def.label(),
      icon: Icon ? <Icon className="size-4" aria-hidden /> : null,
      danger: def.danger,
      onSelect: () => def.run(target),
    };
  });
}

/** 会话行的分屏入口：等价于把这个会话拖到聚焦格的左/右侧或上/下侧。 */
function buildSplitEntries(threadId: string, t: TFunction): MenuEntry[] {
  const session = sessionFromThreadId(threadId);
  if (!session) return [];
  return [
    {
      id: "split-right",
      label: t("chat.splitRight"),
      icon: <Columns2 className="size-4" aria-hidden />,
      onSelect: () => openSessionBeside(session, "right"),
    },
    {
      id: "split-down",
      label: t("chat.splitDown"),
      icon: <Rows2 className="size-4" aria-hidden />,
      onSelect: () => openSessionBeside(session, "bottom"),
    },
  ];
}

/**
 * Right-click menu for sidebar session rows. Chrome (portal anchoring,
 * viewport clamping, Escape/outside dismissal) comes from the shared
 * ContextMenu; this component only owns the session action entries.
 * Rename/delete reuse the hover-icon funnel (the page's prompt/confirm
 * dialogs); copy writes the session id to the clipboard.
 */
export function ThreadContextMenu({
  menu,
  onClose,
  onThreadAction,
  onCopyId,
  auxiliary,
  onSetAuxiliary,
  onSidebarWorkspace,
}: {
  menu: ThreadMenuState;
  onClose: () => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onCopyId?: (id: string) => void;
  auxiliary?: boolean;
  onSetAuxiliary?: (id: string, auxiliary: boolean) => void;
  onSidebarWorkspace?: (session: SessionMeta) => void;
}) {
  const { t } = useTranslation();
  const pluginDefs = useRegistry(sessionMenuRegistry);
  const isDraft = menu.threadId.startsWith("new:") || menu.threadId.startsWith("leader-branch:");
  const snapshot = useLeaderStore((s) => s.snapshot);
  const busy = useLeaderStore((s) => s.busy);
  const chat = useChatStore();
  const candidates = chat.sessions.filter((m) => `${m.engine}/${m.sessionId}` === menu.threadId);
  const meta = menu.workspacePath ? candidates.find((m) => m.workspacePath === menu.workspacePath) : candidates.length === 1 ? candidates[0] : undefined;
  const branch = snapshot.branches.find((b) => b.state !== "reclaimed" && (b.sessionId ? `${b.engine}/${b.sessionId}` : `leader-branch:${b.id}`) === menu.threadId);
  const target = parseThreadTarget(menu.threadId);
  const parentBranch = snapshot.branches.find((b) => `${b.parentEngine}/${b.parentSessionId}` === menu.threadId);
  const workspacePath = menu.workspacePath ?? meta?.workspacePath ?? branch?.workspacePath ?? (parentBranch ? parentWorkspacePath(parentBranch) : undefined);
  const identity = target && workspacePath != null ? { ...target, workspacePath } : null;
  const managed = !!identity && isLeaderGroupMember(snapshot, identity);
  const leaderEntries: MenuEntry[] = [];
  if (branch) leaderEntries.push({ id: "leader-parent", icon: null, label: t("leader.goParent"), onSelect: () => {
    const parent = parentOfBranch(branch);
    void useChatStore.getState().selectSession(parent.engine, parent.sessionId, parent.workspacePath);
  } });
  const deletion = branch ? branchDeletionState(snapshot, branch.id, chat) : null;
  if (branch && deletion?.available) leaderEntries.push({
    id: "leader-delete-branch", icon: <Trash2 className="size-4" aria-hidden />, danger: true,
    label: t(deletion.branches.length > 1 ? "leader.deleteSubtree" : "leader.deleteBranch"),
    disabled: busy || deletion.active, title: deletion.active ? t("leader.deleteBranchIdle") : undefined,
    onSelect: () => useLeaderStore.setState({ deletingBranch: { parent: parentOfBranch(branch), branchId: branch.id }, error: null }),
  });
  if (identity && !meta?.remote && !isDraft && ["claude", "codex", "agy", "cursor"].includes(identity.engine)) {
    if (managed) leaderEntries.push({ id: "leader-manage", icon: null, label: t("leader.manage"), onSelect: () => manageLeader(identity) });
    if (!branch && managed) {
      leaderEntries.push({ id: "leader-archive-group", icon: <Archive className="size-4" aria-hidden />, label: t("leader.archiveGroup"), disabled: busy, onSelect: () => manageLeader(identity) });
      // Whole-group actions share the management view, where activity checks
      // and an explicit permanent-delete confirmation protect the task tree.
      leaderEntries.push({ id: "leader-delete-group", icon: <Trash2 className="size-4" aria-hidden />, label: t("leader.deleteGroup"), danger: true, disabled: busy, onSelect: () => manageLeader(identity) });
    }
  }

  const hostSections = buildHostSections({
    threadId: menu.threadId,
    isDraft,
    t,
    onThreadAction,
    onCopyId,
    protectedFromDeletion: managed || !!branch || isManagedLeaderSession(menu.threadId),
  });
  const pluginSection =
    pluginDefs.length > 0 && !isDraft
      ? buildPluginEntries(pluginDefs, target && workspacePath ? { ...target, workspacePath } : target)
      : [];
  const entries = joinSections([
    buildSplitEntries(menu.threadId, t),
    meta && !isDraft && !snapshot.branches.some((b) => b.engine === meta.engine && b.sessionId === meta.sessionId) && !meta.remote && !meta.auxiliaryKind
      && chat.workspaces.some((w) => workspaceCatalogPathKey(w.path) === workspaceCatalogPathKey(meta.workspacePath) && isLocalSidebarWorkspace(w))
      && onSidebarWorkspace ? [{
      id: "sidebar-workspace", icon: null, label: t("chat.sidebarWorkspace"),
      onSelect: () => onSidebarWorkspace(meta),
    }] : [],
    auxiliary !== undefined && onSetAuxiliary ? [{
      id: "auxiliary-classification", icon: null,
      label: t(auxiliary ? "chat.moveToOrdinarySessions" : "chat.moveToAuxiliaryTasks"),
      onSelect: () => onSetAuxiliary(menu.threadId, !auxiliary),
    }] : [],
    ...hostSections,
    leaderEntries,
    pluginSection,
  ]);

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={menu.threadId}
      entries={entries}
      onClose={onClose}
    />
  );
}
