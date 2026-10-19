import { create } from "zustand";
import { safeRandomUUID } from "@/lib/id";
import {
  ipc,
  type WorktreeCreateArgs,
  type WorktreeCreateProgress,
  type WorktreeCreateStage,
  type WorktreeErrorKind,
} from "@/lib/ipc";
import { invoke, listen } from "@/lib/transport";

export type HostWorktreeProgress = WorktreeCreateProgress & { revision?: number };
export interface WorktreeCreationSnapshot {
  args: WorktreeCreateArgs;
  progress: HostWorktreeProgress;
  active: boolean;
}

/** 进行中的创建阶段（后端 validate/fetch/add/register）之外，前端只关心
 *  「还在跑」；failed/canceled 是终态，行保留到用户关闭。 */
export interface PendingCreation {
  creationId: string;
  parentWorkspaceId: string;
  /** 父工作区路径（重试与「创建后开会话」用）。 */
  parentPath: string;
  branch: string;
  stage: WorktreeCreateStage;
  /** 后端阶段细节（如 pull/1842/head），进度文案的参数。 */
  detail?: string;
  errorKind?: WorktreeErrorKind;
  error?: string;
  /** 重试快照：参数原样重放，仅换新的 creationId。 */
  args: WorktreeCreateArgs;
  openSessionAfter: boolean;
  hostRevision?: number;
  /** Transport loss/host restart: reread disk before offering an explicit retry. */
  uncertain?: boolean;
}

interface WorktreePrefs {
  /** 上次自定义的位置（null = 用默认 <repo>-worktrees 布局）。 */
  location: string | null;
  openSessionAfter: boolean;
}

const PREFS_KEY = "ccgui-next.worktreePrefs:v1";
const COLLAPSED_KEY = "ccgui-next.worktreeCollapsedGroups:v1";

function loadCollapsedGroups(): Record<string, true> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.keys(parsed).map((k) => [k, true]));
  } catch {
    return {};
  }
}

function loadPrefs(): WorktreePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { location: null, openSessionAfter: true };
    const parsed = JSON.parse(raw) as Partial<WorktreePrefs>;
    return {
      location: typeof parsed.location === "string" ? parsed.location : null,
      openSessionAfter: parsed.openSessionAfter !== false,
    };
  } catch {
    return { location: null, openSessionAfter: true };
  }
}

interface WorktreeStore {
  pending: PendingCreation[];
  prefs: WorktreePrefs;
  /** 侧栏「WORKTREES · n」分组的折叠集（key = 父工作区 id），持久化。 */
  collapsedGroups: Record<string, true>;
  toggleGroupCollapsed: (parentWorkspaceId: string) => void;
  /** git 层面 locked 的 worktree（路径 → 锁定原因，可为空串）；右键菜单
   *  据它禁用「删除 Worktree…」。 */
  lockedPaths: Record<string, string>;
  /** git 判定目录已丢失的 worktree（prunable）；子行渲染「目录已丢失」态。 */
  missingPaths: Record<string, true>;
  /** 一次 worktree list 刷新同时更新锁定/丢失两集（同源数据，一次 set）。 */
  setGitStates: (locked: Record<string, string>, missing: Record<string, true>) => void;
  /** 后台直接删除：确认框即关，git worktree remove 在后台跑，成功后从
   *  侧栏移除登记；失败走 chat store 的 actionError 横幅。 */
  remove: (args: {
    workspaceId: string;
    worktreePath: string;
    repoPath: string;
    branch: string | null;
    deleteBranch: boolean;
  }) => void;
  /** 创建完成后的后续动作（刷新工作区列表/开新会话）。对话框提交即返回，
   *  后续的 git 进度全靠事件驱动。 */
  start: (args: WorktreeCreateArgs, opts: { parentPath: string; openSessionAfter: boolean }) => void;
  cancel: (creationId: string) => void;
  retry: (creationId: string) => void;
  dismiss: (creationId: string) => void;
  setPrefs: (patch: Partial<WorktreePrefs>) => void;
  applyProgress: (progress: HostWorktreeProgress) => void;
  applySnapshot: (snapshot: WorktreeCreationSnapshot[]) => void;
}

let eventsReady: Promise<void> | null = null;
let runtimeGeneration = 0;
let runtimeOwners = 0;
let unlisteners: Array<() => void> = [];
let snapshotTicket = 0;
const settledIds = new Set<string>();

function rememberSettled(id: string) {
  settledIds.add(id);
  if (settledIds.size > 256) settledIds.delete(settledIds.values().next().value!);
}

async function refreshActualWorktrees(repoPaths: string[], isCurrent: () => boolean): Promise<void> {
  const states = await Promise.allSettled([...new Set(repoPaths)].map((repo) => ipc.gitWorktreeList(repo)));
  if (!isCurrent()) return;
  // A removed/unavailable repo must not erase the known lock state of another
  // repo. Reconcile only entries that git could actually return this time.
  const locked = { ...useWorktreeStore.getState().lockedPaths };
  const missing = { ...useWorktreeStore.getState().missingPaths };
  for (const result of states) {
    if (result.status !== "fulfilled") continue;
    for (const entry of result.value) {
    delete locked[entry.path];
    delete missing[entry.path];
    if (entry.locked) locked[entry.path] = entry.lockReason ?? "";
    if (entry.prunable && !entry.isMain) missing[entry.path] = true;
    }
  }
  useWorktreeStore.getState().setGitStates(locked, missing);
}

/** A snapshot never replays a create command. Revisions fence late snapshots. */
export async function refreshWorktreeSnapshot(): Promise<void> {
  const ticket = ++snapshotTicket;
  const before = new Map(useWorktreeStore.getState().pending.map((row) => [row.creationId, row]));
  const snapshot = await invoke<WorktreeCreationSnapshot[]>("git_worktree_creation_snapshot");
  if (ticket !== snapshotTicket) return;
  useWorktreeStore.getState().applySnapshot(snapshot);
  const known = new Set(snapshot.map((entry) => entry.progress.creationId));
  const lost = useWorktreeStore.getState().pending.filter((row) => !known.has(row.creationId)
    && before.get(row.creationId) === row && (row.hostRevision !== undefined || row.uncertain));
  if (lost.length) {
    // The registry may have restarted or evicted old results. Show uncertainty,
    // and inspect actual git state; absence from a snapshot never means failure.
    useWorktreeStore.setState((state) => ({ pending: state.pending.map((row) => lost.includes(row)
      ? { ...row, stage: "failed", errorKind: undefined, uncertain: true } : row) }));
  }
  if (ticket !== snapshotTicket) return;
  const { useChatStore } = await import("@/features/chat/store");
  if (ticket !== snapshotTicket) return;
  await useChatStore.getState().refreshWorkspaces();
  if (ticket !== snapshotTicket) return;
  const parentPaths = (useChatStore.getState().workspaces ?? [])
    .filter((workspace) => workspace.kind !== "worktree").map((workspace) => workspace.path);
  await refreshActualWorktrees([...parentPaths, ...snapshot.map((entry) => entry.args.repoPath),
    ...lost.map((row) => row.args.repoPath)], () => ticket === snapshotTicket);
}

export function stopWorktreeRuntime(): void {
  runtimeGeneration++;
  snapshotTicket++;
  eventsReady = null;
  unlisteners.splice(0).forEach((off) => off());
  window.removeEventListener("pagehide", stopWorktreeRuntime);
}

/** Mount in the shared app so a second client sees creations before starting one. */
export function startWorktreeRuntime(): () => void {
  runtimeOwners++;
  if (runtimeOwners === 1) window.addEventListener("pageshow", resumeWorktreeRuntime);
  ensureWorktreeEvents();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--runtimeOwners === 0) {
      window.removeEventListener("pageshow", resumeWorktreeRuntime);
      stopWorktreeRuntime();
    }
  };
}

function resumeWorktreeRuntime() {
  if (runtimeOwners > 0) ensureWorktreeEvents();
}

/** 进度事件订阅只挂一次（模块级单例）；ChatPage 挂载与 store 首次使用
 *  都会触发，重复调用复用同一个 Promise。 */
export function ensureWorktreeEvents(): void {
  if (eventsReady) return;
  const generation = ++runtimeGeneration;
  const refresh = () => { void refreshWorktreeSnapshot().catch(() => { /* Reconnect retries the read; no commands are replayed. */ }); };
  window.addEventListener("pagehide", stopWorktreeRuntime, { once: true });
  eventsReady = Promise.all([
    listen<HostWorktreeProgress>("worktree://create-progress", ({ payload }) => {
      if (generation !== runtimeGeneration) return;
      useWorktreeStore.getState().applyProgress(payload);
      if (!useWorktreeStore.getState().pending.some((row) => row.creationId === payload.creationId)
        && !settledIds.has(payload.creationId)) refresh();
    }),
    listen("transport://connected", () => { if (generation === runtimeGeneration) refresh(); }),
    listen("worktree://changed", () => {
      if (generation !== runtimeGeneration) return;
      refresh();
    }),
  ].map(async (setup) => {
    const off = await setup;
    if (generation !== runtimeGeneration) off(); else unlisteners.push(off);
  })).then(() => { if (generation === runtimeGeneration) refresh(); })
    .catch(() => { if (generation === runtimeGeneration) stopWorktreeRuntime(); });
}

function newCreationId(): string {
  return safeRandomUUID();
}

export const useWorktreeStore = create<WorktreeStore>((set, get) => {
  const launch = (pending: PendingCreation) => {
    ensureWorktreeEvents();
    set((s) => ({ pending: [...s.pending, pending] }));
    void ipc.gitWorktreeCreate(pending.creationId, pending.args).catch(() => {
      // invoke 本身的失败（非 git 失败）也会以 failed 事件到达；什么都没
      // 到时兜底成行内失败，不留永远转圈的行。
      const current = get().pending.find((p) => p.creationId === pending.creationId);
      if (current && current.stage !== "failed" && current.stage !== "canceled" && current.stage !== "done") {
        set((s) => ({
          pending: s.pending.map((p) =>
            p.creationId === pending.creationId
              ? { ...p, stage: "failed" as const, errorKind: undefined, uncertain: true }
              : p,
          ),
        }));
      }
    }).finally(() => { void refreshWorktreeSnapshot().catch(() => {}); });
  };

  return {
    pending: [],
    prefs: loadPrefs(),
    collapsedGroups: loadCollapsedGroups(),

    toggleGroupCollapsed: (parentWorkspaceId) => {
      const next = { ...get().collapsedGroups };
      if (next[parentWorkspaceId]) delete next[parentWorkspaceId];
      else next[parentWorkspaceId] = true;
      set({ collapsedGroups: next });
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // 写不进去只是折叠状态不持久。
      }
    },

    lockedPaths: {},
    missingPaths: {},
    setGitStates: (locked, missing) => {
      const current = get();
      const lockedSame =
        Object.keys(locked).length === Object.keys(current.lockedPaths).length &&
        Object.entries(locked).every(([k, v]) => current.lockedPaths[k] === v);
      const missingSame =
        Object.keys(missing).length === Object.keys(current.missingPaths).length &&
        Object.keys(missing).every((k) => current.missingPaths[k]);
      if (!lockedSame || !missingSame) {
        set({ lockedPaths: locked, missingPaths: missing });
      }
    },

    remove: ({ workspaceId, worktreePath, repoPath, branch, deleteBranch }) => {
      void (async () => {
        const [{ useChatStore }, { useTerminalStore }, i18n] = await Promise.all([
          import("@/features/chat/store"),
          import("@/features/terminal/store"),
          import("@/lib/i18n"),
        ]);
        try {
          const result = await ipc.gitWorktreeRemove(repoPath, worktreePath, branch, deleteBranch);
          useTerminalStore.getState().removeWorkspace(worktreePath);
          await useChatStore.getState().removeWorkspace(workspaceId);
          // 非致命尾巴（目录没能删/分支保留原因）告知但不打断。
          const notes: string[] = [];
          if (result.orphanDirectory) notes.push(i18n.default.t("worktree.deleteOrphanNote"));
          if (result.branchKeptReason === "checked_out_elsewhere" && branch) {
            notes.push(i18n.default.t("worktree.branchKeptCheckedOut", { branch }));
          } else if (result.branchKeptReason === "unknown" && branch) {
            notes.push(i18n.default.t("worktree.branchKeptUnknown", { branch }));
          }
          if (notes.length > 0) useChatStore.setState({ actionError: notes.join(" ") });
        } catch (error) {
          useChatStore.setState({ actionError: String(error) });
        }
      })();
    },

    start: (args, opts) => {
      launch({
        creationId: newCreationId(),
        parentWorkspaceId: args.parentWorkspaceId,
        parentPath: opts.parentPath,
        branch: args.branch,
        stage: "validate",
        args,
        openSessionAfter: opts.openSessionAfter,
      });
    },

    cancel: (creationId) => {
      void ipc.gitWorktreeCreateCancel(creationId).catch(() => undefined);
    },

    retry: (creationId) => {
      const failed = get().pending.find((p) => p.creationId === creationId);
      if (!failed || (failed.stage !== "failed" && failed.stage !== "canceled")) return;
      rememberSettled(creationId);
      set((s) => ({ pending: s.pending.filter((p) => p.creationId !== creationId) }));
      launch({ ...failed, creationId: newCreationId(), stage: "validate", errorKind: undefined,
        error: undefined, hostRevision: undefined, uncertain: false });
    },

    dismiss: (creationId) => {
      rememberSettled(creationId);
      set((s) => ({ pending: s.pending.filter((p) => p.creationId !== creationId) }));
    },

    setPrefs: (patch) => {
      const prefs = { ...get().prefs, ...patch };
      set({ prefs });
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 隐私模式等写不进去时偏好只是不持久，不影响本次使用。
      }
    },

    applyProgress: (progress) => {
      const target = get().pending.find((p) => p.creationId === progress.creationId);
      if (!target || (progress.revision !== undefined && target.hostRevision !== undefined
        && progress.revision < target.hostRevision)) return;
      if (progress.stage === "done") {
        rememberSettled(progress.creationId);
        set((s) => ({ pending: s.pending.filter((p) => p.creationId !== progress.creationId) }));
        // 注册已在后端落库：重读工作区让侧栏出现子行；按需在该 worktree
        // 里开新会话（先清场再激活，对齐 center-surfaces 契约）。动态引入
        // 避免与 chat store 的模块环。
        void import("@/features/chat/store").then((chat) => {
          const store = chat.useChatStore.getState();
          void store.refreshWorkspaces().then(() => {
            if (!target.openSessionAfter) return;
            void import("@/features/chat/center-surfaces").then((surfaces) => {
              surfaces.dismissCenterSurfaces();
              chat.useChatStore.getState().startNewChat(target.args.worktreePath);
            });
          });
        });
        return;
      }
      set((s) => ({
        pending: s.pending.map((p) =>
          p.creationId === progress.creationId
            ? {
                ...p,
                stage: progress.stage,
                detail: progress.message,
                errorKind: progress.errorKind,
                error: progress.error,
                hostRevision: progress.revision ?? p.hostRevision,
                uncertain: false,
              }
            : p,
        ),
      }));
    },

    applySnapshot: (snapshot) => {
      for (const entry of snapshot) {
        const id = entry.progress.creationId;
        if (settledIds.has(id)) continue;
        if (!get().pending.some((row) => row.creationId === id)) {
          if (entry.progress.stage === "done") { rememberSettled(id); continue; }
          set((state) => ({ pending: [...state.pending, {
            creationId: id, parentWorkspaceId: entry.args.parentWorkspaceId,
            parentPath: entry.args.repoPath, branch: entry.args.branch, args: entry.args,
            stage: entry.progress.stage, openSessionAfter: false,
          }] }));
        }
        get().applyProgress(entry.progress);
      }
    },
  };
});
