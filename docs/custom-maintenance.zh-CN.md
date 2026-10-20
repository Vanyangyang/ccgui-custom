# CC GUI 定制维护

维护目录：`ccgui-custom`，分支：`custom/protected`。
`upstream` 指向官方 GitHub 仓库；`origin` 指向同级本地裸仓库
`../ccgui-custom-backup.git` 作为本地维护备份。
原始兼容性工作目录保留不动。

## 当前补丁

- 独立 Spellcast 工作台、连接配置、授权与旧 IPC/Web API 已退役，不保留旧服务兼容。内置完成提醒、旁白和交互回答由 CCGUI 持有，见 [助手提醒](./assistant-notices.zh-CN.md)。旧回发插件 `spellcast-canvas-bridge` 自动停用并按插件 ID 拒绝再次安装或启用，应用保留文件与历史 KV、不自动清理，手动删除后拒绝与检查点保留照常；更新不访问外部服务、不读取或迁移其数据。

- 既有宿主/插件兼容修改保存为基线提交。
- 自动压缩窗口修改与显示同步单独提交，默认沿用用户的 750K。
- Claude 订阅额度采用 CLI 的登录、控制读取及正常请求中的窗口快照。
- 额度在输入框下方常驻小型状态入口，与 750K 上下文控件分开；正常对话更新自动通知界面，点击查看详情。
- Claude 额度详情只显示 5 小时和 7 天窗口。邮箱与计划仅在缓存里已经有值时显示；`setup-token` 拿不到这两项，不显示「未提供」。详情没有「更新信息」。
- 常驻额度百分比左侧显示重置时间：五小时显示本地时分（跨日带日期），七天带日期与时分，跨年带年份；悬停查看完整时间，窄状态栏换行。
- 官方安装器更新停用，避免覆盖定制代码；应用显示定制版本标识。
- 外网中继每次重试读取应用代理设置，通过显式 HTTP CONNECT 隧道连接 Worker；仅代理端点在本机解析，中继域名交给代理。代理未启用、地址缺失或不支持、连接或握手失败时拒绝直连并保留重试。中继目前要求无认证的 HTTP 代理（本机现有 `http://127.0.0.1:7897`）；TLS 仍校验原中继域名与证书。到本机桥接的 loopback 请求保持本地直连。
- 本机桌面 Claude / Codex 原聊天挂载内置 `ccgui` MCP：`list_chats` 查询已保存聊天，`send_message` 后台加载并投递到目标，`get_message_status` 查询发送方隔离的回执。空闲目标通过正常 resume 启动；忙碌、审批或残留进程期间排队。复用目标模型/effort/渠道与当前权限，不使用 Claude 原生 `SendMessage` 寻址 GUI 聊天。插件 agent、只读任务节点和 WSL 不挂载此入口；本机 relay 按进程轮次令牌鉴权，实际进程结束才撤销令牌。
- 受信任的普通本地运行和已登记的 worker 可直接使用 `task_spawn`、`task_list`、`task_wait`、`task_send`、`task_renew`、`task_stop` 创建和管理混合引擎子任务，无需开启模式。父会话仅能管理自己创建的直属子任务，由宿主核验真实父子关系与冻结的运行权限；通过 `send_message` 咨询已有会话仍需针对目标的明确授权，双方保持独立，不建立托管关系。能力响应使用 `taskTools`；旧 `leader_*` 公共工具已移除，不保留别名。已完成的子任务保留聊天历史、任务正文、结果和关系；TTL 到期只触发检查，不自动删除或重派，删除与回收由用户通过 GUI 执行。
  - 设置 → 协作 → 子任务模型可分别限定 Claude/Codex/AGY 新子任务的模型；Cursor 使用下述勾选规则。前三个引擎的 `leaderAllowedModels` 项缺失表示未配置并拒绝新委派，显式 `null` 才表示用户保存的不限制，空数组表示禁止新建该引擎子任务，非空数组按精确模型 ID 限制。已有数组不迁移或扩大，旧缺项不当作授权；`task_list.modelPolicy.configured` 明确返回配置状态。模型 ID 可为 CLI/渠道别名；选择范围不保证对应模型已安装、可用或具有特定能力。外部 MCP 不自动经过 `task_spawn`，本机 Cursor Bridge 需单独绑定发送前 admission 适配器；未核对适配器绑定或旧进程未重载时，不宣称外部链已受保护。
  - `task_spawn` 在预留和启动前读取设置，拒绝范围外的显式模型；省略 model 时优先使用范围内的该引擎默认模型，否则使用首个已选模型。`task_list.modelPolicy` 返回各引擎的 `allowedModels`（不限制时为 null）和解析后的 `defaultModel`，供父会话先查询再选择。effort 可按引擎支持选择，省略时沿用该引擎默认设置。Claude/Codex/AGY 模型限制只影响未来创建的子任务；主会话、已有子任务和已有会话咨询保留原设置，子级继续创建新子任务时同样校验。
  - Cursor 仅提供模型勾选与保存：缺项、旧 `null`、`[]` 均无可用模型。普通对话、旁聊、子任务和接入的 Cursor Bridge 每次启动均校验已保存名单，不论从哪个引擎发起；默认模型不是授权，取消勾选并保存后下一次请求即拒绝。复用 `leaderAllowedModels.cursor`，不增加独立策略配置；其他引擎继续使用原有三态规则。
  - 子任务协作围绕用户指定的一件任务展开，保持该任务的目标、授权范围和完成条件；子级继续委派也属于同一任务。它不获得跨任务或全局常驻助手的权限。完成、归档和删除仍是不同状态。
  - 复杂任务先做必要的最小调查并简述分工：主对话承担什么、委派什么及理由。独立可追踪或较长的工作优先用 `task_spawn`，进入会话树的状态、TTL 和结果管理；引擎内部 Agent 留作短小只读辅助。人数、岗位及模型由父会话按任务判断，不值得分派时简述理由后直接处理。
  - 主对话保留关键判断、必要实现、集成与验收；收到子结果后核查实际交付物和验证证据，处理重要缺口并统一汇报。子聊天已完成不等于用户任务已完成；需要结果时本轮继续等待，审批仍由用户在对应子聊天处理。
  - 默认 TTL 取子引擎：Claude Code 3600 秒、Codex / AGY / Cursor 1800 秒；显式 `ttl_seconds` 优先，GUI 续期留空也取子引擎默认。已有截止时间和请求重放保持原值。过期与到期时间可查看，只有过期且可靠的有效上下文占用达到 50% 时建议考虑压缩，用量或窗口未知不猜测；建议不执行压缩、停止、重派或删除。
  - 新对话通过正常发送入口启动，不需要模式开关或专用首次发送入口。首次运行在模型任务之前注入协作说明，取得真实会话 ID 后核对启动前的历史身份与其他运行的认领，再预留别名并确认身份来源，成功后才采用会话身份。启动期间被扫描器新索引的同工作区会话可以正常采用，启动前已存在、归档或被其他运行认领的身份会被拒绝；失败不会伪造历史记录或写入旧角色标记。已登记 worker 恢复时保留原权限、启动前身份基线与新根来源，并要求匹配的活动路由代理。
  - 本地 GUI 使用 `task_snapshot` 读取真实父子关系、`task_branch_action` 管理子任务、`task_delete_branch` 删除指定子树，并通过 `task_group_action` 对根会话和全部后代整组归档、恢复或删除；变化事件为 `task://changed`。归档和恢复保留记录与关系，永久删除必须由用户在本地 GUI 明确确认。GUI 删除路径使用内部子树回收，清理宿主保存的任务正文、结果副本和会话转录，并保留必要的身份与请求摘要防止重复执行；这些删除命令不暴露给模型。
  - `task_stop` 和进程退休只结束运行、释放运行围栏，不删除聊天转录或结果；归档与永久删除仅在整组已无执行、等待人工、启动或待投递的任务，且相关进程确认退场后接受，否则立即报错，由用户先等待或明确停止，不隐式等待或终止运行。不能把收到结束事件当成转录已删除。
  - 插件 agent、任务节点、受限工具和隔离发送不因工具名称或说明文本获得子任务管理能力，但同样登记运行围栏：不能续跑受托管子会话、回收墓碑或仍有孩子的根会话；只有旧角色标记、没有真实管理关系的会话不因此被禁止。它们的事件只进各自的事件流。
  - 原生会话 ID 先在协作管理器预留，reader 抢到进程登记表里的会话别名后才提交；别名已属于另一个活进程时，预留释放、运行报错，不宣布也不记入分支，回收不会删除别人的会话。回收开始后才到达的首个 ID 只记入分支供删除转录，不采用、不宣布。
  - 已结束的独立运行可以用同一 run ID 重试，但必须等旧运行真正退场；被拒绝的重试不会提前退休旧运行，旧运行晚到的结束也不会退休新运行。
  - 子聊天的 CLI 进程带 `CCGUI_LEADER_CHILD=1`（父级派出的运行和在子聊天页签里发的消息都算），CLI 启动的钩子与 Codex notify 会继承；本机 Spellcast 据此不为子聊天弹完成气泡，结果由父级汇报。根会话和其他运行不带，应用自身继承到的同名变量也会去掉。
  - `task_wait` 只为调用期间新完成、失败、停止、到期或转入等待人工的子任务提前返回（`changedBranchIds`），调用开始时已就绪的不算；全部就绪时立即返回，否则最多等 20 秒。子聊天结束不会唤醒父级，父级需要结果时要在本轮里继续等待。
  - Codex app-server 的启动命令里所有 `-c` 必须放在 `app-server` 子命令之后：Codex 0.159 只保留最后一处出现的 `-c`，子命令前的 `ccgui`/电脑操控 MCP 覆盖会被子命令后的 effort、服务等级或渠道覆盖整体丢掉，模型因此看不到 `task_*` 等工具。
- 普通聊天续写的 Codex 线程被 Codex Desktop 占用时（`already has an active writer`），这次发送交给 Desktop 执行，CC GUI 只显示进度和 Desktop 产生的内容（`engine/codex_desktop.rs`）。通道是 Desktop 给自己代理用的本机 app-tools 命名管道 `\\.\pipe\codex-browser-use-<uuid>`，未公开、随 Desktop 版本可能变化：靠 `tools/list` 识别，用 `send_message_to_thread` 投递、`read_thread` 跟进，每次调用单独连接。Desktop 用该任务自己的模型、推理强度和权限；带图片、计划、「手动」权限、托管子任务协作、电脑操控或工具限制的消息不交出。Desktop 把交接记成 `<codex_delegation>` 工具输出，模型看到的是转交而非手打的消息；Spellcast 的投递也是同一形式，所以交出前把消息的 SHA-256 记进 `codex_desktop_prompts`（不存原文），聊天记录只把摘要对得上的交接显示为用户消息。目前只支持 Windows；插件 agent、任务节点不走这条路。
- 原生自动命名会话默认关闭，设置 → 通用 → 行为可选 Sonnet（默认）或 Haiku。受信任的本地 GUI 对话（含托管子聊天）成功回复后防抖 4 秒，读取最近 5 轮，经隔离 Claude 调用决定保持原标题或改成「emoji 对象｜目标」。WSL、插件/任务事件、未采用的会话身份、失败和中断轮次不触发；桌面与 Web 共用原生调度，同一会话一次只执行一个后台自动命名请求。
  - 问候、未变的对话不调用模型；已有命名基线后，连续简短确认最多跳过两轮。标题检查包括结构、48 字上限及路径、链接、邮箱、电话号码；写入事务重新检查当前手动标题、归档、命名开关、会话/工作区/转录身份、实际转录内容与同工作区其他活动会话的最终显示标题。期间新增对话或取消运行会丢弃旧建议；实际文件与 SQLite 分属两种存储，不能宣称两者严格原子提交。
  - 显示优先级为手动标题、自动标题、首条消息。自动标题及跳过轮次基线放在独立表，不修改原生转录；清除手动标题即解除锁。重命名弹窗可显式生成建议，用户确认后才保存为手动标题；生成期间编辑、关闭弹窗或切换会话均不会被晚到结果覆盖。建议请求不保存标题/基线，但允许刷新派生历史索引。
  - `engine/side_call.rs` 沿用正常 Claude 的渠道和代理，关闭会话保存、hooks、MCP、技能与工具，使用结构化输出。超时、输出超限、取消和失败都会回收本次调用的进程与临时渠道文件；输出限制为 stdout 256 KiB、stderr 64 KiB，不记录完整对话或凭据。命名规则的 MIT 署名保存在 `src-tauri/src/auto_title/NOTICE`。
  - 当前不提供独立命名用量记账或写回 Codex 原生标题。真实模型冒烟与真实应用回复后侧边栏更新是不同验证，不互相代替。

## 上游升级

本节的 `maint:integrate` 与下节 `maint:install` 是维护者专用的旧式流程，包含本地备份远程与保护启动器约束，不是普通 GitHub 用户的安装步骤。普通用户按 [README 安装说明](../README.zh-CN.md#从-github-安装与自开发热更新ccgui-custom) 在同一干净检出中执行 `pnpm install --frozen-lockfile`、`pnpm maint:check`、`pnpm maint:build`，然后运行生成的 Windows NSIS 安装包。

Windows GUI 启动的单实例围栏位于 `src-tauri/src/single_instance.rs`，入口在 `lib.rs` 的共享启动副作用之前。按 canonical 应用数据目录散列取 Global named mutex，owner guard 绑定主线程；已存对象必须检查实际 ownership/abandoned 状态。只有已发布主窗口标记可激活；退出及重启撤标但不提前放锁。窗口已恢复后的前台权限拒绝只触发有限任务栏提醒，重复进程正常结束，不能误报启动失败；锁访问、恢复和身份错误仍失败退出。`--host-chat-mcp` 与 `--computer-use-mcp` 必须先分流，不能因为复用同一可执行文件被误限制。升级后需回归早期并发、正常/异常退出接替、窗口恢复、应用内重启与两种 MCP 在 GUI 运行时的元数据握手；不要把安装后暂时只有一个进程当成防双开验证。

TPS 是独立元数据链，不能复用旧 `genMs` 或上下文占用直接相除。Claude `result.usage` 为每次主循环回复累计输出，`modelUsage`/cost 为会话累计且可包含子代理，两者不能混用；assistant 快照的输出数是占位值，纯生成计数只接受最终 SSE 用量。Codex 仅以可信启动前基线或新线程零基线做当前 turn 累计差，缺基线、累计回退、身份错配不报数；纯生成还须排除 reasoning、工具、重试和非流式。前端按 run/seq 隔离，所有终态样本先于 terminal 下发。改动时验证重复、恢复、快完成、续轮、取消、异常、历史竞争及统计不修改正文/运行状态；不为显示数值增加轮询或改变现有用量账本。指标定义参见 [NVIDIA AIPerf](https://docs.nvidia.com/aiperf/reference/ai-perf-metrics-reference)，Claude 字段范围参见[官方用量说明](https://code.claude.com/docs/en/agent-sdk/cost-tracking)。

定制版的隐私边界必须随升级保留：应用不加载统计脚本或发送统计 beacon；页面脚本和图片只允许打包及本地来源；插件 HTTP 请求不自动跟随重定向。`maint:check` 包含页面策略与原生插件网络回归，防止合并上游时恢复这些入口。正常模型请求仍按 CLI 配置发送上下文；同窗口可执行插件不是安全沙箱，只启用经过核查的插件。

本机隐私清理另外在用户数据中禁用了 `auto-title`，并设置 `paused=true`、`config.enabled=false`。这不是安装包内的全局插件封禁；重新启用或重装该插件前，需要重新决定是否允许额外发送近期聊天给命名模型。远程 relay 按用户在设置中的开关启用，安装和诊断不读取或输出用户的中转密钥。

1. 在维护仓库提交并推送当前改动，执行 `pnpm maint:status`。
2. 执行 `pnpm maint:integrate vX.Y.Z`。工具沿用用户进程环境与 Git 代理设置拉取上游，
   核对固定官方 upstream 与本地备份 origin，在 `../ccgui-integrations/`
   创建唯一候选工作树和整合分支，不修改当前工作目录。只接受明确的安全 tag/commit；
   已记录或已包含于当前 HEAD 的提交返回 `already_integrated`，不创建候选、不增加修订号。
   成功合并后记录新基线和修订号，提交并推送到本地裸仓库备份。
3. 如果报告冲突，在报告目录逐项解决并提交、推送。不得用整文件覆盖代替
   核对上游功能。检查 `.custom/manifest.json` 中的上游基线与补丁修订号，
   更新 `src/version/changelog.ts` 的中英文记录。
4. 在候选目录运行 `pnpm install --frozen-lockfile`、`pnpm maint:check`。
   隐私边界、类型、完整 Vitest、原生额度、自动命名及隔离调用、单实例和启动模式、中继代理传输、旁路 TPS 和原生任务停止、宿主聊天、内置助手提醒与完成队列、插件网络、Leader、隔离发送链路与差异检查全部通过才会记录验证结果。
   检查开始与结束必须属于同一干净提交；期间源码变化则拒绝记录，需重新验证最终版本。
5. 运行 `pnpm maint:build`。它只接受已经提交且通过检查的同一版本，
   生成带 `+protected.N` 标识的 Windows 安装包；成功后写入
   `artifacts/custom-build.json`，记录源码 HEAD、版本、可执行文件绝对路径和 SHA256、
   安装包路径及构建时间。过期或失败产物不会生成新的构建记录。
6. 关闭所有客户端后运行 `pnpm maint:install`，通过「代理保护」入口启动，
   核验窗口设置、额度、失败反馈及原有常用功能后，才推广候选分支。

## 安装与恢复

`maint:install` 不接受自定义安装路径、可执行文件路径、网络或令牌参数。
它要求当前源码干净，检查记录和构建记录都属于同一 HEAD，且实际二进制 SHA256
与构建记录一致。固定安装位置为
`%USERPROFILE%/AppData/Local/Programs/CCGUI/ccgui-next.exe`。
通过 Windows 进程查询发现任何 `ccgui-next.exe` 时拒绝安装，不自动结束用户工作。

旧程序先保存到仓库 `artifacts/custom-install-<唯一编号>/`，复制后再次核验 SHA256；
复制失败或校验不一致时恢复备份。原有「CC GUI（代理保护）」快捷方式及保护脚本
保留，成功后只启动该快捷方式。普通 `Desktop/CC GUI.lnk` 如存在则在绝对路径与
目录边界检查后移入同一备份目录。脚本拒绝符号链接和 junction，不递归删除现有路径。

固定安装路径和正式 profile 下 `runtime-updates/releases/<manifestSha256>/ccgui-next.exe`
在进程内执行启动保护：强制本机 `127.0.0.1:7897`、收紧 `NO_PROXY`、写入 WebView2
代理参数，并在打开图形界面前检查 Claude 路径、代理预检、当前实际 EXE 的防火墙边界
和 WebView2 策略。不通过则弹窗退出。候选、提交后重定向与回退都经过此检查；保护
进程运行期间拒绝关闭或改动代理。直接启动受保护版本的普通快捷方式即可。旧式覆盖
安装脚本仍要求外部保护快捷方式；自更新使用下述原生协调器，不依赖这个快捷方式。
开发 profile 和其它路径的构建不启用门闩，应用不会静默安装防火墙规则。

已审核的 Claude 路径必须写在 `settings.json` 的顶层 `claudeBin`，与应用的实际
引擎解析一致。旧脚本曾读取嵌套 `binOverrides.claudeBin`，该字段并不设置应用的
Claude 启动路径；维护脚本和原生门闩都按顶层字段校验，不将旧嵌套值当作已生效配置。
日志仅报告阶段和文件位置；检查、构建详情保存在 `artifacts/custom-check.log`、
`artifacts/custom-build.log`。安装恢复可使用输出中的 `backup` 文件。

## 本地包运行中更新

### 日常自更新的构建与复用

先完成受影响链路的验证并领取共享构建批次，再使用独立入口：

```powershell
pnpm maint:self-update --mode working-tree `
  --batch-file 'artifacts/update-batch.json' `
  --output 'artifacts/live-update-local-unique' `
  --release-id 'local-unique'
```

该入口不安装或激活应用。它使用实际文件内容、工具版本和构建配置生成指纹，分别保存前端与原生产物；缓存命中仍校验文件哈希与候选协议探针，然后用本次冻结批次生成全新包。纯 UI 改动只需重新执行前端类型检查和 Vite；原生输入变化才编译 Rust。新增、删除、未提交文件和构建期间的输入变化都参与检查，不能仅凭 Git HEAD 相同跳过构建。缓存不是测试结果，改动仍按影响验证。

默认 Cargo `self-update` profile 继承 `release`，保留 unwind，使用 `opt-level=1`、增量编译和 64 个 codegen units，并关闭 LTO；产物位于独立 target profile，`maint:build` 和正式 `release` 不变。首次构建或修改 profile、工具链后需要建立相应缓存，不能把这次耗时当作日常增量耗时。`--profile release` 可作对照，`--force` 强制重新调用构建阶段；报告区分阶段耗时、缓存复用与实际编译，不以缓存读取时间冒充编译提升。

构建入口在拒绝 symlink/junction 后解析源码根目录和快照的实际路径，统一 Windows 大小写及短路径别名；所有自更新模式都显式使用该源码根目录下的 `src-tauri/target`，不受外部 target-dir 配置改变输出位置。`--capture-snapshot` 复用固定的 `source-snapshot` 目录并保留内容未变化文件的时间戳；显式 `--snapshot-dir` 仍使用指定快照。不要为日常增量构建执行 `cargo clean`。首次采用统一路径可能需要一次缓存预热。

构建默认限制为两个并行 Cargo 作业，已有 `CARGO_BUILD_JOBS` 可显式设置为 1–64；rustc 的代码生成也会通过 Cargo jobserver 受并发额度约束，codegen units 数量不代表实际并行核心数。缓存信任包管理器 store，校验锁文件、安装映射和实际工具版本，不声称逐字节验证整个依赖安装。新增 Rust 外部 include 或路径依赖时须更新输入清单；include 审计回归会拒绝未分类的嵌入依赖。产物和资源枚举不按目录名忽略文件，`public/dist`、`public/target` 等仍是有效输入。

自更新 EXE 嵌入固定的启动占位资源，并声明编译时的原生指纹；实际页面位于同包 `frontend/`，`frontend-manifest.json` 绑定该指纹。两者都纳入现有 v1 发布清单的完整文件校验。原生程序仅从当前 profile 的 `runtime-updates/releases/<manifestSha256>` 读取，校验后形成内存快照，桌面窗口、覆盖层与 Web 共用同一 Tauri 资源解析器；不放宽 CSP、不加载远程页面、不把开发服务器作为失败回退。缺失、损坏或不兼容时拒绝启动，沿现有事务恢复上一整包。首次进入此模式仍需编译一次支持它的 EXE，之后原生输入未变的前端版本才可复用该 EXE。

发布版本以校验过的 manifest 为准，因此复用 EXE 后界面仍显示新版本。普通 `maint:build` 安装包继续嵌入完整前端。外置资源包目前显式使用 `working-tree`；旧安装包的验证报告不能证明独立前端产物已受验证，也不能据此声明 `verified-head`。

Windows 构建中的占位 `frontendDist` 使用相对路径，避免绝对盘符被解释为 URL。外置模式在安装快照时同时清空 `devUrl` 和 `frontendDist`，确保所有 App 页面走 Tauri 来源；仅替换 Assets、仅清空 devUrl 都不足以阻止 `file://` 路由。未声明外置能力的普通嵌入包不修改这两个配置。

### 显式本地包与激活

当前源码已接入本地 `protected-custom` 包、独立 worker 和宿主接管；Windows 隔离 profile 的真实 WebView/MCP 兼容切换、候选新任务及健康超时回退已通过。本轮未安装/更新用户当前应用、未提交代码。测试使用 test-harness debug EXE + Vite、同一二进制不同 release ID，不等于公网或完整生产安装验收。支持范围和证据见 [运行中更新说明](runtime-live-update.zh-CN.md)。旧单体版首次进入新基线仍需一次普通退出/重启，不能追溯分离旧任务；`maint:install` 的既有关闭应用要求不变。

打包入口是 `node scripts/live-update-package.mjs`。它不负责构建、安装或执行候选，不覆盖已有输出目录，不调用官方 updater。先按本文 Tauri 构建路径生成实际嵌入前端的 EXE，再传入明确的 EXE、资源目录和全新输出目录。`--resources` 可省略，但本项目完整包通常应传入 `src-tauri/resources`，其内容按最终 EXE 同级布局复制（`agent-catalogs/`、`skills/`），不要额外套一层 `resources/`。

正在工作的认证聊天可通过内置 `ccgui-self-update` skill 发起“更新 CCGUI 自己”：调用原生 MCP `prepare_self_update({packageDir, manifestSha256})` 准备本地包，再用 `get_self_update_status({manifestSha256?})` 查询。prepare 暂存后返回，不等待切换；Leader、电脑操控等桌面进程持有的会话同样只暂存，切换等其结束后自动进行。相同哈希复用当前持久事务，包括失败/回退，不能把 accepted 当成 Committed。原生回执可跨切换重取。协调器在主界面 `finishRecovery` 完成后常驻，不需打开设置页才开始安全等待；设置页不是其生命周期 owner。

该 skill 按既有 managed-skill 机制同步到已安装引擎 home，保护无匹配托管标记的同名目录；MCP instructions 只加发现提示，不创建用户全局规则文件。分发覆盖不改变原生调用权限，也没有新增公网发行自动下载服务。

以下 PowerShell 示例中的版本和 release ID 必须替换成此次实际产物标识；`--task-worker-probe` 只对维护者已确认可信的本机构建执行，不能用来试运行未知包：

```powershell
$exe = (Resolve-Path 'src-tauri/target/release/ccgui-next.exe').Path
$probe = & $exe --task-worker-probe | ConvertFrom-Json
node scripts/live-update-package.mjs `
  --exe $exe `
  --resources 'src-tauri/resources' `
  --output 'artifacts/live-update-local-001' `
  --release-id 'local-001' `
  --version '1.1.1+protected.N' `
  --schema-hash $probe.schemaHash `
  --mode working-tree
```

`working-tree` 是显式本地构建模式，输出 provenance 的 `verified:false`，不得附上验证/构建报告冒充干净提交。`verified-head` 要求同一干净 HEAD 已完成 `pnpm maint:check`、`pnpm maint:build`；以真实构建记录中的版本生成另一全新目录：

```powershell
$build = Get-Content 'artifacts/custom-build.json' -Raw | ConvertFrom-Json
$probe = & $build.exe --task-worker-probe | ConvertFrom-Json
node scripts/live-update-package.mjs `
  --exe $build.exe `
  --resources 'src-tauri/resources' `
  --output 'artifacts/live-update-verified-001' `
  --release-id 'verified-001' `
  --version $build.version `
  --schema-hash $probe.schemaHash `
  --mode verified-head `
  --source-root '.' `
  --verification-report 'artifacts/custom-verification.json' `
  --build-report 'artifacts/custom-build.json'
```

脚本检查源码是否干净、两份报告是否属于同一 HEAD，以及版本、EXE 路径和 SHA-256 是否一致；打包结束前再次核对 provenance。失败 staging 留在输出父目录供检查，不递归清理。资源路径拒绝链接、路径逃逸、Windows 大小写/保留名冲突；默认文件预算为 4096 个、2 GiB，清单最多 4 MiB。

成功输出包含包目录、`manifestSha256`、mode、verified 和完整性说明。保存并通过独立可信渠道核对清单哈希，再在本地主窗口更新入口提供包目录及该哈希。两种模式都**没有发布者签名**：SHA-256 证明与预期字节一致，不证明谁发布了文件；`verified-head` 也只是本地源码/检查/构建记录的对应关系。

Windows 内置启动保护要求每个版本目录中的 EXE 有自己的出站防直连规则。使用刚构建、
核验过的包哈希，在提交 `prepare_self_update` **之前**准备对应规则；不要把固定安装目录
的规则当作候选已受保护的证据。`agent-assets/scripts/ccgui-firewall.ps1` 的 `Plan` 可只读
查看目标，`Install` 须在 Windows 管理员授权的进程执行。只增设该确切版本的规则，
保留固定安装版和仍在运行的旧版本规则，不清理旧 worker 的版本目录：

```powershell
$candidateExe = Join-Path $env:USERPROFILE ".ccgui-next/runtime-updates/releases/$manifestSha256/ccgui-next.exe"
& "$env:USERPROFILE/agent-assets/scripts/ccgui-firewall.ps1" -Mode Plan -GuiExe $candidateExe
# 完成可信候选核验后，在管理员 PowerShell 中运行同一命令的 -Mode Install。
```

规则可以在原生暂存前为该确切路径建立。应用暂存时校验实际 EXE 的规则和候选探针的
`launchProtection: 1`，进入冻结前再次检查；暂存检查失败不会创建新的 Preparing 事务，
冻结前检查失败也不会结束旧宿主。
首次从尚未包含内置保护的版本升级时，由准备步骤确认候选规则，不能依赖旧二进制执行
新增检查。没有管理员授权时保留已验证的包并报告具体阻塞，不通过停宿主或放宽规则完成更新。

导入通过后仍须通过 worker/checkpoint/schema 兼容检查和运行资源 readiness。已独立的普通本机 Claude/Codex 任务可以继续；旧式运行、Leader/CU、活跃 PTY、插件 agent/mission、未保存内容或无恢复协议的插件视图等会延后切换。supervisor 等旧宿主正常交出所有权，候选恢复并确认健康后才提交版本；失败使用同一检查点回退，不重发原任务。保留运行中的旧 EXE/版本目录，不用覆盖安装或删除旧目录代替此事务。

实际 worker 连续性用例已在 Windows 直接运行编译后的测试 EXE 通过；Cargo 运行器 Job 禁止 breakaway，需先 `cargo test --features test-harness --test worker_continuity --no-run`，再按构建输出直接执行同一测试 EXE。测试保留生产独立进程 flags、全部断言和隔离假 CLI；它与后来单独通过的 GUI/MCP 闭环是两份不同证据。

Windows 每代普通 GUI（含 committed 重定向 launcher，服务模式除外）在启动时建立 `GuiServiceScope`：匿名嵌套 Job、非继承句柄、仅 `BREAKAWAY_OK=0x800`，不加 `KILL_ON_JOB_CLOSE`，guard 持有到 event loop 返回。worker/supervisor 仍 BREAKAWAY 脱离 GUI 自有内层并保留外层约束；候选由独立 supervisor 仅带 NO_WINDOW 启动，再建立自己的 scope。此修复解决外层 Job `0x2000` 下连续切换/新 worker 的错误 5，不承诺外部 launcher 终止整个 outer Job 后服务仍存活。

最终证据 [run-jDWER8/report.json](../.artifacts/live-update-smoke/run-jDWER8/report.json) 记录 2026-10-13 11:12:48–11:17:02 UTC 三场景均通过：任务 MCP 确认 Committed、新 worker 使用已提交 EXE、第二次任务 MCP 发起真实 120 秒健康超时回退并确认 RolledBack。原 worker/CLI PID 保持且 CLI 仅启动一次；1313 条中文/emoji 的桌面与同一 loopback WS 全文哈希一致，游标 1317、4 次 hello，端口/token 保持，草稿哈希和 DOM 显示保留，清理后无 fixture 所属进程。remote/MCP helper 各 5 测试通过；仅重试只读读取，原 deadline 和严格正文断言保持。

测试通道不进入 production、不调用付费模型。公网 relay 仅源码修复和 4 测试通过，未部署；原安装版 PID 76792 保留运行，临时 Vite 已停止。无 test-harness 的 Tauri `1.1.1+protected.31` 正式构建、嵌入前端、NSIS 安装包和无 GUI 兼容性探针已通过。`artifacts/self-update-baseline-20261013-final` 为本轮 working-tree 包，EXE/安装包/清单摘要在 `artifacts/self-update-package.json`；未安装用户应用。其余平台、公网链路、任意版本/schema 组合及生产首次基线仍需各自验收，不能从本机闭环推断生产延迟。

## 额度与代理

现有 `~/.claude/statusline-command.sh` 读取官方 `rate_limits` 的百分比和
Unix 重置时间，样式与配置保留。GUI 沿用这些数据语义和 CLI 登录通道，
不自行保存账号令牌或直接实现 OAuth HTTP 客户端。

额度只接受正常对话流里 CLI 已经从响应头带回的窗口。Claude 详情不提供
「更新信息」；获焦和每分钟检查都只重读这份缓存，不再另起 `claude` 进程，
也不发送 `initialize` / `get_usage`，也不调用需要 `user:profile` 的用量接口。
没有新的对话事件时不补造额度。流里的 `rate_limit_event.unifiedWindows` 仍优先；
没有这份字段时，改读和本机 `statusline-command.sh`、ccstatusline 相同的
`rate_limits.five_hour` / `seven_day`（`used_percentage` 与 Unix `resets_at`）。
字段缺失或格式变化显示不可用，不猜测为 0%。主对话继续继承应用已设置的
`127.0.0.1:7897` 代理，额度读取本身不改网络出口。

原生 Claude 渠道上的每段对话都收下上述事件并写入同一份缓存。浏览器登录的标记仍是认证文件摘要。`CLAUDE_CODE_OAUTH_TOKEN` 存在时，标记改为令牌的 SHA-256，缓存和内存都不保存令牌原文。自定义 API 渠道、WSL、远程工作区，以及会改路由的 API key、网关或云厂商变量，仍不记入这份订阅额度。

读取合并并发、限制频率；Claude 详情保留上次的两个窗口，直到下一次对话额度替换它们。

挂载、获焦和每分钟检查都调用 `claude_quota_read`，
并且都只校验身份、读取缓存，不启动 CLI 或 API 请求。后台接收到正常对话的额度后发出
`claude-quota://changed` 通知，不包含额度值、账号标识或凭据；每个界面重新通过
当前渠道与项目的校验读取缓存。Claude 详情不显示「旧数据」。
上次比例保留到下一次对话额度替换它，并显示更新时间；超过一小时或窗口重置不把比例清空。
缺失窗口显示「—」，真实 0% 保留。账号/渠道/项目变化仍立即隐藏原快照。

正常对话的额度事件不含账号字段。不再用 `initialize` 补邮箱和订阅计划；
已有缓存里的标签可以继续显示到身份变化为止，没有标签时详情不留空行。新的身份不会再主动去取。
未能确认的身份不显示，身份缺失不影响已经从对话里收到的额度。

原生缓存保存到 `~/.ccgui-next/claude-quota-cache.json`，只保存展示所需的邮箱、计划、
额度窗口、原始采集时间和认证文件元数据的摘要，不保存凭据或完整 CLI 回复。启动后
首次缓存读取校验当前渠道、工作区和认证摘要，再恢复记录；账号配置变化、损坏或
不支持的缓存被忽略。恢复不会更新采集时间。Claude 详情不把窗口标成旧数据；
超过一小时或重置时间仍保留上次比例，已有账号和计划可保留。写入失败不清空当前内存中的有效信息。

常驻重置提示沿用同一快照的 `resetsAt`，不增加 CLI/API 请求。只有有效、未过期的
窗口才显示时间，缺失窗口不补默认日期。使用系统本地时区和当前界面语言；分钟级
标签不取代弹窗的完整日期、秒数和倒计时。正常对话、手动更新、到期计时器与身份
失效同时更新百分比和时间。布局回归见 `tests/browser/quota-status.html`，覆盖中英文
768/480/320 px 的真实状态栏组件，使用模拟数据而非原生应用或真实接口。

## 构建环境

建议使用已测试的 Node.js 24 LTS（最低 22.13），通过 `npm install --global pnpm@11.19.0` 安装仓库固定版本。Windows 需要 Git、Rust stable 1.95+/MSVC（已测试 1.99）、C++ 构建工具、Windows SDK 与 WebView2，详见 [Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/)。Windows 不需要 Perl；非 Windows 平台仍保留 vendored OpenSSL 构建及对应工具依赖，macOS/Linux 安装包未由本次 Windows 流程验证。

检查与构建工具继承用户进程环境、`PATH` 和 Git 代理设置，不注入固定代理端点、不读取 Claude 配置，也不要求安装可选 AI CLI。普通用户不需要维护者的私有备份远程或保护启动器。`maint:check` 和 `maint:build` 的同一干净提交验证要求继续生效，检查失败应修复后重跑。

构建或开发启动登记的 `default-source-root.txt` 是用户应用数据目录中、仓库外的本机源码路径提示，不得提交或分发。同一系统账号首次启动可据此添加自开发目录；在其他机器安装二进制后须选择当地的源码目录。本地快照的既有排除规则继续生效，不将本机路径提示、凭据或用户配置加入源码快照。
正式版资源只从随包目录加载，不回退到构建者的源码路径；启动时同步自更新 skill 使用当前用户的本机登记。`maint:build` 在打包前复查资源隐私，并拒绝为包含本机源码、用户目录或 Cargo 缓存路径的可执行文件生成成功记录。本地 `artifacts` 下的报告和日志用于诊断，不作为公开分发内容。
正式构建通过本地编译包装器使用 Rust 1.95 的 `--remap-path-scope=object` 脱敏源码、用户目录与 Cargo 缓存路径，保留 Cargo 的依赖元数据和现有编译参数。中间缓存隔离在 `src-tauri/target/release-private-build/<指纹>`，避免复用旧的未脱敏依赖；最终安装包位置不变，不需要日常清理缓存。若自定义编译包装器只写在 Cargo 配置的 `build.rustc-wrapper` 中，请通过 `RUSTC_WRAPPER` 或 `CARGO_BUILD_RUSTC_WRAPPER` 环境变量显式提供，以便与发布包装器串联；`RUSTC_WORKSPACE_WRAPPER` 保持原值。
维护检查与正式构建默认使用两个 Cargo 并行作业，降低冷构建时的资源峰值；显式 `CARGO_BUILD_JOBS` 设置继续生效。
Windows 发布构建还通过 MSVC 的 `/d1trimfile` 裁剪 C/C++ 依赖中的 `__FILE__` 路径；保留已有 `CL`、`_CL_`、`CFLAGS`、`CXXFLAGS`，以编译参数摘要让 Cargo 正确重建相关原生依赖。空格与中文路径有真实编译回归。由于 MSVC 会截断带 `=` 的裁剪参数，正式打包会提前拒绝含该字符的源码、用户目录或 Cargo 缓存路径，避免留下部分用户名；请使用不含 `=` 的构建目录。最终可执行文件仍须通过路径扫描。
保留 `trustPolicy: no-downgrade` 和七天版本成熟期，只有 esbuild 的安装脚本
被允许。旧 lockfile 保存在忽略目录 `artifacts`；新锁文件随维护提交保存。
维护回归的 Vitest 最多使用两个并行 worker，减少多个工作树同时构建时的资源争用，
避免设置页延迟加载模块超过现有等待期限；测试集合、等待期限与断言保持一致。
生成的插件 SDK 参考固定以 LF 检出，与生成器的逐字节校验一致。

发送和中断集成回归使用 `cargo test --features test-harness --test send_path`。
该非默认 feature 只用于 debug 测试，发行构建会拒绝启用；测试在独立临时目录内
注册假 CLI，隔离用户配置、认证环境和程序搜索，禁止回落到真实安装的引擎。
IPC、事件输出、取消、设置持久化与模型/tier 断言仍走实际宿主链路，不调用真实模型。

开发构建可显式传入 `--dev-profile <绝对目录路径>`（也支持 `--dev-profile=<绝对路径>`）。
发行构建拒绝该参数；未传参数时仍使用原有 `~/.ccgui-next`。启动先解析 profile，再获取
实例锁、创建目录、读取设置。相对、无效、无法 canonicalize 的路径，以及指向生产目录
或其子目录的 canonical 别名均失败退出，不回落。新目录以已有祖先解析后创建；canonical
root 相同则共用实例锁，不同 root 互不影响。开发 profile 不导入旧配置或数据库；所有
应用存储（含 Claude quota cache）和 stdio 子进程沿用所选 root。开发 profile 将引擎
HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、XDG/app-data 与历史路径指向 root 内的独立目录，
子进程清理继承环境并阻止 login-shell 回填；不导入生产凭据，quota 不读取生产认证。
原生 WebView 使用独立数据目录；同域浏览器的 `/.ccgui-dev/dev-<canonical-root哈希>/`
路由按 profile 分区 localStorage，开发读取无生产键回落，clear/key/length 仅作用于本分区。
开发 storage 事件先过滤其他分区与来源不明的全域 clear，再将同分区键和 storageArea
映射到本分区视图；正式默认不迁移、不删除旧数据。该事件映射尚未做浏览器运行时验收。
默认正式路由保留原键与行为。开发 profile 关闭启动时的历史扫描、creator skill 安装、
DSH、服务监听、插件及更新检查等自动动作，仍保留将来显式手动运行引擎的能力。

开发桥接固定绑定 `127.0.0.1:0`，由系统分配动态端口，不探测或静默启用 LAN；正式
默认仍绑定 `0.0.0.0:0`。开发 relay 默认拒绝连接；需显式声明 `ccgui-profile-v2` 并通过
无凭据能力检查后，才可创建桥接监听和 agent 连接。配套 Worker 必须声明并强制区分
`STABLE_RELAY_ORIGIN` 与 `DEVELOPMENT_RELAY_ORIGIN`，目标必须匹配开发 origin；开发
路由在其他 origin、正式路由在开发 origin 均在读取凭据和选房间之前拒绝。路径前缀
和 storage wrapper 不证明双向隔离，浏览器自称独立 context 也不作为协议证明；本实现
要求独立 origin，桌面独立 WebView 目录保留。Worker 仍需独立开发凭据和 profile 房间。
origin 通过 URL 规范化后的 scheme、host 与有效 port 比较；路径差异不算隔离。声明与
无凭据能力响应不是身份认证证明，真实站点与浏览器上下文仍须另行受控验收。
开发 agent 每次重连也先复核 v2 能力和 origin，再进行携带开发凭据的拨号；正式重连
不新增此协商依赖。
v1、旧或未知 Worker 不回落到正式 key/房间，正式旧路由默认行为保持原样。本轮不部署 Worker，
不读取或复制当前稳定版密钥、不修改稳定远控入口。

离线验收使用双份合成 HOME/profile、sentinel 和 `fixture/bin` fake allowlist，并覆盖
非 cfg(test) 的 ordinary-profile 共享逻辑、自动动作策略及纯 Rust relay mock；不启动
真实引擎、GUI、网络服务、监听或插件。localStorage 分区目前仅静态核对，浏览器行为、
完整原生运行时隔离、手动真实引擎及稳定/开发在线 relay 共存、断线重连、退出/更新
均待另行授权验收；mock 通过不代表在线链路通过。Worker Node mock 因 spawn EPERM
在本环境未执行，不更换 runner 绕过；Buddy 的外部 3/3 仅为旧 v1 历史，v2 Worker 未测。

profile 定向回归使用 `cargo test --offline --locked --features test-harness --lib`
加具体过滤项：`paths::dev_profile_tests`、`startup::tests`、
`development_profile_quota_cache_persists_only_in_selected_fixture_root`、
`development_profile_roots_have_shared_alias_locks_and_independent_root_locks`。
这些用例不调用应用启动或监听器；Windows canonical 别名用例只通过 fixture 注册的
脚本创建临时 junction，不修改 symlink 权限。

## 生产可执行文件（Windows）

**不要**只用 `cargo build --release`（或 `cargo build -p ccgui-next --release`）出正式包。
那样会跳过 Tauri CLI 的打包步骤：WebView 仍按 `build.devUrl`（`http://localhost:1420`）加载，
本机没有 Vite 时窗口就是 `ERR_CONNECTION_REFUSED`，看起来像“白屏/连不上”。

正式构建必须走其一：

1. `pnpm maint:build`（仓库维护路径：`tauri build --bundles nsis` + 校验报告）
2. 仅要 exe、不要安装包时：`npx tauri build --no-bundle --ci`

二者都会跑 `build.beforeBuildCommand`（`npm run build`），并把 `build.frontendDist`（`../dist`）
嵌进 release 二进制。启动后**不需要**本机 `localhost:1420`。

快速自检：

1. 确认没有进程监听 `1420`（`netstat -ano | findstr :1420` 应为空）。
2. 启动 `src-tauri/target/release/ccgui-next.exe`，窗口标题为 `CC GUI` 且可响应。
3. 当前 `dist/assets/index-*.js` 的文件名应能在 exe 里以明文找到（资源已嵌入）。
4. 注意：exe 里仍可能出现字符串 `localhost:1420`（完整 `tauri.conf.json` 被嵌入），**不能**单靠字符串有无判断；以“无 Vite 能否打开”为准。

原生构建使用当前机器配置的工具链与 `PATH`；需要 Perl 时可通过 `PERL` 显式指定，不再借用其他项目的构建产物目录。
