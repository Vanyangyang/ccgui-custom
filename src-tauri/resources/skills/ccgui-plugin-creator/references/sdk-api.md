<!-- 由 src/features/plugins/skill/creator-skill-docs.ts 从源码生成，请勿手改。 -->
<!-- 重新生成：pnpm plugin-skill:docs（测试 creator-skill-docs.test.ts 会断言本文件与源码一致）。 -->

# CC GUI 插件 SDK 参考（SDK 0.3.28）

本文件由脚本从 `packages/plugin-sdk`（公共契约）与宿主运行时（权限门禁）派生，属于 `ccgui-plugin-creator` skill。
字段、方法、权限以本文件为准：**文中没有的 API 一律视为不存在**，不要凭记忆猜测方法名或权限名。

## manifest.json 字段

```ts
export default function activate(ctx: PluginContext): void | (() => void) {
  …
}
```

返回值（可选）是卸载清理函数：卸载时先跑它，再按注册顺序逆序执行所有 Disposer；插件不需要（也不应该）自己保存 Disposer 列表。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | 必填 | — |
| `name` | `string` | 必填 | — |
| `version` | `string` | 必填 | Semver 三段（x.y.z）。 |
| `minAppVersion`? | `string` | 可选 | 要求的宿主最低版本。 |
| `sdkVersion`? | `string` | 可选 | 要求的 SDK 版本区间（"^0.3" / "~0.3.0" / ">=0.3.0" / 精确 / "*"）。 缺省 = "*"（不校验）。宿主 SDK 不满足时插件进入 incompatible 态。 |
| `author`? | `string` | 可选 | — |
| `description`? | `string` | 可选 | — |
| `tier` | `PluginTier` | 必填 | — |
| `permissions` | `string[]` | 必填 | 基座权限与 `network:`/`exec:` 授权；全集与形状规则见 spec/permissions.json（单一事实源）。`network:none` 是基座权限 （声明无网络），永远不是授权。 |
| `contributes`? | `{ themes?: { name?: string; tokens: { light?: Record<string, string>; dark?: Record<string, string> } }[]; i18n?: { lang: string; ns?: string; resources: Record<string, unknown> }[]; statusBarItems?: { key?: string; text: string }[]; commands?: { key: string; title: string; emits?: string }[] }` | 可选 | — |
| `configSchema`? | `JsonSchemaObject` | 可选 | JSON Schema object; the settings UI auto-renders a config form. |
| `icon`? | `string` | 可选 | 市场展示用的方形图标：仓库内相对路径（推荐放 `docs/`，如 `docs/icon.png`）或绝对 https URL。缺省 = 市场用插件名首字母瓷砖。 面板页签没注册 `icon` 时也回落到它：市场安装会把索引品牌图按相对路径 落到插件目录（发布包无需内含图片文件），绝对 URL 直接联网加载。 |
| `screenshots`? | `string[]` | 可选 | 市场详情页的效果图：仓库内相对路径或绝对 https URL，≤ 5 张，按数组 顺序展示。缺省 = 详情页不渲染图集。图片在插件仓库默认分支上按路径读取， 换图无需发版。 |

字段取值规则（`id` 命名、`version` 与 Release tag 的关系、`tier` 取值、`configSchema` 渲染范围、`contributes` 声明式能力）见 `references/development-guide.md` §5 与 §8。

### 版本握手

- `sdkVersion` 接受：`"*"`、精确 `"0.3.13"`、`"^0.3"`、`"~0.3.0"`、`">=0.3.0"`；其余写法一律不满足（插件进入 incompatible 态，宿主不会静默放行）。
- 运行时自检用 `ctx.host.sdkVersion` / `ctx.host.appVersion`；`minAppVersion` 由宿主在加载前比对。

## 扩展点与所需权限

声明式能力写进 manifest 的 `contributes`（Tier-0，零 JS）；下表是 JS 插件的注册入口。
**权限列不是建议**：manifest `permissions` 没声明对应权限时，调用会抛错（`used <capability> without declaring it`）——先声明权限，再写代码。

| 入口 | 权限 | 说明 |
|---|---|---|
| `ctx.ui.registerUpdateCloseHandler` | `ui:center-tab` | Opt in this plugin's center tabs and selected side panel to safe self-update closure (permission ui:center-tab, SDK 0.3.18). The host first returns floating views through their normal input/return guard, then calls prepare. Freeze new UI actions, drain accepted local work and durably save drafts before resolving; never re-submit analysis. A rejection or abort keeps unsaved views open. Check signal before and after awaits. resume is called on cancellation/failure, including when prepare did not finish, and must idempotently release the UI freeze. The plugin remains loaded. Remembered views are restored after maintenance ends; closing a view explicitly prevents its automatic restoration. Loaded handlers also prepare when their views are already closed, so background work settles before native handoff. Support that state too. Since SDK 0.3.28, plugin-owned exec services can enter this preparation before they stop. Drain accepted work, gracefully stop those services, then call plugin_exec_kill({ onlyExited: true }) to clear their native ownership. Native admission still blocks on any remaining service or one-shot exec. Only one handler may be registered per plugin. Overlay pages are excluded. |
| `ctx.ui.registerConversationMode` | `ui:conversation-mode` | — |
| `ctx.ui.registerSettingsSection` | `ui:settings-section` | — |
| `ctx.ui.registerAddMenuRow` | `ui:add-menu` | — |
| `ctx.ui.registerComposerSlot` | `ui:composer-status` | Extra control rendered beside a composer slot's builtin control (plan §4.2 #2). Permission `ui:composer-status` (shared with registerComposerStatusItem — both gate on the same composer-area grant; there is no separate `ui:composer` permission). |
| `ctx.ui.registerPanelTab` | `ui:panel-tab` | Chat right-panel tab (plan §4.2 #4); renders with the active workspace path. The strip renders plugin tabs icon-only, so `icon` is the visible identity — without one the tab falls back to the plugin's artwork / letter tile, and the label stays a title/accessible name. |
| `ctx.ui.registerStatusBarItem` | `ui:status-bar` | App status-bar chip (plan §4.2 #8). |
| `ctx.ui.registerComposerStatusItem` | `ui:composer-status` | Composer status-row chip (permission `ui:composer-status`, 0.3.9): renders in the composer's status row (branch/context meter row), left group after the branch switcher. |
| `ctx.ui.registerCommand` | `ui:command` | Command palette entry (plan §4.2 #9). |
| `ctx.ui.registerSessionMenuItem` | `ui:session-menu` | Sidebar session right-click menu row (permission `ui:session-menu`, 0.3.5 起)。`run` 收到打开菜单的会话 `{ engine, sessionId, workspacePath? }`； SDK 0.3.22 提供已知的原目录，未知时不得用当前聊天目录代填。 |
| `ctx.ui.openSettings` | `ui:settings-section` | 跳转到本插件的设置页（权限 `ui:settings-section`，0.3.6 起）。 `key` 对应 registerSettingsSection 的子 key，省略时打开主 section； 供状态栏 chip、面板按钮等做深链入口。 |
| `ctx.ui.registerMarkdownRenderer` | `ui:markdown` | Markdown pipeline additions, merged over host defaults (plan §4.2 #5). |
| `ctx.ui.registerPage` | `ui:page` | Overlay page at `#/p/<id>` (plan §4.2 #10). |
| `ctx.ui.registerTimelineRowRenderer` | `ui:timeline-row` | Renderer for a plugin-defined chat timeline row kind (plan §4.2 #5). The row payload is plugin-defined and typed loosely — blob bundles can't share the host's TimelineRow type identity. |
| `ctx.ui.registerSidebarNav` | `ui:sidebar-entry` | Home sidebar nav entry under the builtin 自动化 row (permission `ui:sidebar-entry`, 0.3.12). `onOpen` usually opens the plugin's center tab via openCenterTab. |
| `ctx.ui.registerCenterTab` | `ui:center-tab`（`ui:detached-window` 按需） | Center-area tab definition (permission `ui:center-tab`, 0.3.12): renders in the center tab strip like session/file/browser tabs. Opening goes through openCenterTab; multiple keys = multiple tabs. |
| `ctx.ui.openCenterTab` | `ui:center-tab` | Open (or focus) one of this plugin's registered center tabs (permission `ui:center-tab`, 0.3.12). Throws when the tab was never registered — open failures must be visible, not silent. |
| `ctx.theme.injectCss` | `theme` | Inject a stylesheet scoped to this plugin; removed on unload. Rejects remote references (`@import`, `url(http…)`): plugins must be self-contained (plan §8 gate rules). |
| `ctx.theme.setTokens` | `theme` | Shorthand for BoardUI token overrides: keys must be `--*` custom properties; emits `:root {…}` and `.dark {…}` blocks. |
| `ctx.i18n.addBundle` | `i18n` | — |
| `ctx.storage.set` | `storage` | — |
| `ctx.storage.delete` | `storage` | — |
| `ctx.events.on` | `events` | `session://activated` is retained; see HostChatActivationEvent for native window-focus metadata. Plugins cannot emit this host topic. |
| `ctx.events.emit` | `events` | — |
| `ctx.composer.setDraft` | `composer:draft` | — |
| `ctx.workspaces.add` | `host:workspace`（`host:workspace:remote` 按需） | — |
| `ctx.workspaces.publishProject` | `host:workspace` | Publish/update this plugin's project view (host:workspace, 0.3.19). Use an existing project UUID as sourceKey; retries update the same host projection. Members must be covered by registered local workspaces. Does not register workspaces, grant access, change cwd or move memory. The host retains the projection after plugin unload; the user can remove it. |
| `ctx.sessions.selectSession` | `host:session` | — |
| `ctx.sessions.refresh` | `host:session` | 请求宿主立即刷新会话目录（侧栏/标签页），0.3.7 起。 插件绕过宿主直写会话数据（如 sqlite custom_title、转录 title 行）后 调用——否则变更要等用户手动同步或下次常规刷新才可见。 |
| `ctx.sessions.setEffort` | `host:session` | 修改已有会话的 effort 档位，0.3.10 起。直写宿主会话状态并持久化 （等价于用户在会话内切换档位，refreshSessions 不会回滚）。未知会话 或空 effort 以 rejection 失败——不会创建幽灵会话条目。 |
| `ctx.sessions.registerSource` | `host:session` | — |
| `ctx.chat.identity` | `host:chat` | Exact desktop identity even if current() is null; use it to scope plugin KV. This does not create, select or infer a conversation. |
| `ctx.chat.current` | `host:chat` | — |
| `ctx.chat.inspect` | `host:chat` | — |
| `ctx.chat.submit` | `host:chat` | — |
| `ctx.chat.receipt` | `host:chat` | This plugin/document's ledger only; a new document returns null for an old document's request ID. Null can mean old/unknown/unreachable, never permission to replay or resubmit to a new ID/target. |
| `ctx.chat.onEvent` | `host:chat` | This plugin's receipts only; automatically disposed on unload. |
| `ctx.tasks.conversation` | `host:tasks` | Attach only this plugin's initial owned task request to its proven native coordinator (0.3.24). |
| `ctx.tasks.sendMessage` | `host:tasks` | Durable exact-session input CAS; received means native accepted, never applied. |
| `ctx.tasks.messageReceipt` | `host:tasks` | — |
| `ctx.tasks.cancelMessage` | `host:tasks` | — |
| `ctx.tasks.stopConversation` | `host:tasks` | Cancels pending inputs and requests stop of the exact coordinator and its real managed descendants. |
| `ctx.tasks.conversationAction` | `host:tasks` | — |
| `ctx.tasks.onConversationEvent` | `host:tasks` | — |
| `ctx.tasks.catalog` | `host:tasks` | Engines (with the user's defaults), registered workspaces and project organization. No credentials or settings. |
| `ctx.tasks.history` | `host:tasks` | Saved chats of exactly one registered local workspace, newest first, paged (≤100). Metadata only. |
| `ctx.tasks.excerpt` | `host:tasks` | Bounded user/assistant text of one saved chat page for indexes and handoffs; never a whole history. |
| `ctx.tasks.plan` | `host:tasks` | Isolated, tool-less routing call. Rejects with Error whose `code` is a HostTaskPlanErrorCode. |
| `ctx.tasks.getPlan` | `host:tasks` | This plugin's plan record (running/ready/needs_clarification/failed/cancelled). |
| `ctx.tasks.cancelPlan` | `host:tasks` | Stops a running planner call; true when one was running. |
| `ctx.tasks.submit` | `host:tasks` | Durable acceptance before resolving; delivery continues in the background. |
| `ctx.tasks.receipt` | `host:tasks` | This plugin's receipt; null for an unknown id, never permission to resubmit under a new id. |
| `ctx.tasks.list` | `host:tasks` | This plugin's receipts in acceptance order. |
| `ctx.tasks.cancel` | `host:tasks` | Queued requests are withdrawn; a running turn of this request is interrupted. |
| `ctx.tasks.open` | `host:tasks` | Focus the request's conversation (user-initiated). |
| `ctx.tasks.forget` | `host:tasks` | Prune large assistant output from a settled receipt while retaining its non-replayable tombstone and identity. |
| `ctx.tasks.slots` | `host:tasks` | Current chat per logical slot; moves only on native session evidence. |
| `ctx.tasks.onEvent` | `host:tasks` | This plugin's receipts only; disposed on unload. |
| `ctx.agent.catalog` | `agent` | — |
| `ctx.agent.start` | `agent` | 启动一个 agent 轮次；返回的 runId 用于事件过滤与 interrupt。 |
| `ctx.agent.interrupt` | `agent` | 中断本插件启动的 run（run id 属主前缀由宿主强制）。 |

## PluginContext 完整签名

以下签名与 `@ccgui/plugin-sdk` 源码逐字对应（类型已收成一行）。

### ctx.ui

```ts
ui: {
  /** 权限：ui:center-tab */
  registerUpdateCloseHandler(def: { prepare(signal: AbortSignal): Promise<void>; resume(): void }): Disposer;
  /** 权限：ui:conversation-mode */
  registerConversationMode(def: { key?: string; label(): string; component: ComponentType<PluginConversationProps> }): Disposer;
  /** 权限：ui:settings-section */
  registerSettingsSection(def: { key?: string; label(): string; icon?: ComponentType<{ className?: string }>; component: ComponentType }): Disposer;
  /** 权限：ui:add-menu */
  registerAddMenuRow(def: { key?: string; label(): string; description?(): string; icon?: ComponentType<{ className?: string }>; onSelect(): void }): Disposer;
  /** 权限：ui:composer-status */
  registerComposerSlot(def: { slot: ComposerSlotId; key?: string; component: ComponentType; order?: number }): Disposer;
  /** 权限：ui:panel-tab */
  registerPanelTab(def: { key?: string; label(): string; icon?: ComponentType<{ className?: string }>; component: ComponentType<{ workspacePath: string }>; order?: number }): Disposer;
  /** 权限：ui:status-bar */
  registerStatusBarItem(def: { key?: string; component: ComponentType; order?: number; zone?: "start" | "end" }): Disposer;
  /** 权限：ui:composer-status */
  registerComposerStatusItem(def: { key?: string; component: ComponentType; order?: number }): Disposer;
  /** 权限：ui:command */
  registerCommand(def: { key: string; title(): string; keywords?(): string[]; run(): void }): Disposer;
  /** 权限：ui:session-menu */
  registerSessionMenuItem(def: { key?: string; label(): string; icon?: ComponentType<{ className?: string }>; danger?: boolean; run(target: SessionMenuTarget): void }): Disposer;
  /** 权限：ui:settings-section */
  openSettings(key?: string): void;
  /** 权限：ui:markdown */
  registerMarkdownRenderer(def: { key?: string; remarkPlugins?: unknown[]; rehypePlugins?: unknown[]; components?: Record<string, unknown> }): Disposer;
  /** 权限：ui:page */
  registerPage(def: { key?: string; title(): string; component: ComponentType }): Disposer;
  /** 权限：ui:timeline-row */
  registerTimelineRowRenderer(def: { kind: string; key?: string; component: ComponentType<{ row: { kind: string } }> }): Disposer;
  /** 权限：ui:sidebar-entry */
  registerSidebarNav(def: { key?: string; label(): string; icon?: ComponentType<{ className?: string }>; order?: number; onOpen(): void }): Disposer;
  /** 权限：ui:center-tab、ui:detached-window */
  registerCenterTab(def: { key?: string; title(): string; icon?: ComponentType<{ className?: string }>; component: ComponentType; order?: number; detached?: PluginDetachedSurfaceDefinition }): Disposer;
  /** 权限：ui:center-tab */
  openCenterTab(key?: string): void;
}
```

### ctx.theme

```ts
theme: {
  /** 权限：theme */
  injectCss(css: string): Disposer;
  /** 权限：theme */
  setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): Disposer;
}
```

### ctx.i18n

```ts
i18n: {
  /** 权限：i18n */
  addBundle(lang: string, ns: string, resources: Record<string, unknown>): Disposer;
}
```

### ctx.storage

```ts
storage: {
  get<T>(key: string): Promise<T | null>;
  /** 权限：storage */
  set(key: string, value: unknown): Promise<void>;
  /** 权限：storage */
  delete(key: string): Promise<void>;
}
```

### ctx.events

```ts
events: {
  /** 权限：events */
  on(topic: string, cb: (data: unknown) => void): Disposer;
  /** 权限：events */
  emit(topic: string, data: unknown): void;
}
```

### ctx.composer

聊天输入框（composer）草稿写入（权限 `composer:draft`，0.3.2 起）。 写入即替换当前活动会话的草稿；不触发发送——发送永远是用户动作。

```ts
composer: {
  /** 权限：composer:draft */
  setDraft(text: string): void;
}
```

### ctx.workspaces

工作区登记（权限 `host:workspace`，0.3.3 起）。把任意路径登记为侧栏 工作区——不要求本机存在该目录（如经 ssh 管理的远程机/WSL 发行版内 路径）。`meta` 透传存储在宿主工作区行上，形状由写入方与消费方约定。 `meta` 携带 `wsl` 键（远程工作区，宿主引擎经 ssh 把会话流量导到 meta.wsl 指定的主机与发行版）需要额外权限 `host:workspace:remote` （0.3.4 起）——这等效于出网 + 远程执行导向，远超登记一行侧栏数据。 信任权衡：远程通道首连采用 StrictHostKeyChecking=accept-new （首连自动记录 host key，之后变更才拒绝），插件作者应知晓这是 TOFU 而非严格 pinning。

```ts
workspaces: {
  /** 权限：host:workspace、host:workspace:remote */
  add(path: string, meta?: Record<string, unknown>): Promise<void>;
  /** 权限：host:workspace */
  publishProject(sourceKey: string, definition: import("./workspace-projects").WorkspaceProjectDefinition): Promise<import("./workspace-projects").PublishedWorkspaceProject>;
}
```

### ctx.sessions

会话打开 + 外部会话源(权限 `host:session`;selectSession 0.3.3 起, registerSource 0.3.4 起)。registerSource:登记异步会话源,宿主在会话 目录刷新(init/refreshSessions/rescan)时调用 `list()` 并把行合并进 侧栏列表——本机扫描结果优先,同 engine/sessionId/workspacePath 的外部 行被丢弃。返回 Disposer,插件卸载时自动注销。

```ts
sessions: {
  /** 权限：host:session */
  selectSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
  /** 权限：host:session */
  refresh(): Promise<void>;
  /** 权限：host:session */
  setEffort(engine: string, sessionId: string, workspacePath: string, effort: string): Promise<void>;
  /** 权限：host:session */
  registerSource(def: { id: string; list(): Promise<ExternalSessionRow[]> }): Disposer;
}
```

### ctx.chat

Desktop existing-chat delivery (permission `host:chat`). Reuses the original timeline, model/effort/provider and permission/question cards. Only open, loaded native conversations are reachable. Busy targets queue without interrupting. Acceptance is persisted per plugin before resolving; duplicate request IDs must have identical target and prompt. This is not an exactly-once guarantee: every restored nonterminal request, including queued, becomes unknown on plugin recreation in the same document and is never replayed. Live busy queues continue normally. Terminal completion or failure requires the exact frozen run ACK and native session identity. Claude's spawn ACK may have sessionId:null; the original native session announcement/envelope then supplies UUID proof, never the requested target. A private durable may-have-started fence is not public executing status; executing requires matching ACK or native start evidence. Typed pre-spawn busy returns queued without reporting a start that never happened. Durable ledgers are scoped per plugin AND document: a new document preserves but cannot load or replay old records; the pinned caller treats that old source as unknown/unreachable. Receipt text is a bounded prefix: `truncated: true` requires a notice and a jump back to the original GUI conversation, which keeps the full result. Old document identities are never rebound. No approval, session creation, settings override or independent agent capability.

```ts
chat: {
  /** 权限：host:chat */
  identity(): Promise<HostChatIdentity>;
  /** 权限：host:chat */
  current(): Promise<HostChatSession | null>;
  /** 权限：host:chat */
  inspect(target: HostChatTarget): Promise<HostChatSession | null>;
  /** 权限：host:chat */
  submit(request: HostChatSubmission): Promise<HostChatReceipt>;
  /** 权限：host:chat */
  receipt(requestId: string): Promise<HostChatReceipt | null>;
  /** 权限：host:chat */
  onEvent(callback: (receipt: HostChatReceipt) => void): Disposer;
}
```

### ctx.tasks

Goal routing and task delivery into real GUI chats (permission `host:tasks`, desktop only, 0.3.20). The host reuses a slot's saved chat or creates a background chat in a registered local workspace, with the user's own model and permission settings; it never changes an existing chat's cwd. Acceptance is persisted before resolving. A request that may have started is never replayed: after a restart it becomes `unknown`. Declared write paths order conflicting requests (unknown = whole workspace); they are not an OS sandbox. See ./tasks.ts.

```ts
tasks: {
  /** 权限：host:tasks */
  conversation(requestId: string): Promise<import("./task-conversations").HostTaskConversationSnapshot>;
  /** 权限：host:tasks */
  sendMessage(request: import("./task-conversations").HostTaskMessageRequest): Promise<import("./task-conversations").HostTaskMessageReceipt>;
  /** 权限：host:tasks */
  messageReceipt(conversationRequestId: string, requestId: string): Promise<import("./task-conversations").HostTaskMessageReceipt | null>;
  /** 权限：host:tasks */
  cancelMessage(conversationRequestId: string, requestId: string): Promise<import("./task-conversations").HostTaskMessageReceipt | null>;
  /** 权限：host:tasks */
  stopConversation(requestId: string): Promise<import("./task-conversations").HostTaskConversationSnapshot>;
  /** 权限：host:tasks */
  conversationAction(requestId: string, action: import("./task-conversations").HostTaskConversationAction): Promise<import("./task-conversations").HostTaskConversationSnapshot | void>;
  /** 权限：host:tasks */
  onConversationEvent(callback: (snapshot: import("./task-conversations").HostTaskConversationSnapshot) => void): Disposer;
  /** 权限：host:tasks */
  catalog(options?: { includeModels?: boolean }): Promise<import("./tasks").HostTaskCatalog>;
  /** 权限：host:tasks */
  history(query: import("./tasks").HostTaskHistoryQuery): Promise<import("./tasks").HostTaskHistoryPage>;
  /** 权限：host:tasks */
  excerpt(query: import("./tasks").HostTaskExcerptQuery): Promise<import("./tasks").HostTaskExcerpt>;
  /** 权限：host:tasks */
  plan(request: import("./tasks").HostTaskPlanRequest): Promise<import("./tasks").HostTaskPlan>;
  /** 权限：host:tasks */
  getPlan(requestId: string): Promise<import("./tasks").HostTaskPlanRecord | null>;
  /** 权限：host:tasks */
  cancelPlan(requestId: string): Promise<boolean>;
  /** 权限：host:tasks */
  submit(request: import("./tasks").HostTaskSubmission): Promise<import("./tasks").HostTaskReceipt>;
  /** 权限：host:tasks */
  receipt(requestId: string): Promise<import("./tasks").HostTaskReceipt | null>;
  /** 权限：host:tasks */
  list(query?: { projectId?: string; slotKey?: string; taskId?: string }): Promise<import("./tasks").HostTaskReceipt[]>;
  /** 权限：host:tasks */
  cancel(requestId: string): Promise<import("./tasks").HostTaskReceipt | null>;
  /** 权限：host:tasks */
  open(requestId: string): Promise<void>;
  /** 权限：host:tasks */
  forget(requestId: string): Promise<boolean>;
  /** 权限：host:tasks */
  slots(projectId?: string): Promise<import("./tasks").HostTaskSlot[]>;
  /** 权限：host:tasks */
  onEvent(callback: (receipt: import("./tasks").HostTaskReceipt) => void): Disposer;
}
```

### ctx.agent

Agent 轮次（权限 `agent`，0.3.13 起）：经宿主引擎管线拉起 agent 进程——渠道注入、进程注册与聊天发送同构。事件走独立的 `agent://<pluginId>` 总线话题（ctx.events.on 订阅；payload 为引擎 事件信封 { runId, sessionId, engine, seq, kind, data, ts }，kind ∈ delta | tool | usage | done | error …；流为原样透传，消费方必须忽略 不认识的 kind）。Claude 的用量：CLI 已报告会话状态事件、或响应结束时 仍有后台任务（旧版 CLI 的 task_started is_backgrounded=true 也算）时， 每次响应的用量在 `turn_complete` 事件的 `data.usage` 上出现且只出现 一次，不会在 `done` 重复；终态 `done.data.usage` 可为 null，也可能带 一个尚未在 turn_complete 上报过的响应用量。累计用量请合计所有 turn_complete.data.usage 与非 null 的 done.data.usage。只有既不报告 会话状态、响应结束时也没有后台任务的旧版 CLI 保持一次性：只在 done 上报 用量、没有 turn_complete。`done` / `error` 才是整个运行（含后台任务与 自动续答）的终态，turn_complete 只是一次响应结束。宿主 UI 只打断当前 Claude 回复时（CC GUI 里后台任务运行期间的 Stop；进程与后台任务继续 存活），被打断的响应在 CLI 确认后以 `turn_complete` 结束，`data` 为 { usage, interrupted: true }（其余响应缺省 / false）。它不是 `error`， 也不是终态：运行随后进入 `activity: waiting`（仍有后台任务）或最终的 `done`，消费方不得据此判定失败或收尾；其 usage 可能为零（真实 CLI 对 被打断的响应不计用量），按累计规则照常合计即可。`ctx.agent.interrupt()` 不会产生该标记：它终止进程树，运行仍以终态事件（`done` / `error`）收尾。 插件自启的 run 不在聊天会话里，宿主的 Stop 不会作用于它，所以本流通常 见不到该标记；流对宿主事件原样透传、不剥离它，遇到时按本契约处理。 另有仅供展示的 `tasks`（data { tasks: [{ id, kind, description, status: running|paused|completed|failed|stopped|unknown, toolUseId?, summary?, progress?, background?, ambient? }] }，完整原生任务目录， 每次事件都是全量快照）与 `activity`（data { state: running | requires_action | waiting }，原生执行阶段，永不是终态；`waiting` 表示 主回复已结束而后台任务仍在、主线程可接收新消息——后台子代理仍在忙时 CLI 自身会一直报「运行中」，不影响它，`running` 只表示主线程正在回复）。桌面专属 （isWeb 下不可用的插件要自呈现）。

```ts
agent: {
  /** 权限：agent */
  catalog(workspacePath: string): Promise<PluginAgentCatalogEntry[]>;
  /** 权限：agent */
  start(def: { engine: string; prompt: string; workspacePath: string; model?: string; providerId?: string; sessionId?: string; readOnly?: boolean; requestId?: string }): Promise<{ runId: string; sessionId: string | null }>;
  /** 权限：agent */
  interrupt(runId: string): Promise<boolean>;
}
```

### ctx.bridge

通用能力出口（0.3.0 起；旧的 `cmd:<command>` 逐命令授权机制已删除）。 仅下列命令，`pluginId` 由宿主自动注入（插件无需也不能传）： - `plugin_http_request` `{ method, url, headers?, body? }` → `{ status, body }`：url 限 http/https，host(+端口) 须命中 manifest 的 `network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>` 授权 （形状与放行规则见 spec/permissions.json）。 - `plugin_exec_run` `{ bin, args, env?, timeoutMs? }` → `{ code, stdout, stderr }`：bin 须命中 `exec:<bin>` 授权（裸名，无路径）。 子进程 PATH 由宿主注入为"插件 env 的 PATH（如有，保持优先）+ 宿主 CLI 搜索目录（进程 PATH + 常见安装位置）"，保证 `#!/usr/bin/env node` 类 shim 能找到解释器；插件无法借 env 完全锁死 PATH。 - `plugin_exec_spawn` `{ bin, args, env?, lifecycle? }` → void： 同授权；成功时 resolve 为 void（Rust 返回 ()），失败 reject。 PATH 注入语义同 `plugin_exec_run`。 lifecycle 缺省 "detached"（用户级服务，活过插件）；"plugin" = 附属进程，宿主跟踪，插件禁用/卸载时自动 kill。 - `plugin_exec_kill` `{ onlyExited?: boolean }` → `{ killed: number }`： 缺省 kill 本插件全部 lifecycle="plugin" 子进程。SDK 0.3.28 起 onlyExited=true 仅清退已确认退出的本插件登记，最多等待 2 秒；仍活跃或 退出状态不可确认则 reject，不强杀，killed 为清退数。需任意 exec: 授权。 - `plugin_agent_start` / `plugin_agent_interrupt`（0.3.13 起）： 与 `ctx.agent` 同一能力（需 `agent` 授权）——引擎管线由宿主接管， run id 属主前缀在 Rust 侧强制。 授权未命中的调用在 JS 侧即 reject（不打 IPC）；Rust 侧对授权与插件 启用态另有强制（纵深防御）。

```ts
bridge: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
```

### ctx.host

```ts
host: {
  whenReady(signal?: AbortSignal): Promise<void>;
  appVersion: string;
  sdkVersion: string;
  locale: string;
  isWeb: boolean;
}
```

### 标量属性

```ts
ctx.conversations: HostConversationsApi & { View: ConversationViewComponent }; // Persistent read-only native discussions; requires host:chat.
ctx.images: HostImagesApi; // Durable host-managed plugin image attachments; requires host:chat or host:tasks (0.3.23).
ctx.pluginId: string;
ctx.version: string;
ctx.react: typeof React; // Shared host React instance: external bundles can't resolve bare imports, so they build host-tree components with `ctx.react.createElement`; 插件自己的子树用自带 React cre…
ctx.memoryExtraction: HostMemoryExtractionApi; // Fixed project-scoped background extraction; desktop owner, host:memory.
```

## 宿主持续讨论契约

`ctx.conversations`（0.3.21，`host:chat`）在桌面主文档持有受约束的原生只读讨论，不占任务执行账本。插件持有话题、草稿和引用；消息投影不应写入插件恢复点。`View` 及浮窗的 `ConversationView` 是宿主渲染器，文件链接通过 `onAction` 回到主文档，再调用 `openFile`；浮窗不创建第二个聊天控制器。切换模型/渠道使用新的物理 threadId，保留原来源；结果未知不重放。下列仅为类型声明，不应作为 main.js 运行时 import。

```ts
import type { Disposer } from "./manifest";
import type { ComponentType } from "react";
import type { HostFixedInstructions } from "./fixed-instructions";

export type ConversationEngine = "claude" | "codex";
export interface ConversationSelection {
  engine: ConversationEngine;
  model?: string;
  effort?: string;
  providerId?: string;
}
export interface ConversationSnapshot {
  threadId: string;
  revision: number;
  workspacePath: string;
  selection: ConversationSelection;
  /** Native-resolved launch arguments, frozen when opened; not evidence of the
   * upstream model that ultimately answered. A changed alias mapping requires a
   * new thread. Credentials/endpoints of the selected provider remain user-managed. */
  effectiveSelection: ConversationSelection;
  sessionRef: { engine: ConversationEngine; sessionId: string; workspacePath: string } | null;
  status: "idle" | "starting" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  /** Transient JSON projection of host Message rows. Render through the host
   * renderer; plugins must not persist, rewrite or infer native session identity
   * from these opaque rows. */
  messages: unknown[];
  error?: string;
  lastRequestId?: string;
}
export interface PluginImageAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}
export interface HostImagesApi {
  importImage(request: {
    dataBase64: string;
    mimeType: string;
    name?: string;
  }): Promise<PluginImageAttachment>;
  readPreview(id: string): Promise<{ dataUrl: string }>;
}
export interface ConversationCatalog {
  /** User's current engine, which may not support read-only discussion. */
  defaultEngine?: string;
  capabilities?: {
    images: boolean;
    fixedInstructions?: boolean;
  };
  engines: Array<{
    id: ConversationEngine;
    label: string;
    available: boolean;
    supportsImages?: boolean;
    models: Array<{ id: string; label: string }>;
    providers: Array<{ id: string; label: string }>;
    efforts?: Array<{ id: string; label: string }>;
    defaultModel: string | null;
    defaultEffort: string | null;
    defaultProviderId: string;
  }>;
  workspaces: Array<{ id: string; path: string; name: string }>;
}
/** Desktop-owner-only host:chat capability. Runs persistent read-only native
 * Sidechat branches (Claude: Read/Grep/Glob, no MCP; Codex: verified read-only
 * sandbox, no network). It can read files in the registered local workspace and
 * sends prompts and inspected context to the selected provider. It consumes
 * provider quota. No execution, promotion, task ledger, or global settings edits
 * are exposed. Closing UI / disposing listeners does not cancel work.
 * A thread's workspace and selection are immutable. Rotate threadId to change
 * either. Missing model/effort resolve once from host defaults; if a default
 * cannot be resolved, open requires an explicit choice instead of relying on
 * mutable CLI defaults. Persisted in-flight work without native proof restores as unknown;
 * it is never silently replayed. Only the latest request is retained per thread;
 * expectedRevision prevents replay of older requests after subsequent turns. */
export interface HostConversationsApi {
  catalog(): Promise<ConversationCatalog>;
  open(request: { threadId: string; workspacePath: string; selection: ConversationSelection }): Promise<ConversationSnapshot>;
  inspect(threadId: string): Promise<ConversationSnapshot>;
  send(request: { threadId: string; requestId: string; expectedRevision: number; prompt: string; images?: string[]; fixedInstructions?: HostFixedInstructions }): Promise<ConversationSnapshot>;
  stop(threadId: string): Promise<ConversationSnapshot>;
  /** Reveal a clicked discussion file link in the owner window's native file UI. */
  openFile(threadId: string, path: string): Promise<void>;
  onEvent(callback: (snapshot: ConversationSnapshot) => void): Disposer;
}

/** Host renderer with no send, storage or approval authority of its own. */
export interface ConversationViewProps {
  conversation: unknown;
  /** Plain/read-only projections never expose coordinator write controls. */
  readOnly?: boolean;
  onAction?: (action: ConversationViewAction) => void;
}
/** Composite views accept { sources: [{ id, label, conversation }], currentSourceId? }.
 * At most 32 recent sources render; an explicit currentSourceId is always retained.
 * Without it the last source is current. sourceId
 * routes an action to its originating projection. The host revalidates ownership. */
export type ConversationViewAction = { type: "openFile"; path: string; sourceId?: string; expectedRevision?: number } | import("./task-conversations").HostTaskConversationAction;
export type ConversationViewComponent = ComponentType<ConversationViewProps>;
```

## 固定协作指令

SDK 0.3.27：先检查 catalog().capabilities.fixedInstructions；tasks 还必须检查目标引擎 supportsFixedInstructions 并显式传 engine。固定规则通过 fixedInstructions metadata 保存并进入 Claude/Codex 原生 system/developer 通道，每次启动与恢复重新载入，不依赖首条用户消息留在压缩历史中。它不授予工具或文件权限；用户配置、原生父子任务和只读边界继续生效。省略保留当前规则；同版内容可 live/steer，变更必须等完整原生轮次，已受理输入保持 queued。请求指纹包括版本和正文，未知结果不重放。旧宿主不声明能力时保留必要提示正文，不能仅凭 SDK 版本删掉规则。

```ts
/** Supplementary plugin guidance, separate from user turns. It does not grant
 * tools or permissions. Supported local Claude/Codex launches restore it through
 * their native system/developer instruction channel, including resumed sessions.
 * Omission on a continuation retains the previous profile. Changing a profile
 * waits for a full native turn; it cannot replace instructions in a live turn. */
export interface HostFixedInstructions {
  /** Stable policy revision: [A-Za-z0-9._:-]{1,128}. */
  version: string;
  /** Nonblank text, at most 16000 UTF-16 units; NUL is forbidden. */
  text: string;
}
```

## 宿主持续协调契约

`ctx.tasks.catalog().capabilities.continuousCoordination` 为真时，可用初始插件自有任务 requestId 绑定协调会话。后续输入使用 sendMessage 的 inputRevision CAS，同一原生 session 的 steer/live 或宿主持久队列；received 仅表示 native 接收，不表示要求已应用，completed 仅表示关联 turn 结束。unknown 不自动重放。真实消息投影仅供展示，不写插件存储。stopConversation 包含待送输入和实际归属 children；子任务控制与历史保留。

```ts
import type { Disposer } from "./manifest";
import type { HostTaskSelection, HostTaskSessionRef } from "./tasks";
import type { HostFixedInstructions } from "./fixed-instructions";

export interface HostTaskMessageReceipt {
  conversationRequestId: string;
  requestId: string;
  /** Bounded (280 UTF-16 units, no split surrogate) displayText preview; empty
   * when displayText was omitted. Never generated from a model response. */
  preview: string;
  inputRevision: number;
  status: "queued" | "starting" | "received" | "completed" | "failed" | "cancelled" | "unknown";
  delivery: "queued" | "turn" | "steer" | "live" | null;
  runId: string | null;
  sessionRef: HostTaskSessionRef | null;
  acceptedAt: number;
  updatedAt: number;
  error?: string;
}
export interface HostTaskConversationChild {
  id: string;
  title: string;
  state: string;
  sessionRef: HostTaskSessionRef | null;
  delegation?: { requestId?: string; state: string; result?: string | null };
}
export interface HostTaskConversationSnapshot {
  requestId: string;
  revision: number;
  inputRevision: number;
  workspacePath: string;
  sessionRef: HostTaskSessionRef | null;
  selection?: HostTaskSelection;
  effectiveSelection?: HostTaskSelection;
  status: "starting" | "running" | "waiting" | "idle" | "stopping" | "cancelled" | "failed" | "unknown";
  /** Transient real host rows, including native sequence, timestamps and pending cards. Never persist these projections. */
  messages: unknown[];
  deliveries: HostTaskMessageReceipt[];
  children: HostTaskConversationChild[];
  canSend: boolean;
  /** Sticky stop watch, including when all currently observed runs are cancelled.
   * Cleared only after an explicit new input is natively accepted. */
  stopRequested?: boolean;
  canChangeSelection: boolean;
  error?: string;
}
export interface HostTaskMessageRequest {
  conversationRequestId: string;
  requestId: string;
  expectedInputRevision: number;
  prompt: string;
  /** Changed guidance remains queued until a full native turn can apply it. */
  fixedInstructions?: HostFixedInstructions;
  /** User-authored display text; native prompt and transcript text are untouched. */
  displayText?: string;
  images?: string[];
}
/** Displayed pending identity is mandatory for mutating native actions. sourceId
 * is a renderer routing hint; the owning request and current native record are
 * independently validated by the host. */
export type HostTaskConversationAction = {
  sourceId?: string;
  conversationRequestId: string;
  expectedRevision: number;
} & (
  | { type: "openFile"; path: string }
  | { type: "openChild"; childId: string }
  | { type: "openNative" }
  | { type: "answerQuestion"; seq: number; runId: string; requestId: string; answers: Record<string, string | string[]> | null }
  | { type: "answerGrant"; seq: number; accept: boolean }
  | { type: "answerPlan"; planId: string; planRevision: number; runId: string | null; decision: "approve" | "request_changes" | "defer"; feedback?: string }
);
export interface HostTaskConversationsApi {
  conversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  sendMessage(request: HostTaskMessageRequest): Promise<HostTaskMessageReceipt>;
  messageReceipt(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  cancelMessage(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  stopConversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  conversationAction(requestId: string, action: HostTaskConversationAction): Promise<HostTaskConversationSnapshot | void>;
  onConversationEvent(callback: (snapshot: HostTaskConversationSnapshot) => void): Disposer;
}
```

## 项目后台记忆提炼契约

0.3.26 增加 `prepare`：只读生成本批有界检索线索和 `sourceDigest`，不调用模型。格式 2 的 `extract` 必须携带 `expectedSourceDigest`，来源变化则延后；关系只允许本批旧记忆 ID/版本，替代关系需要同条件的明确用户修正证据，仍是 AI 解释，不授予用户确认权威。旧格式 1 不返回关系字段。

`ctx.memoryExtraction`（0.3.25，`host:memory`）仅在桌面主文档可用，来源还需 `host:chat` 或 `host:tasks`。宿主按插件自有来源与明确项目读取原文，独立使用固定 Gemini4/Vertex；不接收任意对话正文，不自动把记忆注入主对话。主对话请求会取消在途提炼，限流后退避且不切换渠道。此能力消耗模型额度，本地取消不能保证上游返还额度。插件负责项目级持久队列、初始游标、幂等原子写入和暂停；只保存来源引用、游标与已验证的派生条目，不复制完整会话，不覆盖用户确认或撤回的记录。

```ts
/** Exact plugin-owned source. Imported references and managed child chats are
 * deliberately not extraction sources. No transcript is accepted from a plugin. */
export interface MemoryExtractionSource {
  kind: "conversation" | "coordination";
  id: string;
}
export interface MemoryExtractionSessionRef {
  engine: string;
  sessionId: string;
  workspacePath: string;
}
/** Native sequence and Unicode code-point offset. offset=0 consumes the whole
 * row; a positive offset resumes that row. Persist this opaque cursor unchanged.
 * The digest fences rewritten rows; a session change never resets progress. */
export interface MemoryExtractionCursor {
  sessionId: string;
  seq: number;
  offset: number;
  rowDigest?: string;
}
export interface MemoryExtractionContext {
  id: string;
  revision: number;
  kind: string;
  title: string;
  text: string;
  conditions: string[];
  authority?: string;
  updatedAt?: string;
}
export interface MemoryExtractionRelation {
  kind: "supersedes" | "conflicts";
  targetId: string;
  targetRevision: number;
  /** Assistant interpretation; original evidence and records remain authoritative. */
  reason: string;
}
export interface MemoryExtractionEvidence {
  seq: number;
  role: "user" | "assistant";
  quote: string;
}
export interface MemoryExtractionNote {
  kind: "decision" | "idea" | "observation" | "hypothesis" | "handoff";
  title: string;
  text: string;
  conditions: string[];
  relatedIds: string[];
  evidence: MemoryExtractionEvidence[];
  /** Required for formatVersion 2, absent for legacy format 1. */
  relations?: MemoryExtractionRelation[];
}
export interface MemoryExtractionBatch {
  version: 1 | 2;
  projectId: string;
  source: MemoryExtractionSource;
  sessionRef: MemoryExtractionSessionRef;
  fromCursor: MemoryExtractionCursor | null;
  nextCursor: MemoryExtractionCursor;
  inputDigest: string;
  partial: boolean;
  hasMore: boolean;
  model: "gemini-4-argon";
  notes: MemoryExtractionNote[];
}
export interface MemoryExtractionDeferred {
  status: "deferred" | "unavailable" | "invalid_source";
  /** Stable diagnostic code, never provider response text or credentials. */
  reason: string;
  retryAfterMs: number;
}
export type MemoryExtractionResult =
  | { status: "completed"; batch: MemoryExtractionBatch }
  | { status: "empty"; cursor: MemoryExtractionCursor | null }
  | MemoryExtractionDeferred;
export type MemoryExtractionCheckpoint =
  | { status: "ready"; cursor: MemoryExtractionCursor; sessionRef: MemoryExtractionSessionRef }
  | MemoryExtractionDeferred;
export interface MemoryExtractionStatus {
  available: boolean;
  busy: boolean;
  retryAfterMs: number;
  reason?: string;
}
export interface MemoryExtractionSourceRequest {
  projectId: string;
  source: MemoryExtractionSource;
}
export interface MemoryExtractionRequest extends MemoryExtractionSourceRequest {
  requestId: string;
  cursor?: MemoryExtractionCursor | null;
  context?: MemoryExtractionContext[];
  formatVersion?: 2;
  expectedSourceDigest?: string;
}
export interface MemoryExtractionPrepareRequest extends MemoryExtractionSourceRequest {
  cursor?: MemoryExtractionCursor | null;
}
export type MemoryExtractionPreparation = {
  status: "ready";
  /** Local retrieval hint, at most 512 code points; never authoritative evidence. */
  query: string;
  sourceDigest: string;
  fromCursor: MemoryExtractionCursor | null;
  nextCursor: MemoryExtractionCursor | null;
  sessionRef: MemoryExtractionSessionRef;
  partial: boolean;
  hasMore: boolean;
} | MemoryExtractionDeferred;
/** Desktop owner only, host:memory (0.3.25), plus host:chat/host:tasks for the
 * selected source. Fixed tool-less Gemini4/Vertex extraction consumes provider
 * quota. The native host verifies source ownership, project and successful
 * completion; policies, carried references and tool/thinking output are excluded.
 * It waits for global foreground idle and cancels on new foreground input or
 * maintenance. Cancellation cannot guarantee upstream quota or billing refunds.
 * No queue, persistence or main-chat injection is performed by this API.
 * Persist source/cursor metadata and validated notes with their evidence only;
 * generated notes never acquire user-confirmed authority automatically. */
export interface HostMemoryExtractionApi {
  status(): Promise<MemoryExtractionStatus>;
  /** Metadata only. Seed existing sources here to avoid historical backfill. */
  checkpoint(request: MemoryExtractionSourceRequest): Promise<MemoryExtractionCheckpoint>;
  /** 0.3.26: bounded native source selection for local retrieval, no model call.
   * Pass its sourceDigest to formatVersion 2 extract; changed source is deferred. */
  prepare(request: MemoryExtractionPrepareRequest): Promise<MemoryExtractionPreparation>;
  /** One bounded request; a completed empty notes array is a successful batch. */
  extract(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  cancel(requestId: string): Promise<void>;
}
```

## 项目视图契约

`workspaces.publishProject(sourceKey, definition)` 用插件的稳定项目标识更新宿主投影。成员必须位于已登记本机工作区范围内，最多 32 个。关系不授予文件或模型权限，参照用途不等于强制只读；不迁移会话或源项目记忆。来源插件维护成员配置，宿主移除投影不会删除源数据。下列仅为类型声明。

```ts
/** A project view associates existing local workspace directories. It does not
 * grant filesystem access, change a session cwd, or move project memory. */
export interface WorkspaceProjectMemberDefinition {
  id: string;
  path: string;
  label: string;
  /** A descriptive role, not an operating-system read-only restriction. */
  role: "development" | "reference";
}

export interface WorkspaceProjectDefinition {
  name: string;
  /** Must exactly match one member's path. Used only for new conversations. */
  defaultPath: string;
  members: WorkspaceProjectMemberDefinition[];
}

export interface PublishedWorkspaceProject {
  /** Host projection identity; the publisher's source key remains unchanged. */
  id: string;
}
```

## 独立窗口渲染契约

中心页签可声明 `detached` 并授权 `ui:detached-window`。主文档继续唯一持有控制器与聊天能力；浮窗仅调用命名 renderer 工厂，不重新 activate。下列内容是类型声明，不应作为 main.js 的运行时 import。

```ts
import type { ComponentType } from "react";
import type * as React from "react";
import type { Disposer } from "./manifest";
import type { HostImagesApi } from "./conversations";

/** JSON-only messages, delivered to the original main-document owner. */
export interface PluginDetachedAction {
  name: string;
  args: unknown[];
}

export interface PluginDetachedSnapshot {
  revision: number;
  state: unknown;
}

/** Props for a renderer-only component in a native plugin window (0.3.17).
 * No PluginContext, chat identity, storage or execution capability is copied
 * into the new document. A resolved dispatch preserves false business results;
 * rejected/unknown outcomes must never be automatically resubmitted. */
export interface PluginDetachedSurfaceProps {
  snapshot: unknown;
  /** Register a synchronous check for edits still held only by the renderer.
   * Called after the host action queue drains. Returning false keeps the
   * window open; remove the guard on unmount. */
  registerReturnGuard(guard: () => boolean): Disposer;
  dispatch(action: PluginDetachedAction): Promise<{
    sequence: number;
    value: unknown;
    snapshot: PluginDetachedSnapshot;
  }>;
}

/** Named main.js export. The host invokes this factory once in the floating
 * document; it must only create a view and must not activate the plugin again. */
export type PluginDetachedRenderer = (context: {
  react: typeof React;
  /** Pure native discussion renderer. It consumes the owner's JSON projection,
   * and grants no chat, storage, execution or approval capability. */
  ConversationView?: ComponentType<{ conversation: unknown; onAction?: (action: { type: string; path?: string }) => void }>;
  /** Scoped image staging/preview channel for this plugin only (0.3.23); grants no chat, task, storage or execution capability. */
  Images?: HostImagesApi;
}) => ComponentType<PluginDetachedSurfaceProps>;

/** Optional center-tab projection (permission ui:detached-window, desktop
 * only). Controller, drafts, subscriptions and side effects remain owned by
 * the original main document. Snapshots/actions must contain JSON values only.
 * Returning/closing flushes queued actions. Explicit return docks the view;
 * closing preserves its presentation preference but marks it closed. The host
 * remembers geometry and restores open views after restart or maintenance.
 * Plugin disable disposes the window; it does not migrate capabilities. */
export interface PluginDetachedSurfaceDefinition {
  /** Initial presentation when no user preference exists (0.3.22). Defaults to docked.
   * Registration alone never opens a new view; only a previously open view is restored. */
  defaultPresentation?: "docked" | "detached";
  /** Name of a PluginDetachedRenderer export in the installed main.js. */
  rendererExport: string;
  getSnapshot(): unknown;
  subscribe(listener: () => void): Disposer;
  dispatch(action: PluginDetachedAction): unknown | Promise<unknown>;
}
```

## 权限目录

`manifest.permissions` 只接受下表列出的基座权限，或形状合法的 `network:` / `exec:` 授权；未声明能力的调用会抛错，未知权限 = 安装/加载期直接拒绝。

| 权限 | 门禁的入口 |
|---|---|
| `storage` | `ctx.storage.get`、`ctx.storage.set`、`ctx.storage.delete` |
| `ui:settings-section` | `ctx.ui.registerSettingsSection`、`ctx.ui.openSettings` |
| `ui:add-menu` | `ctx.ui.registerAddMenuRow` |
| `ui:composer-status` | `ctx.ui.registerComposerSlot`、`ctx.ui.registerComposerStatusItem` |
| `ui:panel-tab` | `ctx.ui.registerPanelTab` |
| `ui:status-bar` | `ctx.ui.registerStatusBarItem` |
| `ui:command` | `ctx.ui.registerCommand` |
| `ui:markdown` | `ctx.ui.registerMarkdownRenderer` |
| `ui:page` | `ctx.ui.registerPage` |
| `ui:timeline-row` | `ctx.ui.registerTimelineRowRenderer` |
| `ui:session-menu` | `ctx.ui.registerSessionMenuItem` |
| `ui:sidebar-entry` | `ctx.ui.registerSidebarNav` |
| `ui:center-tab` | `ctx.ui.registerCenterTab`、`ctx.ui.openCenterTab`、`ctx.ui.registerUpdateCloseHandler` |
| `ui:detached-window` | `ctx.ui.registerCenterTab` |
| `ui:conversation-mode` | `ctx.ui.registerConversationMode` |
| `agent` | `ctx.agent.catalog`、`ctx.agent.start`、`ctx.agent.interrupt` |
| `theme` | `ctx.theme.injectCss`、`ctx.theme.setTokens` |
| `i18n` | `ctx.i18n.addBundle` |
| `events` | `ctx.events.on`、`ctx.events.emit` |
| `network:none` | — |
| `composer:draft` | `ctx.composer.setDraft` |
| `host:session` | `ctx.sessions.selectSession`、`ctx.sessions.refresh`、`ctx.sessions.setEffort`、`ctx.sessions.registerSource` |
| `host:chat` | `ctx.conversations.catalog`、`ctx.conversations.open`、`ctx.conversations.inspect`、`ctx.conversations.send`、`ctx.conversations.stop`、`ctx.conversations.openFile`、`ctx.conversations.onEvent`、`ctx.images.importImage`、`ctx.images.readPreview`、`ctx.chat.identity`、`ctx.chat.current`、`ctx.chat.inspect`、`ctx.chat.submit`、`ctx.chat.receipt`、`ctx.chat.onEvent` |
| `host:tasks` | `ctx.images.importImage`、`ctx.images.readPreview`、`ctx.tasks.conversation`、`ctx.tasks.sendMessage`、`ctx.tasks.messageReceipt`、`ctx.tasks.cancelMessage`、`ctx.tasks.stopConversation`、`ctx.tasks.conversationAction`、`ctx.tasks.onConversationEvent`、`ctx.tasks.catalog`、`ctx.tasks.history`、`ctx.tasks.excerpt`、`ctx.tasks.plan`、`ctx.tasks.getPlan`、`ctx.tasks.cancelPlan`、`ctx.tasks.submit`、`ctx.tasks.receipt`、`ctx.tasks.list`、`ctx.tasks.cancel`、`ctx.tasks.open`、`ctx.tasks.forget`、`ctx.tasks.slots`、`ctx.tasks.onEvent` |
| `host:memory` | `ctx.memoryExtraction.status`、`ctx.memoryExtraction.checkpoint`、`ctx.memoryExtraction.prepare`、`ctx.memoryExtraction.extract`、`ctx.memoryExtraction.cancel` |
| `host:workspace` | `ctx.workspaces.publishProject`、`ctx.workspaces.add` |
| `host:workspace:remote` | `ctx.workspaces.add` |

### network: / exec: 授权形状

- `network:<host>`（任意端口）/ `network:<host>:<port>` / `network:<host>:<a>-<b>`（含端点，1–65535）。host 精确匹配（大小写不敏感，无通配、子域不命中），仅 http/https。合法示例：`network:127.0.0.1`、`network:api.example.com`、`network:EXAMPLE.com`、`network:api.example.com:8443`。
- `exec:<bin>`：裸二进制名（`^[A-Za-z0-9._-]+$`，禁路径分隔符），精确匹配、大小写敏感。
- `network:none` 是基座权限，语义为「本插件不用网络」，**不是**授权——它永远不放行任何主机。
- 出网/执行只能走 `ctx.bridge.invoke` 的命令表（下表从宿主实现提取；未列出的命令名会被 reject）：

| bridge 命令 | 需要的授权 |
|---|---|
| `plugin_http_request` | `network:<host>` 授权 |
| `plugin_exec_run`、`plugin_exec_spawn` | `exec:<bin>` 授权 |
| `plugin_exec_kill` | 任意 `exec:` 授权 |
| `plugin_agent_start`、`plugin_agent_interrupt` | `agent` |
