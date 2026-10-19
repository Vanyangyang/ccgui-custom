import type { AppSettings } from "@/lib/ipc";
import { isMacPlatform } from "./shortcuts";

/**
 * 快捷键元数据单一事实源：动作 id ↔ 设置字段 ↔ 默认键位 ↔ i18n 标签 ↔ 分组。
 * 设置页（ShortcutsSection）与指引弹窗（ShortcutsGuideModal）都读这张表；
 * 新功能落地时在这里加一行即可开放键位绑定。
 *
 * 动作的执行有两类：
 * - 组件作用域动作（终端、侧栏搜索、保存文件等）：组件挂载时通过
 *   registerShortcutHandler(actionId, handler) 注册回调；
 * - 命令动作（commandId）：dispatcher 直接运行 commandRegistry 里同名命令，
 *   命令面板与快捷键共用一份动作定义。
 */

export type ShortcutSettingKey = keyof Pick<
  AppSettings,
  | "newSessionShortcut"
  | "interruptShortcut"
  | "commandPaletteShortcut"
  | "sidebarSearchShortcut"
  | "chatSearchShortcut"
  | "toggleTerminalShortcut"
  | "toggleSidebarShortcut"
  | "toggleSidePanelShortcut"
  | "saveFileShortcut"
  | "openSettingsShortcut"
  | "increaseUiScaleShortcut"
  | "decreaseUiScaleShortcut"
  | "resetUiScaleShortcut"
>;

export type ShortcutCategory = "sessions" | "app" | "panels" | "editor" | "view";

export interface ShortcutAction {
  id: string;
  setting: ShortcutSettingKey;
  category: ShortcutCategory;
  /** i18n key（shortcuts.actions.*） */
  labelKey: string;
  /** macOS 默认键位；null = 默认不绑定 */
  defaultMac: string | null;
  /** 非 macOS 默认键位；缺省 = 与 defaultMac 相同 */
  defaultOther?: string | null;
  /** 无组件 handler 时 dispatcher 运行的 commandRegistry 命令 id */
  commandId?: string;
  /** 焦点在编辑区时不触发（如 interrupt 默认 ctrl+c 与复制冲突） */
  editableGuard?: boolean;
  /** 允许按住重复触发（缩放类） */
  allowRepeat?: boolean;
}

export const shortcutActions: ShortcutAction[] = [
  // 会话
  {
    id: "newSession",
    setting: "newSessionShortcut",
    category: "sessions",
    labelKey: "shortcuts.actions.newSession",
    defaultMac: "cmd+n",
  },
  {
    id: "interrupt",
    setting: "interruptShortcut",
    category: "sessions",
    labelKey: "shortcuts.actions.interrupt",
    defaultMac: "ctrl+c",
    defaultOther: "ctrl+shift+c",
    editableGuard: true,
  },
  // 应用
  {
    id: "commandPalette",
    setting: "commandPaletteShortcut",
    category: "app",
    labelKey: "shortcuts.actions.commandPalette",
    defaultMac: "cmd+k",
  },
  {
    id: "sidebarSearch",
    setting: "sidebarSearchShortcut",
    category: "app",
    labelKey: "shortcuts.actions.sidebarSearch",
    defaultMac: "cmd+l",
  },
  {
    id: "chatSearch",
    setting: "chatSearchShortcut",
    category: "app",
    labelKey: "shortcuts.actions.chatSearch",
    defaultMac: "cmd+f",
  },
  {
    id: "openSettings",
    setting: "openSettingsShortcut",
    category: "app",
    labelKey: "shortcuts.actions.openSettings",
    defaultMac: "cmd+,",
    commandId: "builtin:openSettings",
  },
  // 面板
  {
    id: "toggleSidebar",
    setting: "toggleSidebarShortcut",
    category: "panels",
    labelKey: "shortcuts.actions.toggleSidebar",
    defaultMac: "cmd+b",
    commandId: "builtin:toggleSidebar",
  },
  {
    id: "toggleSidePanel",
    setting: "toggleSidePanelShortcut",
    category: "panels",
    labelKey: "shortcuts.actions.toggleSidePanel",
    defaultMac: "cmd+shift+e",
    commandId: "builtin:toggleSidePanel",
  },
  {
    id: "toggleTerminal",
    setting: "toggleTerminalShortcut",
    category: "panels",
    labelKey: "shortcuts.actions.toggleTerminal",
    defaultMac: "cmd+j",
  },
  // 编辑器
  {
    id: "saveFile",
    setting: "saveFileShortcut",
    category: "editor",
    labelKey: "shortcuts.actions.saveFile",
    defaultMac: "cmd+s",
  },
  // 视图
  {
    id: "zoomIn",
    setting: "increaseUiScaleShortcut",
    category: "view",
    labelKey: "shortcuts.actions.zoomIn",
    defaultMac: "cmd+=",
    allowRepeat: true,
  },
  {
    id: "zoomOut",
    setting: "decreaseUiScaleShortcut",
    category: "view",
    labelKey: "shortcuts.actions.zoomOut",
    defaultMac: "cmd+-",
    allowRepeat: true,
  },
  {
    id: "zoomReset",
    setting: "resetUiScaleShortcut",
    category: "view",
    labelKey: "shortcuts.actions.zoomReset",
    defaultMac: "cmd+0",
  },
];

export function defaultShortcutFor(action: ShortcutAction): string | null {
  if (isMacPlatform()) return action.defaultMac;
  return action.defaultOther !== undefined
    ? action.defaultOther
    : action.defaultMac;
}

/** 有效键位：设置值优先；设置为 null/undefined 时回退到默认键位。
 *  「清空」语义由设置页写成空字符串实现 —— 空字符串视为不绑定。 */
export function resolveShortcut(
  action: ShortcutAction,
  values: Partial<Record<ShortcutSettingKey, string | null>>,
): string | null {
  const configured = values[action.setting];
  if (configured === "") return null;
  return configured ?? defaultShortcutFor(action);
}
