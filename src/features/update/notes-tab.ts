import { create } from "zustand";

/**
 * 版本更新说明的中心页签（原生单实例，开/关与激活语义同插件中心、
 * 任务工作台）。检测到新版本时 update store 自动打开并聚焦；升级后首启
 * （`upgrade-announcement.ts`）也走这里，并留下未读标记。页签关闭只收起这个
 * 面，更新状态本身仍在 update store（浮层提示照常给「立即更新」）。
 */

export const RELEASE_NOTES_TAB_KEY = "release-notes:latest";

interface ReleaseNotesTabState {
  /** 页签存在（保持挂载，可见性由 active 决定）。 */
  open: boolean;
  /** 该页签是否为当前中心面。 */
  active: boolean;
  /**
   * 未读的新版本说明（版本号）：升级后首启由 `announceNewVersion` 写入，
   * 未读期间页签挂强调色圆点、页头显示「新版本」，用户关掉页签即视为已读。
   * 更新检查发现的待更新版本不写这里——那个场景本来就有浮层提示与「立即更新」。
   */
  unreadVersion?: string;
  /** 打开或聚焦说明页签（不产生未读标记）。 */
  openTab: () => void;
  /** 升级后首启宣布新版本：打开页签并标记未读。 */
  announceNewVersion: (version: string) => void;
  activate: () => void;
  deactivate: () => void;
  /** 关掉页签：未读标记一并清掉（看过了就不再提醒）。 */
  close: () => void;
}

export const useReleaseNotesTabStore = create<ReleaseNotesTabState>()((set, get) => ({
  open: false,
  active: false,

  openTab: () => set({ open: true, active: true }),
  announceNewVersion: (version) => set({ open: true, active: true, unreadVersion: version }),
  activate: () => set({ active: true }),
  deactivate: () => {
    if (!get().active) return;
    set({ active: false });
  },
  close: () => set({ open: false, active: false, unreadVersion: undefined }),
}));
