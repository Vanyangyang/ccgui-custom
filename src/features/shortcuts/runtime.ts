import { commandRegistry } from "@ccgui/plugin-sdk";
import { listenSettingsChanged } from "@/lib/events";
import { resolveShortcut, shortcutActions } from "./actions";
import { registerKeydownHandler } from "./dispatcher";
import {
  isEditableShortcutTarget,
  matchesShortcutForPlatform,
} from "./shortcuts";
import { useShortcutsStore } from "./store";

/**
 * 快捷键绑定运行时。startShortcutRuntime() 在 App 挂载时调用一次：
 * 向全局 dispatcher 注册一个 handler，按键时按 shortcutActions 表序匹配
 * 有效键位（设置值优先，缺省回退默认），命中后执行该动作已注册的组件
 * handler，无组件 handler 时运行其 commandRegistry 命令。
 */

export type ShortcutHandler = () => void;

const handlers = new Map<string, Set<ShortcutHandler>>();

/** 组件作用域动作在此注册回调（终端、侧栏搜索、编辑器保存等）。
 *  同一动作可有多个注册者（如每个编辑器实例），全部调用、各自自检。 */
export function registerShortcutHandler(
  actionId: string,
  handler: ShortcutHandler,
): () => void {
  let set = handlers.get(actionId);
  if (!set) {
    set = new Set();
    handlers.set(actionId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(actionId);
  };
}

let started = false;

export function startShortcutRuntime(): () => void {
  if (started) return () => {};
  started = true;

  void useShortcutsStore.getState().reload();
  let cancelled = false;
  let unlistenSettings: (() => void) | undefined;
  void listenSettingsChanged(() => void useShortcutsStore.getState().reload()).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else unlistenSettings = unlisten;
    },
  );

  const unregisterKeydown = registerKeydownHandler((event) => {
    const values = useShortcutsStore.getState().values;
    for (const action of shortcutActions) {
      const value = resolveShortcut(action, values);
      if (!value) continue;
      if (event.repeat && !action.allowRepeat) continue;
      if (
        action.editableGuard &&
        (isEditableShortcutTarget(event.target) ||
          isEditableShortcutTarget(document.activeElement))
      ) {
        continue;
      }
      if (!matchesShortcutForPlatform(event, value)) continue;
      const local = handlers.get(action.id);
      const command = action.commandId
        ? commandRegistry.get(action.commandId)
        : undefined;
      if (!local && !command) continue;
      event.preventDefault();
      if (local) {
        for (const handler of Array.from(local)) handler();
      } else {
        command?.run();
      }
      return;
    }
  });

  return () => {
    cancelled = true;
    unlistenSettings?.();
    unregisterKeydown();
    started = false;
  };
}
