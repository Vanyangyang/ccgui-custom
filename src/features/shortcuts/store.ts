import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { ShortcutSettingKey } from "./actions";

/**
 * 快捷键设置的运行时镜像：dispatcher 在 keydown 热路径上同步读它，
 * 不能每次按键都 await getAppSettings。初始为空对象 → resolveShortcut
 * 回退默认键位，设置加载完成后热更新。
 */

interface ShortcutsState {
  values: Partial<Record<ShortcutSettingKey, string | null>>;
  reload: () => Promise<void>;
  /** 快捷键指南弹窗开关（命令面板 builtin:openShortcutsGuide 触发）。 */
  guideOpen: boolean;
  setGuideOpen: (open: boolean) => void;
}

export const useShortcutsStore = create<ShortcutsState>((set) => ({
  values: {},
  guideOpen: false,
  setGuideOpen: (open) => set({ guideOpen: open }),
  reload: async () => {
    const settings = await ipc.getAppSettings();
    set({
      values: {
        newSessionShortcut: settings.newSessionShortcut,
        interruptShortcut: settings.interruptShortcut,
        commandPaletteShortcut: settings.commandPaletteShortcut,
        sidebarSearchShortcut: settings.sidebarSearchShortcut,
        chatSearchShortcut: settings.chatSearchShortcut,
        toggleTerminalShortcut: settings.toggleTerminalShortcut,
        toggleSidebarShortcut: settings.toggleSidebarShortcut,
        toggleSidePanelShortcut: settings.toggleSidePanelShortcut,
        saveFileShortcut: settings.saveFileShortcut,
        openSettingsShortcut: settings.openSettingsShortcut,
        increaseUiScaleShortcut: settings.increaseUiScaleShortcut,
        decreaseUiScaleShortcut: settings.decreaseUiScaleShortcut,
        resetUiScaleShortcut: settings.resetUiScaleShortcut,
      },
    });
  },
}));
