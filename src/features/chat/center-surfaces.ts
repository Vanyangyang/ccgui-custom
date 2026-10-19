import { useBrowserStore } from "@/features/browser/store";
import { useFilesStore } from "@/features/files/store";
import { useGitStore } from "@/features/git/store";
import { useMissionStore } from "@/features/mission/store";
import { usePluginHubStore } from "@/features/plugins/hub/store";
import { usePluginTabsStore } from "@/features/plugins/runtime/center-tabs";
import { useReleaseNotesTabStore } from "@/features/update/notes-tab";

/**
 * 清掉中心区的非对话面（差异、文件编辑器、浏览器页签、插件页签、插件中心、
 * 任务工作台、版本更新说明）。
 *
 * 中心区同一时刻只允许一个面在视，但「在视」是各 store 自己的一组布尔量，
 * 互斥全靠调用方维护（页签条的选择器 use-chat-tabs 会完整清场）。侧栏入口、
 * 快捷键、文件树和插件 SDK 这类入口若只清掉其中一部分，就会出现「会话/页签
 * 已经切过去了，画面还停在上一个面」（见 ChatCenterPane.centerSurfaces 的
 * 可见性判定）。对话是兜底面、没有自己的激活标志：清完场后由调用方激活自己
 * 的面（startNewChat / selectSession / openFile / openTab…）。
 */
export function dismissCenterSurfaces(): void {
  useGitStore.getState().closeDiff();
  useFilesStore.getState().clearActiveFile();
  useBrowserStore.getState().deactivate();
  usePluginTabsStore.getState().deactivate();
  usePluginHubStore.getState().deactivate();
  useMissionStore.getState().deactivate();
  useReleaseNotesTabStore.getState().deactivate();
}
