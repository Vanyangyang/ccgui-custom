# @ccgui/plugin-sdk changelog

## 0.3.28 — 2026-10-26

- 更新准备可识别 `lifecycle: "plugin"` 服务的所属插件：只有所属插件全部登记关闭钩子、且没有其他阻塞时，才先调用 `prepare` 排空操作并关闭服务；随后仍由原生入口检查进程已退出。正在执行的一次性命令保持阻塞。
- Windows 插件附属进程必须成功加入退出回收 Job，失败则终止启动并报告错误，不能以无回收保护的状态继续运行。
- `plugin_exec_kill({ onlyExited: true })` 只清退已确认退出的本插件子进程登记，最多等 2 秒；任何仍活跃或无法确认退出的进程都会拒绝清理，不以网络不可达代替退出事实。省略参数保持既有主动终止语义。

## 0.3.27 — 2026-10-26

- `tasks.submit`, `tasks.sendMessage`, and `conversations.send` accept versioned `fixedInstructions` after an explicit native capability handshake. Local Claude/Codex launches and resumes load the owned policy through native system/developer instructions, preserving user configuration, task roles and read-only boundaries.
- Profiles are durable and included in request fingerprints. Matching guidance allows live input; changed coordinator guidance stays queued until a full native turn. Omission retains prior guidance. No extra input is sent to restore policy after compaction, and old binaries do not advertise the capability.

## 0.3.26 — 2026-10-25

- `memoryExtraction.prepare` provides a bounded local retrieval hint and a native source digest without model inference. Format 2 extraction fences the selected batch with `expectedSourceDigest` and returns evidence-bound replacement/conflict relations; format 1 clients keep their original response shape.
- Relations remain assistant interpretations, cannot replace user-recorded authority, and require exact offered IDs/revisions plus source evidence. Foreground preemption, project ownership and original cursor semantics remain in force.

## 0.3.25 — 2026-10-25

- `host:memory` adds desktop-owner `ctx.memoryExtraction`: metadata checkpoints, bounded extraction and cancellation for this plugin's owned project discussions/coordinators. Native source validation and fixed Gemini4/Vertex inference do not accept arbitrary transcript input or inject anything into the main chat.
- Foreground admission cancels background inference; quiet-time, request budget and provider backoff limit interference. Results retain exact source evidence and opaque cursors. Plugins own durable queues and atomic saves; generated notes must not silently replace user-confirmed or withdrawn records. Local cancellation does not guarantee an upstream quota refund.

## 0.3.24 — 2026-10-24

- `host:tasks` adds `continuousCoordination`, owned-task `conversation`, `sendMessage`, `messageReceipt`, `cancelMessage`, `stopConversation`, `conversationAction`, and `onConversationEvent`. Follow-ups keep the coordinator's proven native session and use durable input CAS/fences; native acceptance is not requirement application. Unknown outcomes are never replayed.
- Coordinator snapshots project the real host timeline and managed descendants. Stopping and selection locks retain native ownership beyond the initial parent turn; native pending question/plan/grant actions are revalidated against the displayed revision.
- Conversation views support identifiable composite sources, native pending states and source-routed actions. Read-only discussion remains independent of coordinator execution.

## 0.3.23 — 2026-10-24
- `ctx.images` and detached `Images` provide durable, per-plugin host image
  attachments (`importImage` and `readPreview`, up to 8 MiB per raster image)
  under `host:chat` or `host:tasks`, returning opaque descriptors without
  exposing local paths or bloating persisted state/actions with base64.
- `ctx.conversations.send` and `ctx.tasks.submit` accept `images?: string[]`
  (up to 8 owned attachment IDs per turn) and resolve them natively in the main
  owner window before multimodal delivery.
- `ctx.conversations.catalog()` and `ctx.tasks.catalog()` advertise
  `capabilities.images` and per-engine `supportsImages`.

## 0.3.22 — 2026-10-24
- Detached center tabs remember presentation, open state and native geometry.
  `defaultPresentation` chooses the initial mode; user choices take precedence.
  Close, return and maintenance preserve distinct intents and one editor owner.
- Task submissions accept an exact `providerId` with explicit launch choices.
  Native resolution is exposed separately from the requested selection; queue
  waits and slot reuse cannot silently change it. Opening a task raises its host window.
- `catalog().capabilities.nativeCoordination` advertises launch pinning and
  host-managed child routing to registered development members of the same project.
- Session-menu targets include the clicked source's `workspacePath` when known,
  allowing explicit object links without scanning the full chat catalog.

## 0.3.21 — 2026-10-24
- `ctx.conversations` provides persistent read-only native discussion branches
  under `host:chat`, with explicit model/channel choices and independent thread
  identity. It does not create task executions or change global defaults.
- `ctx.conversations.View` and the detached renderer's `ConversationView` reuse
  the host's message presentation without creating a second chat runtime.
- Native window ownership, durable request revisions and exact-run settlement
  protect reload, cancellation and duplicate delivery. Closing a surface does
  not stop its conversation. Unconfirmed recovered runs remain unknown.

## 0.3.20 — 2026-10-23
- `ctx.tasks` (new permission `host:tasks`, desktop only) routes a goal and
  delivers tasks into real GUI conversations. `catalog()` lists engines, local
  workspaces and project organization; `history()`/`excerpt()` read bounded,
  paged chat metadata and text for task indexes and handoffs without copying
  whole histories or changing any chat's cwd or parent/child edges.
- `plan()` runs one isolated, tool-less planner call (claude/codex/pi, the
  active engine by default). Steps can only name candidate project ids, which
  must be registered local workspaces; write paths are normalized into their
  project. Planner output is data and is never executed. Plans are idempotent
  per request id, cancellable, and fail with explicit error codes.
- `submit()` reuses the slot's chat (`sessionMode: "auto"`) or creates a
  background chat without taking focus or touching drafts, with the user's
  model and permission settings. Receipts carry only native session evidence.
  Declared write sets order conflicting requests across plugins (unknown =
  whole workspace, `[]` = read-only); a new chat does not lift a conflict.
  Requests that may have started are never replayed: after a restart they
  become `unknown` and `open()` shows the conversation.
- `ctx.chat` and its receipt contract are unchanged.

## 0.3.19 — 2026-10-23
- `workspaces.publishProject(sourceKey, definition)` publishes a stable project
  view under `host:workspace`. Existing local workspace roots and their children
  can be associated without moving sessions, changing cwd, granting access, or
  migrating the publisher's memory. The source key preserves its project identity;
  the host stores a separate projection owned by the publishing plugin.
- Members have labels and descriptive development/reference roles. The user can
  remove a projection without deleting registered workspaces or project data.

## 0.3.18 — 2026-10-21
- `host.whenReady(signal?)` waits for restored native/UI ownership before a
  plugin starts I/O. UI/chat registrations stay synchronous during activation;
  readers can wait without weakening the handoff admission barrier.
- `ui.registerUpdateCloseHandler({ prepare, resume })` opts a plugin's center
  tabs and selected side panel into automatic closure before a staged runtime
  update. Floating views first drain through their existing return guard;
  `prepare(signal)` freezes actions and durably saves drafts before the host
  closes views. Cancellation/failure calls `resume`; unresolved edits remain
  protected. The plugin and its chat bridge stay loaded until normal handoff.
  Loaded handlers also prepare with closed views to settle background work.
- This requires `ui:center-tab`, has one handler per plugin, and does not cover
  overlay pages or grant another plugin permission to close a view. Plugins
  without a handler retain their existing update blocker.

## 0.3.17 — 2026-10-21
- `registerCenterTab({ detached })` adds an optional native pop-out/return
  surface under the separate `ui:detached-window` permission. A named renderer
  export receives React, a JSON snapshot and a bounded action channel. The
  original main document retains the controller and all host capabilities;
  the floating document never calls `activate` or creates another chat bridge.
- Return and native close flush queued UI actions before focusing the original
  tab. Duplicate actions cannot resubmit work; stale owner/window identities
  fail explicitly. Plugin reload/disable and application exit close the window.
- Open plugin windows block runtime handoff until returned/closed, just as
  plugin tabs without a checkpoint do; this API does not claim restart recovery.

## 0.3.16 — 2026-10-03
- **Claude 原生生命周期的用量语义（契约澄清，API 形状不变）**：宿主不再在 Claude
  回复结束时立刻收尾——后台任务与自动续答期间进程保持存活，每次响应结束产生一个
  引擎 `turn_complete`（CLI 已报告会话状态事件，或响应结束时仍有后台任务；
  两者都没有的旧版 CLI 见下），只有真正空闲且无后台任务时才发终态 `done`。
  - `usage://updated`：每次响应的用量由宿主从 `turn_complete.data.usage` 合成
    `kind: "usage"` 发出（沿用该事件的 `ts` / `genMs`），此时运行可能仍在继续。
  - `usage://done`：终态 `done.data.usage` 可为 `null`，响应用量已在 `usage://updated`
    上报、不会重复；累计请合计 `usage://updated` 与非 null 的 `usage://done`。
    既不发会话状态事件、响应结束时也没有后台任务的旧版 Claude CLI 行为不变（一次性
    `done`，仍只经它上报，没有 `turn_complete`）；不发会话状态事件但响应结束时
    仍有后台任务（`task_started` 的 `is_backgrounded=true`）的旧版 CLI 同样先发
    `turn_complete`（经 `usage://updated` 上报），其后的终态 `done` 携带自己的
    `usage`，合计规则不变。
  - `ctx.agent`（`agent://<pluginId>` 流）为原样透传，Claude 的用量在
    `turn_complete`（`data.usage`，每次响应一次；上述一次性旧版 CLI 例外，仍只在
    `done`）上，不做 `usage` 合成；新增仅供展示
    的 `tasks`（`data.tasks` 全量原生任务目录快照）与 `activity`
    （`data.state` ∈ `running | requires_action | waiting`）两种 kind。消费方须忽略
    不认识的 kind；`done` / `error` 才是整个运行的终态。
  - **宿主打断一次响应**：宿主 UI 在 Claude 原生运行里只打断当前回复（CC GUI 里
    后台任务运行期间的 Stop；进程与后台任务继续存活）时，被打断的响应在 CLI 确认后
    以 `turn_complete` 结束，`data` 为 `{ usage, interrupted: true }`（`data.interrupted`
    仅此情形出现，其余缺省 / false）。它既不是 `error` 也不是终态：其后运行进入
    `activity: waiting`（仍有后台任务），或在没有后台任务时发最终 `done`。消费方不得
    把它当作失败或整个运行的收尾。被打断响应的 usage 可能为零（真实 CLI 不为它计用量），
    `usage://updated` 仍照常携带它（usage 为 null 时不发更新；话题的 `data` 只是用量，
    不带 `interrupted`）。`ctx.agent.interrupt()` 是终止进程树，不会产生该标记；插件
    自启的 run 不受宿主 Stop 影响，`ctx.agent` 流对宿主事件原样透传、不剥离该字段。

## 0.3.15 — 2026-09-23
- **payload 增强**：引擎事件 wire payload 新增 `genMs`（宿主实测生成窗口毫秒数）——只出现在 `usage` / `done` 事件上，计量该报告对应的模型
  真实生成时间：从响应流打开（引擎 message_start，或首个文本/思考 delta）
  到流关闭，工具执行、用户等待与轮间隔全部排除。插件用它算 tok/s
  （output token ÷ 生成窗口）即得不含工具等待的生成速度；字段缺失时
  回退旧的相邻报告 `ts` 间隔。首个消费者：token-meter 插件。

## 0.3.14 — 2026-09-23
- `ui:conversation-mode` / `ctx.ui.registerConversationMode({ key?, label, component })`
  注册当前会话内的替代界面。`PluginConversationProps` 提供稳定的 `conversationId`、
  `workspacePath`、`language` 与 `onExit`；普通会话发送中或队列非空时不可进入。
- `PluginConversationProps.setExitBlocked?(blocked)` 供插件在 layout effect 中报告
  忙碌/恢复状态；锁定时宿主禁用退出按钮且拒绝 `onExit()`。锁按会话挂载隔离，
  切换会话后旧回调不能退出新界面；空闲状态下仍可从崩溃边界返回普通对话。
- `ctx.agent.catalog(workspacePath)`（`agent` 权限）只返回引擎可用性、只读能力、
  渠道与模型的 ID/显示名，不返回配置、认证或环境变量。模型探测不可用时为 `[]`，
  引擎与配置读取失败仍会 reject。禁用的引擎不出现在列表中。
- `ctx.agent.start` 新增可选 `readOnly`；只读能力以 native 实现为准，目前仅 Pi
  支持隔离只读调用；Codex 不宣称支持。未提供时保留既有行为。
- `start({ requestId? })` 接受 32 位十六进制请求标识，native 生成
  `pa-{pluginId}-{requestId}`；插件可在启动前持久化预期 run id 来恢复早到事件。
  `interrupt(runId): Promise<boolean>` 保留 native 返回值：`true` 为已路由中断
  （仍需等待终态事件），`false` 为没有匹配的活动 run。

## 0.3.13 — 2026-09-21
- **新增能力 `agent`**：`ctx.agent.start/interrupt` 让插件经宿主引擎管线
  运行 agent 轮次——与聊天发送共用 spawn/reader/registry（渠道注入、进程
  注册、中断），事件走独立的 `plugin-agent://event` 流，前端按 run id
  属主前缀路由到 `agent://<pluginId>` 总线话题。插件 run 不会进 chat
  store，也不被 chat 的 Stop 误杀。桌面专属。
- 权限单一事实源新增 `agent`；通用 bridge 白名单同步放开
  `plugin_agent_start` / `plugin_agent_interrupt`。

## 0.3.12 — 2026-09-21
- **新增扩展点 `ui:sidebar-entry`**：`ctx.ui.registerSidebarNav` 在首页侧栏
  内建「自动化」入口之下注册导航项（label/icon/order/onOpen），经宿主
  `sidebarNavRegistry` 渲染，与内建导航同一 chrome。
- **新增扩展点 `ui:center-tab`**：`ctx.ui.registerCenterTab` 注册中心页签
  定义（title/icon/component），`ctx.ui.openCenterTab(key?)` 打开或聚焦——
  页签与会话/文件/浏览器共享中部页签条，组件渲染在 PluginBoundary 内。
  打开未注册的页签会抛错（失败必须可见）。
- 权限单一事实源 `spec/permissions.json` 新增上述两项；TS/Rust/模板校验
  全部自动派生。

## 0.3.11 — 2026-09-18
- **修复权限漂移**：`registerComposerSlot` 运行时一直校验 `ui:composer`，
  但该字符串在 0.3.9 改名为 `ui:composer-status` 时未同步更新
  （`spec/permissions.json` 的 `knownPermissions` 早已只保留
  `ui:composer-status`），导致 `registerComposerSlot` 自 0.3.9 起对任何
  manifest 声明都必然拒绝——没有任何权限字符串能通过校验。改为校验
  `ui:composer-status`，与 `registerComposerStatusItem` 共享同一权限，
  两个注册点现在都能正常声明使用。

## 0.3.9 — 2026-09-16
- **新增能力**：`ctx.ui.registerComposerStatusItem({ key?, component, order? })`
  （新权限 `ui:composer-status`）——在 composer 状态行（分支/上下文用量那行）
  左组、分支切换器之后渲染 chip。首个消费者：token-meter 指标插件从底部状态栏
  迁至会话工具行。

## 0.3.8 — 2026-09-16
- **新增能力**：`registerStatusBarItem` 的 `zone?: "start" | "end"`——`"start"`
  把 chip 渲染到状态栏左对齐区（内建控件簇左侧），缺省/`"end"` 保持既有槽位
  （同步状态之后、版本号之前）不变。首个消费者：token-meter 指标插件。
- **新增宿主话题**（权限 `events`）：`usage://done`——引擎 done 事件透传
  （payload 同 EngineEventPayload，`data.usage` 携带该轮最终用量；claude/grok
  等只经 Done 上报用量的引擎由此对插件可见）；`session://activated`——活动会话
  切换，payload `{ engine, sessionId }`，pending 标签 sessionId 为 null，无活动
  标签时两者皆 null。
- **payload 增强**：引擎事件 wire payload 新增 `ts`（宿主发射时刻，Unix 毫秒），
  前端 `EngineEventPayload` 同步为 `ts?: number`；插件可用它算吞吐而不受 IPC
  批量/到达抖动影响，旧宿主上缺省回退到达时间。

## 0.3.7 — 2026-09-16
- **新增能力**：`ctx.sessions.refresh()`（复用权限 `host:session`）——请求宿主立即
  刷新会话目录（侧栏/标签页）。插件绕过宿主直写会话数据（sqlite custom_title、
  转录 title 行）后调用，变更即刻可见，不再依赖手动同步或重启。首个消费者：
  auto-title 命名/自愈补写后即时刷新侧栏。

## 0.3.6 — 2026-09-16
- **新增能力**：`ctx.ui.openSettings(key?)`（复用权限 `ui:settings-section`）——跳转到
  本插件的设置页（hash 路由 `#/settings?page=plugin:<id>[:<key>]`），供状态栏 chip、
  面板按钮等做深链入口。首个消费者：auto-title 状态栏 chip 点击改跳设置页。

## 0.3.5 — 2026-09-16
- **新增能力**：`ctx.ui.registerSessionMenuItem({ key?, label, icon?, danger?, run })`（权限
  `ui:session-menu`）——在侧栏会话右键菜单追加一行，`run` 收到打开菜单的会话
  `{ engine, sessionId }`；label 为 thunk，语言切换即时重命名。首个消费者：auto-title
  插件的「重新命名（自动命名）」菜单项。

## 0.3.4 — 2026-09-14
- **新增能力**:`ctx.sessions.registerSource({ id, list })`(权限 `host:session`)——登记
  外部会话源(远程机/容器内 CLI 的会话摘要),宿主在会话目录刷新时调用 `list()` 并把行合并进
  侧栏列表;本机扫描结果优先,行 `workspacePath` 须为已登记工作区 path。配套类型
  `ExternalSessionRow`;返回 Disposer,卸载自动注销。
- **新增权限**:`host:workspace:remote`——`ctx.workspaces.add` 的 meta 携带 `wsl` 键
  (远程工作区,宿主引擎经 ssh 把会话流量导到插件指定主机)时必需;仅 `host:workspace`
  的插件不能再设置远程 meta。等效于出网 + 远程执行导向,故独立于工作区登记授权。
- **修复**:`events` 权限条目在权限 spec 中被误删导致存量插件无法加载的问题,已恢复
  (契约本身无变化)。
- **加固**(宿主侧,契约不变):registerSource 入口校验 def 形状;同步抛错的会话源被
  隔离(不再连累其他源与整轮刷新);外部行字段类型校验 + 单源 500 行上限;
  `selectSession` 的错误统一走 Promise rejection。

## 0.3.3 — 2026-09-13
- **新增能力**:`ctx.workspaces.add(path, meta?)`(权限 `host:workspace`)——把任意路径
  登记为侧栏工作区,不要求本机存在该目录(远程机/WSL 发行版内路径);meta 透传存储,
  如 `{ wsl: { hostId, distro } }`(0.3.4 起携带 `wsl` 键需 `host:workspace:remote`)。
- **新增能力**:`ctx.sessions.selectSession(engine, sessionId, workspacePath)`(权限
  `host:session`)——按引擎 + 会话 id 打开/恢复既有会话;未知组合抛错,不静默。
- 注:0.3.3 未单独发布,上述能力随 0.3.4 首次落地;版本戳保留以标注能力引入序。

## 0.3.2 — 2026-09-12
- **新增能力**：`ctx.composer.setDraft(text)`（权限 `composer:draft`）——写入当前活动会话的
  聊天输入框草稿；替换语义，不触发发送。配合既有 `composer://draft` 事件（host→plugin）构成
  草稿的双向通道；react-doctor 的「一键修复」填入修复提示词即首个消费者。

- **spec 单一事实源**：`KNOWN_PERMISSIONS` 改为从包内 `spec/permissions.json` 生成；
  授权形状/放行测试向量由 TS、Rust（include_str!）、模板校验脚本三方共享，漂移在 CI 暴露。
- **模块拆分**：`src/index.ts` 拆为 manifest / permissions / version / registry / context
  五个关注点模块，index.ts 变为纯 re-export barrel（导出集合不变）；manifest/permissions/version
  零运行时依赖，Node 校验脚本可直接 import。
- **新增导出**：`scopedPluginId` / `pluginIdFromRegistryKey` / `compareByOrder`
  （注册表条目 id 构造/逆运算与 order 排序比较器）。
- **修复**：`satisfiesSdkRange("^0.0", "0.0.0")` 此前误判 false——`^0.0` 省略 patch
  现在正确地匹配任意 0.0.x（与文档化的 `^0.2` 省略语义一致）。
- **修复**：`compareVersions` 遇到非数字段（"0.a.1"/"latest"）现在抛出明确的 Error，
  不再静默返回 NaN 使比较失真。
- **修复**：`parseNetworkGrant` 拒绝把 `none` 当作授权 host——`network:none` 是基座权限
  （声明无网络），永远不是授权；此前 `network:none` 会被解析成放行主机 "none" 的 grant
  （与 Rust 侧行为对齐，spec networkAllow 向量覆盖）。
- `plugin_exec_spawn` 桥命令成功时 resolve 为 void（Rust 返回 ()），文档同步更正。
- 新增 `src/contract-check.ts`：类型层面把守 plugin.d.ts 与 src/* 的双向漂移
  （纯数据类型双向可赋值；PluginContext 各能力组 key 完全对齐）。

## 0.3.1 — 2026-09-09

- `plugin_exec_spawn` 新增可选 `lifecycle: "detached" | "plugin"`（缺省 detached，行为不变）；
  `"plugin"` 的子进程由宿主跟踪，插件禁用/卸载时自动 kill。
- 新增 `plugin_exec_kill`：kill 本插件全部 lifecycle="plugin" 子进程（改名重启用；需任意 exec: 授权）。
- 动机：prompt-shield 类插件的附属代理进程需要随插件生命周期回收；tokentracker 类用户级服务保持 detached。
- 加载器修复：`styles.css` 现在对 js 插件也自动注入（此前只有 declarative 注入，js 插件的样式文件产而不装——prompt-shield 设置页"样式丢失"即此因）。样式表属三件套产物，不走 `theme` 运行时权限门；远程引用拒止仍生效。

插件系统契约包的独立版本史。宿主运行时随 app 发版，本包版本表达**契约**的演进；
插件经 manifest `sdkVersion` range 声明兼容区间（VS Code `engines.vscode` 同款模式）。

## 0.3.0 — 2026-09-09（breaking：通用能力出口）

- **breaking**：`cmd:<command>` 逐命令授权机制整体删除（`GRANTABLE_COMMANDS` 移除）；
  `tt_proxy` / `tt_detect_cli` / `tt_server_status` / `tt_install_cli` / `tt_ensure_server`
  五条 usage-stats 专属桥命令随宿主侧 tokentracker.rs 一并退役。
- 新增通用能力出口三条：`plugin_http_request`（域名白名单 HTTP 代理，响应文本上限 8MB）、
  `plugin_exec_run`（二进制白名单进程执行，stdout/stderr 各截 64KB，超时上限 300s）、
  `plugin_exec_spawn`（detached 后台进程）；`pluginId` 由宿主自动注入。
- 新增授权语法：`network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>`
  （host 精确匹配，大小写不敏感，无通配/子域）与 `exec:<bin>`（裸名，禁路径分隔符）。
- 新增导出 `isKnownPermission` / `networkGrantAllows` / `execGrantAllows`
  （宿主 permissions.ts、模板 validate-manifest.mjs、Rust plugins.rs 四处锁步）。
- usage-stats 插件自 1.1.0 起适配本版契约（`sdkVersion: "^0.3"`）。

## 0.2.0 — 2026-09-09（Phase 2）

- 扩展点注册化全部落地：新增 `registerComposerSlot`（ui:composer）、`registerPanelTab`（ui:panel-tab）、
  `registerStatusBarItem`（ui:status-bar）、`registerCommand`（ui:command）、`registerMarkdownRenderer`
  （ui:markdown）、`registerPage`（ui:page）、`registerTimelineRowRenderer`（ui:timeline-row）。
- 新增 `manifest.sdkVersion` 版本握手 + `ctx.host.sdkVersion` + `satisfiesSdkRange`。
- manifest `contributes` 补齐 Tier-0 `statusBarItems` / `commands`。
- 权限全集 14 项；`KNOWN_PERMISSIONS`/`GRANTABLE_COMMANDS` 移入本包作为单一事实源。
- 契约包首次独立成包：类型/Registry/注册表单例/版本常量从 `features/plugins/` 收敛至此。

## 0.1.0 — 2026-09-08（Phase 1，追溯记录）

- 初始契约：`PluginContext`（ui.registerSettingsSection/registerAddMenuRow、theme、i18n、storage、
  events、bridge.invoke、host）、`PluginManifest`、`Registry`/`useRegistry`、分层信任 Tier-0/1/2。
