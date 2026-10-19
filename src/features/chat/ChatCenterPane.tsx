import { lazy, Suspense, useCallback, useEffect, type ReactNode } from "react";
import { centerTabRegistry, pluginIdFromRegistryKey, useRegistry } from "@ccgui/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { CenteredSpinner } from "@/components/base/empty-state";
import { BrowserPane, useBrowserNavSync } from "@/features/browser/BrowserPane";
import type { BrowserTab } from "@/features/browser/store";
import { DiffView } from "@/features/git/DiffView";
import type { DiffTarget } from "@/features/git/store";
import type { EngineInfo, GitStatus, Workspace } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { creatorChatWorkspace, startCreatorChat } from "@/features/plugins/hub/creator-chat";
import { ReleaseNotesPane } from "@/features/update/ReleaseNotesPane";
import { focusComposerWhenVisible } from "@/features/chat/focus-composer";
import { SplitLayout } from "./split/SplitLayout";
import type { ActiveSession } from "./store";
import { publishChatHostPresence } from "@/features/assistant-notices/host-presence";

// CodeMirror + react-markdown are heavy; split them out of the startup chunk.
const EditorPane = lazy(() => import("@/features/files/EditorPane"));
// React Flow + dagre are heavy; 任务工作台只在打开时加载。
const MissionWorkbench = lazy(() =>
  import("@/features/mission/components/Workbench").then((m) => ({
    default: m.MissionWorkbench,
  })),
);
// 插件 hub 也在打开时才加载（插件商店/管理不是启动路径）。
const PluginHub = lazy(() =>
  import("@/features/plugins/hub/PluginHub").then((m) => ({ default: m.PluginHub })),
);

/** One stacked center surface: invisible surfaces stay mounted (never
 * display:none) so WKWebView keeps its scroll boxes and editor drafts
 * alive — see the virtualizer note in FileTree. */
function Surface({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
        visible ? "relative min-w-0 flex-1 basis-0" : "invisible absolute inset-0",
      )}
    >
      {children}
    </div>
  );
}

/** One keep-alive item inside a surface; only the active item is laid out. */
function SurfaceItem({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className={cx("min-h-0 flex-col", active ? "flex flex-1" : "invisible absolute inset-0")}>
      {children}
    </div>
  );
}

/** One plugin center tab (SDK 0.3.12 ui:center-tab): renders its registered
 * component inside a plugin-scoped crash boundary. Stale ids (plugin
 * unloaded with a tab open) render nothing. */
function PluginCenterTab({ tabId, active }: { tabId: string; active: boolean }) {
  const centerTabDefs = useRegistry(centerTabRegistry);
  const def = centerTabDefs.find((d) => d.id === tabId);
  if (!def) return null;
  const TabComponent = def.component;
  return (
    <SurfaceItem active={active}>
      <PluginBoundary pluginId={pluginIdFromRegistryKey(tabId)}>
        <TabComponent />
      </PluginBoundary>
    </SurfaceItem>
  );
}

/** Exactly one center surface may be visible at a time. Single-instance
 * native tabs race only when handlers set both flags in one commit — the
 * priority order below keeps the previous last-resort tie-breaker (mission
 * workbench wins over the plugin hub) and never stacks surfaces. */
function centerSurfaces(input: {
  activeFilePath: string | null;
  activeBrowserId: string | null;
  activePluginTabId: string | null;
  pluginHubActive: boolean;
  missionActive: boolean;
  notesActive: boolean;
  diffOpen: boolean;
}): {
  chat: boolean;
  editor: boolean;
  browser: boolean;
  plugin: boolean;
  hub: boolean;
  mission: boolean;
  notes: boolean;
} {
  if (input.diffOpen) {
    return {
      chat: false,
      editor: false,
      browser: false,
      plugin: false,
      hub: false,
      mission: false,
      notes: false,
    };
  }
  const browserInView = input.activeBrowserId !== null;
  const pluginInView = input.activePluginTabId !== null;
  const hubInView = input.pluginHubActive && !input.missionActive;
  const missionInView = input.missionActive;
  // 版本更新说明是最弱的单实例面：它由更新检查自动弹出，不该抢用户正在看的
  // 插件中心 / 任务工作台（自动弹出时若前两者在视，页签高亮先落到自己的页签，
  // 用户点一下即可切回来）。
  const notesInView = input.notesActive && !missionInView && !hubInView;
  return {
    chat: !(
      input.activeFilePath ||
      browserInView ||
      pluginInView ||
      hubInView ||
      missionInView ||
      notesInView
    ),
    editor:
      input.activeFilePath !== null &&
      !browserInView &&
      !pluginInView &&
      !hubInView &&
      !missionInView &&
      !notesInView,
    browser: browserInView && !missionInView && !hubInView && !notesInView,
    plugin: pluginInView && !missionInView && !hubInView && !notesInView,
    hub: hubInView,
    mission: missionInView,
    notes: notesInView,
  };
}

/** Center tab content: the chat conversation, open file editors, and the
 * changes diff, stacked so only the active surface is visible. */
export function ChatCenterPane({
  active,
  engines,
  workspaces,
  startNewChat,
  composerInputRef,
  openFiles,
  activeFilePath,
  browserTabs,
  activeBrowserId,
  pluginTabs,
  activePluginTabId,
  pluginHubOpen,
  pluginHubActive,
  missionOpen,
  missionActive,
  notesOpen,
  notesActive,
  diffView,
  diffStatus,
  closeDiff,
}: {  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  openFiles: string[];
  activeFilePath: string | null;
  /** Open browser tabs and the one in view (mutually exclusive with
   *  activeFilePath; use-chat-tabs enforces it). */
  browserTabs: BrowserTab[];
  activeBrowserId: string | null;
  /** Open plugin center tabs (registry ids) and the one in view (mutually
   *  exclusive with the other surfaces; use-chat-tabs enforces it). */
  pluginTabs: string[];
  activePluginTabId: string | null;
  /** 原生插件中心页签（侧栏「插件」入口）：是否打开 / 是否在视。 */
  pluginHubOpen: boolean;
  pluginHubActive: boolean;
  /** 任务工作台中心页签：是否打开 / 是否在视。 */
  missionOpen: boolean;
  missionActive: boolean;
  /** 版本更新说明中心页签（更新检查发现新版本时自动打开）：是否打开 / 是否在视。 */
  notesOpen: boolean;
  notesActive: boolean;
  diffView: { workspacePath: string; target: DiffTarget } | null;
  diffStatus: GitStatus | undefined;
  closeDiff: () => void;
}) {
  // 原生 nav/title events → store, mounted once while this pane lives.
  useBrowserNavSync();
  // 插件中心「创建插件」：开一个新会话并把内置 skill 的调用预填进输入框
  // （skill 由 Rust 侧装进各引擎的 skills 根，见 creator-chat.ts）。聚焦只能在
  // 这里做——composerInputRef 归本层所有。
  const handleCreatePluginChat = useCallback(() => {
    const workspace = creatorChatWorkspace(active, workspaces);
    if (!workspace) return;
    startCreatorChat(workspace.path);
    // 本层刚从插件中心切回聊天：输入框那一帧还在隐藏面里，直接 focus() 会被
    // 浏览器忽略，交给等待可见的助手（详见 focus-composer.ts）。
    focusComposerWhenVisible(composerInputRef);
  }, [active, workspaces, composerInputRef]);
  const surfaces = centerSurfaces({
    activeFilePath,
    activeBrowserId,
    activePluginTabId,
    pluginHubActive,
    missionActive,
    notesActive,
    diffOpen: diffView !== null,
  });
  useEffect(() => publishChatHostPresence(surfaces.chat), [surfaces.chat]);
  return (
    <>
      <Surface visible={surfaces.chat}>
        <SplitLayout
          active={active}
          engines={engines}
          workspaces={workspaces}
          startNewChat={startNewChat}
        />
      </Surface>

      {openFiles.length > 0 && (
        <Surface visible={surfaces.editor}>
          <Suspense fallback={<CenteredSpinner />}>
            {openFiles.map((path) => (
              <SurfaceItem key={path} active={path === activeFilePath}>
                <EditorPane path={path} />
              </SurfaceItem>
            ))}
          </Suspense>
        </Surface>
      )}

      {/* Browser tabs: one pane per tab, each owning a native child webview
          painted over its placeholder rect (see BrowserPane). */}
      {browserTabs.length > 0 && (
        <Surface visible={surfaces.browser}>
          {browserTabs.map((tab) => (
            <SurfaceItem key={tab.id} active={tab.id === activeBrowserId}>
              <BrowserPane tab={tab} active={surfaces.browser && tab.id === activeBrowserId} />
            </SurfaceItem>
          ))}
        </Surface>
      )}

      {/* Plugin center tabs: one pane per open tab, keep-alive like the
          other surfaces. */}
      {pluginTabs.length > 0 && (
        <Surface visible={surfaces.plugin}>
          {pluginTabs.map((tabId) => (
            <PluginCenterTab key={tabId} tabId={tabId} active={tabId === activePluginTabId} />
          ))}
        </Surface>
      )}

      {/* 插件 hub（原生单实例页签）：商店/已安装管理，页签关闭后保持挂载。 */}
      {pluginHubOpen && (
        <Surface visible={surfaces.hub}>
          <Suspense fallback={<CenteredSpinner />}>
            <PluginHub
              onCreatePluginChat={workspaces.length > 0 ? handleCreatePluginChat : null}
            />
          </Suspense>
        </Surface>
      )}

      {/* 任务工作台（原生单实例页签）：打开后保持挂载，只切可见性，
          对话与运行视图不因切换页签而丢状态。 */}
      {missionOpen && (
        <Surface visible={surfaces.mission}>
          <Suspense fallback={<CenteredSpinner />}>
            <MissionWorkbench />
          </Suspense>
        </Surface>
      )}

      {/* 版本更新说明（更新检查发现新版本时自动打开的原生单实例页签）：
          只切可见性，读到的进度/滚动位置不因切走而丢。 */}
      {notesOpen && (
        <Surface visible={surfaces.notes}>
          <ReleaseNotesPane />
        </Surface>
      )}

      {/* Center diff, opened from the changes panel's file rows. Its tab
          sits in the strip; ← or closing the tab returns to the chat. */}
      {diffView && (
        <div className="relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-background-primary-default">
          <DiffView
            workspacePath={diffView.workspacePath}
            target={diffView.target}
            status={diffStatus}
            onBack={closeDiff}
          />
        </div>
      )}
    </>
  );
}
