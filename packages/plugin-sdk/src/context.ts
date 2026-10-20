import type { ComponentType } from "react";
import type * as React from "react";
import type { Disposer } from "./manifest";
import type { ComposerSlotId, SessionMenuTarget } from "./registry";

/**
 * PluginContext（plan §5.2）：插件唯一能力门面。宿主 runtime/context.ts
 * 实现本接口；插件侧的类型镜像见包根 plugin.d.ts（双向漂移由
 * contract-check.ts 在类型层面把守）。
 */

/** 外部会话源行(ctx.sessions.registerSource,0.3.4 起):插件上报的
 *  远端/容器内会话摘要。workspacePath 必须是已登记工作区的 path,否则
 *  宿主合并时丢弃(侧栏按 workspacePath 分组)。 */
export interface ExternalSessionRow {
  engine: string;
  sessionId: string;
  workspacePath: string;
  title?: string;
  updatedAt?: number | null;
  /** 远端 jsonl 绝对路径(可选;宿主历史回放经远程通道拉取)。 */
  remotePath?: string;
}

export type PluginConversationProps = {
  conversationId: string;
  workspacePath: string;
  language: string;
  onExit: () => void;
  setExitBlocked?: (blocked: boolean) => void;
};

export interface PluginAgentCatalogEntry {
  engine: string;
  label: string;
  available: boolean;
  readOnly: boolean;
  providers: { id: string; label: string }[];
  models: { id: string; label: string }[];
}

/** Exact desktop document/window identity, available even without a loaded
 * conversation. Fresh per document lifetime; never inferred from store/DOM. */
export interface HostChatIdentity {
  readonly clientInstanceId: string;
  readonly windowId: string;
}

/** Exact desktop timeline identity. IDs are host-provided, never inferred
 * from cwd or the most recent transcript. In CC GUI native/gui IDs coincide. */
export interface HostChatTarget extends HostChatIdentity {
  readonly client: "ccgui";
  readonly engine: string;
  readonly nativeSessionId: string;
  readonly guiSessionId: string;
  readonly workspacePath: string;
}

export interface HostChatSession extends HostChatTarget {
  readonly status: "idle" | "busy" | "awaiting_permission";
}

export type HostChatReceiptStatus = "queued" | "received" | "executing" |
  "awaiting_permission" | "awaiting_cost_approval" | "completed" | "failed" | "unknown";

export interface HostChatReceipt {
  readonly requestId: string;
  readonly target: HostChatTarget;
  readonly runId: string;
  readonly status: HostChatReceiptStatus;
  readonly acceptedAt: number;
  readonly updatedAt: number;
  /** Only this request's assistant output, capped at 65,536 characters. */
  readonly text?: string;
  /** True when receipt output is a bounded prefix. The full result remains in
   * the original GUI conversation; show a truncation notice and jump back. */
  readonly truncated?: boolean;
  /** Bounded diagnostic; no raw engine envelope or unrelated history. */
  readonly error?: string;
}

export interface HostChatSubmission {
  requestId: string;
  target: HostChatTarget;
  prompt: string;
}

/** Payload of retained host `session://activated`. Legacy selection events
 * contain engine/sessionId only. Actual native window focus adds the exact
 * loaded target and host origin/reason. Blur does not clear the selected
 * session; background heartbeats are not attention events. */
export interface HostChatActivationEvent {
  engine: string | null;
  sessionId: string | null;
  origin?: "host";
  reason?: "window-focus";
  target?: HostChatSession;
}

export interface PluginContext {
  pluginId: string;
  version: string;
  /** Shared host React instance: external bundles can't resolve bare
   *  imports, so they build host-tree components with
   *  `ctx.react.createElement`; 插件自己的子树用自带 React createRoot 挂进
   *  ctx.react 容器（双段挂载模式，import-map 共享是 P0-3 后续）。 */
  react: typeof React;
  ui: {
    registerConversationMode(def: {
      key?: string;
      label: () => string;
      component: ComponentType<PluginConversationProps>;
    }): Disposer;
    registerSettingsSection(def: {
      /** Optional sub-key; the settings page key becomes
       *  `plugin:<id>` or `plugin:<id>:<key>`. */
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType;
    }): Disposer;
    registerAddMenuRow(def: {
      key?: string;
      label: () => string;
      description?: () => string;
      icon?: ComponentType<{ className?: string }>;
      onSelect: () => void;
    }): Disposer;
    /** Extra control rendered beside a composer slot's builtin control
     *  (plan §4.2 #2). Permission `ui:composer-status` (shared with
     *  registerComposerStatusItem — both gate on the same composer-area
     *  grant; there is no separate `ui:composer` permission). */
    registerComposerSlot(def: {
      slot: ComposerSlotId;
      key?: string;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Chat right-panel tab (plan §4.2 #4); renders with the active
     *  workspace path. The strip renders plugin tabs icon-only, so `icon` is
     *  the visible identity — without one the tab falls back to the plugin's
     *  artwork / letter tile, and the label stays a title/accessible name. */
    registerPanelTab(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType<{ workspacePath: string }>;
      order?: number;
    }): Disposer;
    /** App status-bar chip (plan §4.2 #8). */
    registerStatusBarItem(def: {
      key?: string;
      component: ComponentType;
      order?: number;
      /** Placement zone (0.3.8): "start" = left-aligned zone; omitted/"end"
       *  = legacy slot after sync status, before version. */
      zone?: "start" | "end";
    }): Disposer;
    /** Composer status-row chip (permission `ui:composer-status`, 0.3.9):
     *  renders in the composer's status row (branch/context meter row),
     *  left group after the branch switcher. */
    registerComposerStatusItem(def: {
      key?: string;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Command palette entry (plan §4.2 #9). */
    registerCommand(def: {
      key: string;
      title: () => string;
      keywords?: () => string[];
      run: () => void;
    }): Disposer;
    /** Sidebar session right-click menu row (permission `ui:session-menu`,
     *  0.3.5 起)。`run` 收到打开菜单的会话 `{ engine, sessionId }`。 */
    registerSessionMenuItem(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      danger?: boolean;
      run: (target: SessionMenuTarget) => void;
    }): Disposer;
    /** 跳转到本插件的设置页（权限 `ui:settings-section`，0.3.6 起）。
     *  `key` 对应 registerSettingsSection 的子 key，省略时打开主 section；
     *  供状态栏 chip、面板按钮等做深链入口。 */
    openSettings(key?: string): void;
    /** Markdown pipeline additions, merged over host defaults (plan §4.2 #5). */
    registerMarkdownRenderer(def: {
      key?: string;
      remarkPlugins?: unknown[];
      rehypePlugins?: unknown[];
      components?: Record<string, unknown>;
    }): Disposer;
    /** Overlay page at `#/p/<id>` (plan §4.2 #10). */
    registerPage(def: {
      key?: string;
      title: () => string;
      component: ComponentType;
    }): Disposer;
        /** Renderer for a plugin-defined chat timeline row kind (plan §4.2 #5).
     * The row payload is plugin-defined and typed loosely — blob bundles
     * can't share the host's TimelineRow type identity. */
    registerTimelineRowRenderer(def: {
      kind: string;
      key?: string;
      component: ComponentType<{ row: { kind: string } }>;
    }): Disposer;
    /** Home sidebar nav entry under the builtin 自动化 row (permission
     *  `ui:sidebar-entry`, 0.3.12). `onOpen` usually opens the plugin's
     *  center tab via openCenterTab. */
    registerSidebarNav(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      order?: number;
      onOpen: () => void;
    }): Disposer;
    /** Center-area tab definition (permission `ui:center-tab`, 0.3.12):
     *  renders in the center tab strip like session/file/browser tabs.
     *  Opening goes through openCenterTab; multiple keys = multiple tabs. */
    registerCenterTab(def: {
      key?: string;
      title: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Open (or focus) one of this plugin's registered center tabs
     *  (permission `ui:center-tab`, 0.3.12). Throws when the tab was never
     *  registered — open failures must be visible, not silent. */
    openCenterTab(key?: string): void;
  };
  theme: {
    /** Inject a stylesheet scoped to this plugin; removed on unload.
     *  Rejects remote references (`@import`, `url(http…)`): plugins must be
     *  self-contained (plan §8 gate rules). */
    injectCss(css: string): Disposer;
    /** Shorthand for BoardUI token overrides: keys must be `--*` custom
     *  properties; emits `:root {…}` and `.dark {…}` blocks. */
    setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): Disposer;
  };
  i18n: {
    addBundle(lang: string, ns: string, resources: Record<string, unknown>): Disposer;
  };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  events: {
    /** `session://activated` is retained; see HostChatActivationEvent for
     * native window-focus metadata. Plugins cannot emit this host topic. */
    on(topic: string, cb: (data: unknown) => void): Disposer;
    emit(topic: string, data: unknown): void;
  };
  /** 聊天输入框（composer）草稿写入（权限 `composer:draft`，0.3.2 起）。
   *  写入即替换当前活动会话的草稿；不触发发送——发送永远是用户动作。 */
  composer: {
    setDraft(text: string): void;
  };
  /** 工作区登记（权限 `host:workspace`，0.3.3 起）。把任意路径登记为侧栏
   *  工作区——不要求本机存在该目录（如经 ssh 管理的远程机/WSL 发行版内
   *  路径）。`meta` 透传存储在宿主工作区行上，形状由写入方与消费方约定。
   *
   *  `meta` 携带 `wsl` 键（远程工作区，宿主引擎经 ssh 把会话流量导到
   *  meta.wsl 指定的主机与发行版）需要额外权限 `host:workspace:remote`
   *  （0.3.4 起）——这等效于出网 + 远程执行导向，远超登记一行侧栏数据。
   *  信任权衡：远程通道首连采用 StrictHostKeyChecking=accept-new
   *  （首连自动记录 host key，之后变更才拒绝），插件作者应知晓这是
   *  TOFU 而非严格 pinning。 */
  workspaces: {
    add(path: string, meta?: Record<string, unknown>): Promise<void>;
  };
  /** 会话打开 + 外部会话源(权限 `host:session`;selectSession 0.3.3 起,
   *  registerSource 0.3.4 起)。registerSource:登记异步会话源,宿主在会话
   *  目录刷新(init/refreshSessions/rescan)时调用 `list()` 并把行合并进
   *  侧栏列表——本机扫描结果优先,同 engine/sessionId/workspacePath 的外部
   *  行被丢弃。返回 Disposer,插件卸载时自动注销。 */
  sessions: {
    selectSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
    /** 请求宿主立即刷新会话目录（侧栏/标签页），0.3.7 起。
     *  插件绕过宿主直写会话数据（如 sqlite custom_title、转录 title 行）后
     *  调用——否则变更要等用户手动同步或下次常规刷新才可见。 */
    refresh(): Promise<void>;
    /** 修改已有会话的 effort 档位，0.3.10 起。直写宿主会话状态并持久化
     *  （等价于用户在会话内切换档位，refreshSessions 不会回滚）。未知会话
     *  或空 effort 以 rejection 失败——不会创建幽灵会话条目。 */
    setEffort(engine: string, sessionId: string, workspacePath: string, effort: string): Promise<void>;
    registerSource(def: {
      /** 源 id,插件内唯一;同 id 重复登记覆盖(热重载语义)。 */
      id: string;
      list: () => Promise<ExternalSessionRow[]>;
    }): Disposer;
  };
  /** Desktop existing-chat delivery (permission `host:chat`). Reuses the
   * original timeline, model/effort/provider and permission/question cards.
   * Only open, loaded native conversations are reachable. Busy targets queue
   * without interrupting. Acceptance is persisted per plugin before resolving;
   * duplicate request IDs must have identical target and prompt. This is not
   * an exactly-once guarantee: every restored nonterminal request, including
   * queued, becomes unknown on plugin recreation in the same document and is
   * never replayed. Live busy queues continue normally. Terminal completion or
   * failure requires the exact frozen run ACK and native session identity.
   * Claude's spawn ACK may have sessionId:null; the original native session
   * announcement/envelope then supplies UUID proof, never the requested target.
   * A private durable may-have-started fence is not public executing status;
   * executing requires matching ACK or native start evidence. Typed pre-spawn
   * busy returns queued without reporting a start that never happened.
   * Durable ledgers are scoped
   * per plugin AND document: a new document preserves but cannot load or replay
   * old records; the pinned caller treats that old source as unknown/unreachable.
   * Receipt text is a bounded prefix: `truncated: true` requires a notice and
   * a jump back to the original GUI conversation, which keeps the full result.
   * Old document identities are never rebound. No approval,
   * session creation, settings override or independent agent capability. */
  chat: {
    /** Exact desktop identity even if current() is null; use it to scope
     * plugin KV. This does not create, select or infer a conversation. */
    identity(): Promise<HostChatIdentity>;
    current(): Promise<HostChatSession | null>;
    inspect(target: HostChatTarget): Promise<HostChatSession | null>;
    submit(request: HostChatSubmission): Promise<HostChatReceipt>;
    /** This plugin/document's ledger only; a new document returns null for an
     * old document's request ID. Null can mean old/unknown/unreachable, never
     * permission to replay or resubmit to a new ID/target. */
    receipt(requestId: string): Promise<HostChatReceipt | null>;
    /** This plugin's receipts only; automatically disposed on unload. */
    onEvent(callback: (receipt: HostChatReceipt) => void): Disposer;
  };
  /** Agent 轮次（权限 `agent`，0.3.13 起）：经宿主引擎管线拉起 agent
   *  进程——渠道注入、进程注册与聊天发送同构。事件走独立的
   *  `agent://<pluginId>` 总线话题（ctx.events.on 订阅；payload 为引擎
   *  事件信封 { runId, sessionId, engine, seq, kind, data, ts }，kind ∈
   *  delta | tool | usage | done | error …；流为原样透传，消费方必须忽略
   *  不认识的 kind）。Claude 的用量：CLI 已报告会话状态事件、或响应结束时
   *  仍有后台任务（旧版 CLI 的 task_started is_backgrounded=true 也算）时，
   *  每次响应的用量在 `turn_complete` 事件的 `data.usage` 上出现且只出现
   *  一次，不会在 `done` 重复；终态 `done.data.usage` 可为 null，也可能带
   *  一个尚未在 turn_complete 上报过的响应用量。累计用量请合计所有
   *  turn_complete.data.usage 与非 null 的 done.data.usage。只有既不报告
   *  会话状态、响应结束时也没有后台任务的旧版 CLI 保持一次性：只在 done 上报
   *  用量、没有 turn_complete。`done` / `error` 才是整个运行（含后台任务与
   *  自动续答）的终态，turn_complete 只是一次响应结束。宿主 UI 只打断当前
   *  Claude 回复时（CC GUI 里后台任务运行期间的 Stop；进程与后台任务继续
   *  存活），被打断的响应在 CLI 确认后以 `turn_complete` 结束，`data` 为
   *  { usage, interrupted: true }（其余响应缺省 / false）。它不是 `error`，
   *  也不是终态：运行随后进入 `activity: waiting`（仍有后台任务）或最终的
   *  `done`，消费方不得据此判定失败或收尾；其 usage 可能为零（真实 CLI 对
   *  被打断的响应不计用量），按累计规则照常合计即可。`ctx.agent.interrupt()`
   *  不会产生该标记：它终止进程树，运行仍以终态事件（`done` / `error`）收尾。
   *  插件自启的 run 不在聊天会话里，宿主的 Stop 不会作用于它，所以本流通常
   *  见不到该标记；流对宿主事件原样透传、不剥离它，遇到时按本契约处理。
   *  另有仅供展示的 `tasks`（data { tasks: [{ id, kind, description,
   *  status: running|paused|completed|failed|stopped|unknown, toolUseId?,
   *  summary?, progress?, background?, ambient? }] }，完整原生任务目录，
   *  每次事件都是全量快照）与 `activity`（data { state: running |
   *  requires_action | waiting }，原生执行阶段，永不是终态；`waiting` 表示
   *  主回复已结束而后台任务仍在、主线程可接收新消息——后台子代理仍在忙时 CLI
   *  自身会一直报「运行中」，不影响它，`running` 只表示主线程正在回复）。桌面专属
   *  （isWeb 下不可用的插件要自呈现）。 */
  agent: {
    catalog(workspacePath: string): Promise<PluginAgentCatalogEntry[]>;
    /** 启动一个 agent 轮次；返回的 runId 用于事件过滤与 interrupt。 */
    start(def: {
      engine: string;
      prompt: string;
      /** agent 进程的工作目录（绝对路径）。 */
      workspacePath: string;
      model?: string;
      /** 缺省 = 引擎当前渠道（与聊天发送同一解析）。 */
      providerId?: string;
      /** 引擎相关的会话续接 id（如 pi 的 --session-id）：同一 id 续上轮。 */
      sessionId?: string;
      readOnly?: boolean;
      requestId?: string;
    }): Promise<{ runId: string; sessionId: string | null }>;
    /** 中断本插件启动的 run（run id 属主前缀由宿主强制）。 */
    interrupt(runId: string): Promise<boolean>;
  };
  /** 通用能力出口（0.3.0 起；旧的 `cmd:<command>` 逐命令授权机制已删除）。
   *  仅下列命令，`pluginId` 由宿主自动注入（插件无需也不能传）：
   *
   *  - `plugin_http_request` `{ method, url, headers?, body? }` →
   *    `{ status, body }`：url 限 http/https，host(+端口) 须命中 manifest 的
   *    `network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>` 授权
   *    （形状与放行规则见 spec/permissions.json）。
   *  - `plugin_exec_run` `{ bin, args, env?, timeoutMs? }` →
   *    `{ code, stdout, stderr }`：bin 须命中 `exec:<bin>` 授权（裸名，无路径）。
   *    子进程 PATH 由宿主注入为"插件 env 的 PATH（如有，保持优先）+ 宿主 CLI
   *    搜索目录（进程 PATH + 常见安装位置）"，保证 `#!/usr/bin/env node`
   *    类 shim 能找到解释器；插件无法借 env 完全锁死 PATH。
   *  - `plugin_exec_spawn` `{ bin, args, env?, lifecycle? }` → void：
   *    同授权；成功时 resolve 为 void（Rust 返回 ()），失败 reject。
   *    PATH 注入语义同 `plugin_exec_run`。
   *    lifecycle 缺省 "detached"（用户级服务，活过插件）；"plugin" =
   *    附属进程，宿主跟踪，插件禁用/卸载时自动 kill。
   *  - `plugin_exec_kill` `{}` → `{ killed: number }`：kill 本插件全部
   *    lifecycle="plugin" 子进程（配置变更改名重启用；需任意 exec: 授权）。
   *  - `plugin_agent_start` / `plugin_agent_interrupt`（0.3.13 起）：
   *    与 `ctx.agent` 同一能力（需 `agent` 授权）——引擎管线由宿主接管，
   *    run id 属主前缀在 Rust 侧强制。
   *
   *  授权未命中的调用在 JS 侧即 reject（不打 IPC）；Rust 侧对授权与插件
   *  启用态另有强制（纵深防御）。 */
  bridge: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  host: {
    appVersion: string;
    /** 宿主实现的 SDK 契约版本（= 本包 version），供插件运行时自检。 */
    sdkVersion: string;
    locale: string;
    /** True in the web-access browser client; the desktop-only bridge
     *  commands above are absent there. */
    isWeb: boolean;
  };
}
