# 运行中更新：任务连续与连接恢复

## 当前状态

本地更新、独立任务执行器、事件补发、界面检查点和宿主接管已接入当前源码。**Windows 隔离 profile 的真实 WebView/MCP 闭环已通过：任务主动发起更新、健康提交、新版本启动新任务，以及健康超时回退。** 该隔离验收使用 test-harness debug EXE 与 Vite 页面，同一二进制以不同 release ID 模拟兼容切换，不等于公网 relay 或任意版本升级验收。2026-10-15 又完成一次正式 profile 的生产自更新，范围与限制见文末记录；代码尚未提交。

用户允许短暂自动重连；验收目标仍是原任务继续、消息不丢不重、控制回到原任务，不能以窗口重新出现或 WebSocket 连通代替这些结果。本文中的“已实现”“测试通过”和“待验收”分别表示源码状态、对应测试证据和剩余工作，不互相替代。

首次从旧单体基线进入此实现，必须安排一次普通退出和重启。旧宿主已持有的 CLI、管道、解析器和 Windows Job 无法追溯转移到新进程；新增代码不能让切换前的旧任务自动取得独立生命周期。后续运行中更新才使用这里的接管路径。

## 支持范围与所有权

自更新的用户目标是在正在工作的 CCGUI 聊天中说“更新 CCGUI 自己”，由原生能力准备更新并交给常驻协调器，在任务保活的前提下自动选择安全切换时机，无需先打开设置页。当前入口由原生 MCP 能力、内置 `ccgui-self-update` skill 和 MCP instructions 中的一条发现提示组成；没有创建或改写用户全局规则文件。

任意认证的聊天 origin 可调用 `prepare_self_update({packageDir, manifestSha256})`，传入已准备好的本地包目录和独立取得的清单哈希。调用完成暂存后即返回，不等待 begin/切换完成，避免正在等待工具回复的任务与冻结流程互相阻塞。随后用 `get_self_update_status({manifestSha256?})` 查询持久事务；`originWorkerOwned` 表明发起任务是否由独立执行器持有，为假时（Leader、电脑操控等）`activationWaitsForOrigin` 为真：只暂存，激活等待这些仍由桌面进程持有的运行（含发起回合本身及其 Leader 子任务）全部结束，`prepare_relay_update` 在它们存活时拒绝冻结，不会强行结束或迁移它们。同一哈希复用当前事务，包括失败和回退状态，不通过重复调用悄悄创建新事务。原生回执跨宿主切换可重新取得，**accepted 不等于 Committed**，只有实际健康提交才能报告更新成功。

内置 skill 沿用 `.ccgui-managed.json` 管理机制，随包同步到已安装引擎的 home；无对应托管身份的同名用户目录保持不动。分发到某个引擎目录不等于该引擎获得原生更新权限。全局协调器由 `main` 在 `finishRecovery` 完成后启动常驻 watch，设置页只展示和操作同一状态，不拥有 watch 生命周期。本次未新增公网发行或自动下载服务。

本机普通 Claude / Codex 聊天通过 `runtime_worker_start` 交给每个原始 run 独立的 task worker。worker 持有 CLI 及子进程、stdin/stdout、reader、解析状态、原生任务状态、问题/审批控制和耐久日志。主窗口持有路由代理，而不拥有任务管道。宿主连接断开不等于取消任务；旧 run 继续使用原执行器，新任务使用新版本。

宿主为普通聊天准备作用域受限的私有 host-chat 上下文，执行器保留原 run 的能力。继续输入、打断、任务停止、回答和计划决策回到原执行器；续轮产生的 run 别名也从事件和退休归档恢复。不能只按最初的 run ID 寻址，否则续轮控制可能错误回退成第二次普通发送。

普通 worker 的 host-chat 通信能力不等于 Leader 授权。此类运行的 Leader 操作
在已认证的 relay 入口直接拒绝并给出操作指引，不再落入桌面 Leader 账本并误报
`Caller has no trusted local run`。用户应等本轮结束，在会话菜单启用 Leader 后开始下一轮；
已启用 Leader 的会话继续由桌面持有，沿用原有身份、权限和子任务校验。
直接从 shell 启动的外部 CLI 只会被历史扫描发现，侧栏和 `list_chats` 的空闲状态不证明
它已经结束或失败，需以原启动进程与返回结果为准。

| 情形 | 当前处理 |
|---|---|
| 本机普通 Claude / Codex 任务 | 使用独立 worker；兼容更新可接管 |
| WSL、其他引擎、Leader、电脑操控任务 | 不冒充 worker 支持；走既有路径，尚有不可接管运行时延后切换 |
| 活跃 PTY、插件 agent、mission 或其他仍由旧宿主持有的进程 | 成为接管阻塞条件，不能通过强行结束它们完成更新 |
| 工作树创建、自动命名等短事务尚未完成 | 等待稳定边界，不报告为已经恢复 |
| 未保存编辑器内容、非安全对话框、读取中的文件、插件安装/加载、无检查点的插件视图 | 前端 readiness 拒绝切换；普通已加载插件本身不等于阻塞 |
| worker 协议、检查点 schema 或数据库 schema hash 不兼容 | 拒绝激活；旧任务仍可能写入时不能迁移或强行降级 |
| 日志/回执故障、来源缺失、游标超过日志 head | 明确报错并阻止确认健康，不跳过缺失内容 |

普通退出仍沿用正常停止与清理语义。“为更新退出”只有在检查点、资源所有权及兼容性检查完成后才保留 worker；删除一处 `kill_all()` 不能形成独立生命周期。

旧 `spellcast-canvas-bridge` 已退役，兼容恢复为它注册只保存数据的检查点参与者，不再等待插件加载、恢复回发或重放排队请求。原检查点内容继续随后续交接保存，恢复不读取也不改动插件文件和 KV，二者被手动删除也不影响恢复；主聊天与 worker 仍按原链路恢复。此例外只匹配该插件的精确检查点 ID 和身份，其他缺失参与者仍阻止健康确认，不能以忽略全部缺失插件绕过恢复检查。

辅助会话的 `auxiliary_kind` 是扫描派生元数据，使用 v1 已有 `plugin_kv` 的内部命名空间 `$ccgui-session-auxiliary` 保存 JSON 字符串，不再向 `sessions` 新增列。已有开发数据库中的旧列只做一次数据导入，保留原列且不覆盖更新的 KV 值；扫描缓存版本升级后重新识别已有 Cursor 会话。此兼容修复不放宽 schema 门闩。

任务缓存成本审批引入 V2 持久化契约：描述符包含 `costApproval`、嵌套缓存记录以及分支、请求的审批状态，真实计算 hash 为 `9a17d672b37a0dec0ec7e5f1c1b8aee3ee1cea74619bfe88c86d4fcd17123a04`。V1 与其历史源字节等价哈希仍互认，均不能与 V2 热更新或混用 worker。V2 能读取缺少审批字段的旧记录；旧版不理解审批守卫，故从 V1 保留全部功能升级必须完整退出并安装 standalone V2，具体见[安装与恢复](custom-maintenance.zh-CN.md#安装与恢复)。`task_worker::tests::schema_` 回归固定当前真实契约和双向拒绝，不允许以删除功能或伪造哈希绕过。

## 事件、回执与恢复

### 每个 worker 的事件流

`EventEnvelope` 为 `stream_id / seq / name / payload`。同一 worker 的序号从 1 连续递增，升级宿主不会重置该来源的游标。前端先订阅 `runtime://worker-event`，再列举已知来源并补发；实时帧与历史帧按连续序号合并，消费成功后才推进游标。已消费重复帧忽略，待消费相同序号的冲突内容、缺失前缀和容量超限明确报错。

worker 将完整 envelope 追加到 `events.jsonl`，写入成功后才视为耐久。磁盘故障保留有界待写队列，队列满时通过 reader/管道形成背压，不静默丢字。`runtime_events.rs` 的有界内存历史不是这份耐久日志的替代品。

原始回环协议可对大事件分片传输；client 核对字节数、偏移和 SHA-256 后才交付完整事件。中文、emoji、Markdown 和工具事件不通过展示动画重写。这里没有性能测量结果，不宣称吞吐或显示延迟提升。

`done` 不等于物理进程退休。宿主等待进程注册表、reader、辅助工作及耐久事件完成，再确认最终游标并执行 Retire。退出后的 `manifest.retired.json`、事件和回执继续可读，不要求旧 PID 或 EXE 仍存在。归档逐行验证并只保存偏移索引；截断尾部、错序、跨 stream 内容、路径重定向及索引后文件变化均拒绝读取。

### 有副作用的命令

Start 使用稳定 run/request 身份；其他控制请求使用稳定 request ID。执行器先记录 `accepted` 及命令序列化的 SHA-256 指纹，再执行并记录 `completed` 的真实 Outcome。相同 ID/相同参数返回既有结果；不同参数复用 ID 返回 `request_conflict`。退休归档的 `receipt_for` 同样校验指纹，不因 worker 已退出放宽幂等性。

只有 accepted、没有耐久 completed 的请求返回 `outcomeUnknown`，不能视为“没有执行”。WebSocket 重连只保留可安全恢复的稳定 worker 包装请求及补发读取，在 hello 握手后使用原请求内容重发；普通旧命令不盲目重发。原生端优先查询/重试同一身份；最终仍不确定时，UI 保留乐观消息与原 run/Stop 路由，暂停后续自动发送。Claude follow-up 和 Codex steer 不会因丢失确认而回滚后生成第二个请求。

旧已安装宿主可能暂时没有 worker 命令，例如前端热更新先于原生更新。只有明确的命令不存在才缓存能力不可用并回退既有路径；一般错误和结果不确定不是回退依据。首次远程客户端也不能把全部历史 worker 从 0 重放到已有聊天历史上：聊天快照和来源游标必须共同恢复，未知来源需要明确附加或权威快照。

### 检查点与服务

前端冻结新提交，等待已执行的短事务，收敛流式缓冲和事件补发边界，再捕获聊天状态与同一边界的 worker 游标。检查点覆盖聊天/队列、运行路由、待处理状态、composer 草稿和附件、布局及已支持的应用视图状态；未实现恢复的任意插件表单不会被假装序列化。

私有原生检查点另存 host-chat 的轮次能力、请求账本和接管状态，以及 Web 服务的原端口与 token。只有 UI 部分跨前端命令边界；私有能力不交给前端。新宿主恢复同 profile 服务与 worker 来源，先补发再恢复写操作。原来已连接 relay 的情况下，健康确认还等待 relay 恢复。远程客户端重连后继续原来源游标，权限撤销仍有效；存在旧式不可接管运行时，不承诺全局聊天快照切面。

## 更新事务与失败恢复

### 构建前共享通道与持久更新请求

`coordinate_self_update` 为同一 profile 下的所有认证聊天提供 `working / ready / withdraw / request_update / cancel_request / begin / abort`。任务开始修改源码时可登记 `working`；通过验证后默认调用 `ready` 以来源目录、版本标识和摘要登记就绪状态（不自动构建）。当用户提出“更新”时，调用 `request_update` 保存持久更新请求，并将本批范围锁定为当前已 `ready` 与 `working`（含可选 `waitForChangeIds`）的条目；此后新开始的任务归入下一批，避免无限等待。

当本批 `waitingFor` 清空且构建/激活通道空闲时，协调器自动将本批条目冻结为唯一 `Building` 批次（`autoBuild: true`），并由宿主后台构建执行器调用 `scripts/self-update-build.mjs --capture-snapshot` 先固定隔离源码快照并在快照上编译打包，防止后续下一批任务修改工作区打断当前构建。同时保留 `begin` 供显式手动领取构建槽位。`--batch-file` 将完整冻结清单写入本地包的 `build-provenance.json`，由 manifest 校验；原生准备入口拒绝遗漏条目、替换版本或越过他人领取的批次。这是可信本机构建的内容声明，不是编译器证明或发布者签名。

通道在构建、暂存和切换期间可通过 `get_self_update_status.channel` 查询，宿主切换不清空它。原生事务是准备、提交和回退结果的唯一依据。不会按时间自动抢占；构建停止或失败后调用 `abort` 释放未进入激活的批次时，未完成批次的条目自动归还至 `ready` 队列（且不覆盖期间同会话新登记的版本）。已开始的原生激活不能用构建取消撤销；稍后到达的就绪项保留在下一批，上一批完成后若有待处理更新请求则自动接续。

### 普通聊天的工具说明

MCP 启动后使用认证 token 查询宿主账本中的实际模式。普通聊天隐藏 `leader_*`，只收到简短的会话通信和自更新说明；显式开启模式的聊天才获得 Leader 工具与角色说明。关闭后的下一轮恢复普通模式。展示过滤不代替原生权限检查，工具参数不能指定角色。内置通信 skill 已去掉缓存计费建议、催促续聊和强制分工模板。

本实现接收显式选择的本地 `protected-custom` 包，不接回官方 updater endpoint，也没有新增公网发行服务。

Windows 内置启动保护同时覆盖固定安装路径和正式 profile 的版本目录。更新准备步骤按
候选清单哈希，为实际 EXE 路径显式安装独立的防直连规则（需要系统管理员授权），不复用
固定安装路径的规则来声称候选已受保护。受保护宿主在暂存后、进入 Preparing 前检查
候选保护和 `launchProtection: 1` 能力，冻结前再检查；缺失时保持旧宿主运行。候选启动、
后续 committed 重定向和新版实现的回退启动均执行同一门闩。首次由旧宿主升级时，准备
步骤必须完成候选规则核验，因为旧二进制不含新增检查。完整操作见维护文档。

1. 包准备在独立目录，核对清单、路径、完整文件集合、大小、SHA-256、渠道和兼容元数据。校验前不执行来自未知来源的候选。
2. 原宿主检查阻塞资源，冻结 admission，保存 UI/游标和私有服务检查点，将事务推进到可激活阶段。
3. 独立 supervisor 由当前 EXE 启动，通过私有 stdin 接收事务信息。它核对旧宿主的 PID、启动时间和 EXE 身份，等待其退出，不通过杀死旧宿主抢占所有权。
4. supervisor 启动候选。候选恢复检查点和服务；前端恢复、worker 来源与控制检查、必要 relay 恢复完成后，才确认健康并提交 active 版本指针。
5. 候选启动失败、提前退出或健康超时，supervisor 只处理自己启动的候选，并按同一事务恢复旧宿主与兼容检查点。它不停止任务 worker，也不根据断线生成新任务。

当前接管健康等待为 120 秒；supervisor 配置只接受 60–180 秒范围，并最多等待旧宿主退出 30 秒。active 指针和事务记录保存在 profile 内；后续普通启动跟随已提交、重新校验的版本。正在使用的执行器版本目录不得被覆盖或提前删除。回退 EXE 不等于回退数据库，schema 不兼容在激活前拒绝。

Windows 普通启动快捷方式的目标与图标应使用固定安装入口 `%LOCALAPPDATA%\Programs\CCGUI\ccgui-next.exe`，由该入口校验并跟随 `state.active`；不要把某次 `releases/<hash>` 当成长期入口。正式 GUI 启动后在后台检查桌面、开始菜单和任务栏已有的 `.lnk`，将仍精确指向本 profile 版本目录的旧链接迁回固定入口，保留参数、描述及自定义工作目录，并通知 Windows 刷新图标。已删除的旧 EXE 也可迁移；缺少固定入口时保持原链接，开发 profile 和服务模式不触碰用户快捷方式。更新成功、回退及多次旧版本清理均不再要求快捷方式跟随版本哈希变化；此迁移不创建用户已删除的链接，也不通过保留所有旧版本来掩盖失效路径。

Windows 每代普通 GUI（包括 committed 重定向 launcher，服务模式除外）在 `lib` 启动时建立自己的 `GuiServiceScope` 嵌套 Job：匿名、句柄不继承，只设置 `BREAKAWAY_OK=0x800`，不设置 `KILL_ON_JOB_CLOSE`，guard 持有到 event loop 返回。worker/supervisor 仍使用 `CREATE_BREAKAWAY_FROM_JOB` 脱离 GUI 自有内层，并保留外层约束；无法脱离时失败关闭。候选由已独立的 supervisor 仅带 `CREATE_NO_WINDOW` 启动，随后建立自己的 GUI scope。此组合修复了外层 Job 标志 `0x2000` 下连续更新及新 worker 的二次 breakaway 错误 5，已纳入本次闭环；不承诺抵抗外部 launcher 主动终止整个 outer Job。进程名、父 PID 或启动命令成功仍不能单独证明生命周期独立。

## 明确的资源上限

上限不是截断策略；超过时应报告错误、延后更新或取得受支持的快照。

| 对象 | 当前上限/策略 |
|---|---|
| 前端来源及原生检查点来源 | 4096 个；游标须是 JavaScript safe integer |
| 前端待处理事件 | 4096 条，160 MiB 字节预算；分页有有限轮次预算 |
| 单个完整 worker 事件 | 回环重组最多 128 MiB；归档行允许对应 envelope 开销 |
| 原生事件页 | 最多 512 条；归档页预算 8 MiB，但允许单独返回一条完整大事件 |
| worker 回执 | 8192 个唯一 request ID；归档最多 24576 条记录，包含合法的重复退休完成记录；单条最多 16 MiB |
| 归档事件索引 | 最多 100 万条，偏移/长度索引显式控制在 32 MiB 内；不把全部历史读入内存 |
| 归档运行别名 | 最多 16384 个，合法 ID 去重；超限拒绝，不截断 |
| 宿主归档索引缓存 | 最多 4 个；淘汰缓存不删除磁盘归档 |
| 私有宿主检查点 | 最多 256 MiB；远程观察快照另有 32 MiB 限制 |
| 本地更新包 | 最多 4096 个清单文件、2 GiB 文件预算、4 MiB 清单 |

profile 使用 canonical 身份；日志、回执、版本目录和检查点限制路径与文件类型，拒绝 symlink/junction/reparse 逃逸。manifest 令牌不进命令行或日志。同账户能够改写私有目录的主体仍在信任边界内，PID 和 token 校验不等于对该主体的隔离保证。

## 本地包维护

日常候选通过 `pnpm maint:self-update` 按前端、原生实际输入分别缓存。原生 `self-update` profile 只影响候选构建，正式发行 profile 保留原设置。新外置前端模式把 `frontend/` 和绑定原生指纹的 `frontend-manifest.json` 放入现有 v1 清单，不改 worker/checkpoint/schema 兼容协议；旧宿主可暂存首个支持该能力的候选。候选从确切版本目录校验完整包，再读取有界内存资源快照并替换 Tauri Assets，桌面和 Web 使用同一版本。未声明外置能力的普通安装包继续使用嵌入资源。

原生输入未变时，后续 UI 包复用同一个 EXE，但仍保存新的整包身份、执行检查点和健康确认；回退恢复上一份 EXE 与资源的组合，不原地覆盖前端文件。资源缺失、损坏、路径不合法或指纹不匹配均拒绝候选。编译缓存、包生成和 native `Committed` 是三个不同结果；性能报告须分别记录首次构建、增量构建和缓存命中，不把单元测试或局部计时写成实际激活速度。

完整命令和两种 provenance 模式见 [定制维护：本地包运行中更新](custom-maintenance.zh-CN.md#本地包运行中更新)。`scripts/live-update-package.mjs` 只复制和校验显式本地输入，不构建、安装或执行候选。

`working-tree` 明确声明本地工作区产物未经干净 HEAD 验证；`verified-head` 要求源码干净，检查记录、构建记录、版本、EXE 路径及哈希都匹配当前提交。两者都只产生 SHA-256 完整性证据，**不是发布者签名**。清单预期哈希须通过独立可信渠道取得；从可疑包自身计算一个哈希再相信它，并未证明发布者身份。

## 验证记录与剩余验收

### 2026-10-16 自更新构建复用与独立前端

`self-update` profile 的第一次原生编译（含首次 OpenSSL 等依赖）约 18 分 11 秒；当时并行任务改变了前端输入，稳定性门闩拒绝产出成功包。后续复验并纳入该任务，没有关闭稳定性检查。最终代码的有效测量为：新增一个临时 public 文本资源时完整构建/打包 98.195 秒，Rust 阶段为 0 且 EXE SHA256 不变；恢复全部输入后校验并生成新包 15.333 秒，两个构建阶段均跳过。实际原生路径修复的构建为 258.630 秒，其中 Rust 158.290 秒。条件为本机 Windows x64、Cargo/rustc 1.99.0、两个 Cargo 作业；这些是本地构建计时，不是激活耗时或公平的跨 profile A/B 比较。详细数据见 [构建测量](../artifacts/self-update-speed-20261016-benchmark.json)。

32 项 Node 构建/打包回归、8 项原生资源回归、既有更新/交接与 skill 分发定向回归通过。真实隐藏 WebView 使用独立 test-harness debug EXE 和最终生产前端，四个场景通过：同 EXE 的 A/B 页面及 manifest 版本同步变化、来源均为 `http://tauri.localhost/`、篡改资源退出并报告大小不匹配、原生指纹不匹配退出。临时诊断已移除，fixture 进程清理完成；证据为 [真实窗口记录](../.artifacts/self-update-frontend/frontend-smoke-SPQWaA/report.json)。本次没有激活用户的应用，也不将这四项启动测试扩张为真实任务交接或生产回退验收。

截至本轮文档更新，已有证据如下；后续源码小改仍须由集成者重跑最终集合。

| 验证 | 已有结果与限制 |
|---|---|
| `pnpm build` / Tauri beforeBuildCommand | 最终前端类型检查与构建通过 |
| 原生定向单元测试 | task worker 13、归档 10、worker host 1、事件流 6、live-update 14、host-chat 27、lease 1 通过；新自更新工具与 skill 记录见下 |
| 前端定向回归 | bridge、transport、更新 UI、checkpoint、composer、observer 等套件已有通过记录；不把重跑或重叠用例累加成总数 |
| 实际进程 `worker_continuity` | 已编译测试 EXE 直接执行通过：1 个主用例；1 个 helper 在外层报告为 ignored，但由主用例显式作为子进程执行 |
| 本机真实 GUI/MCP 兼容切换 | `run-jDWER8` 三个场景通过；限定为 Windows test-harness debug EXE + Vite、同一二进制不同 release ID |
| 生产构建/安装 | 无 test-harness 的 Tauri `1.1.1+protected.31` 正式构建与兼容性探针通过；NSIS 安装包及本地自更新包已生成，未安装 |
| 技能中心完整模块 | 29 通过、3 失败、1 ignored；3 个既有用例在创建测试符号链接时由 Windows 错误 1314 拒绝，尚未进入功能断言；1 个网络用例原本为 ignored。未修改权限或放宽断言 |

新增自更新入口的定向记录：`self_update` 8 个通过（其中包含 creator 的 2 项，不能与 creator 计数重复相加）、`creator_skill` 11 个通过、`host_chat` 27 个通过、activation 6 个通过；前端 runtime（main + live-update）17 个通过，相关 5 套 81 个用例通过。skill 规范校验、本地打包 9 个用例及最终完整前端/Tauri 构建通过。不同层次的记录不互相替代或重复累加。

本机 GUI/MCP 证据为 [run-jDWER8/report.json](../.artifacts/live-update-smoke/run-jDWER8/report.json)，时间为 2026-10-13 11:12:48–11:17:02 UTC。正在输出的假 CLI 内部 Node helper 调用真实 `--host-chat-mcp`，根进程只观察结果：

- `successful-handoff`：任务 MCP 发起 prepare，并再次确认 `Committed`。
- `new-task-after-update`：新 worker PID 15300 来自已提交候选 EXE。
- `candidate-health-rollback`：第二次由 MCP 发起更新，使用原生监督器（健康超时配置为 120 秒），最终为 `RolledBack / CandidateHealthTimeout`，由同一 MCP 客户端确认。

原 worker PID 11616、假 CLI PID 12224 全程不变，CLI 只启动一次。最终 1313 条中文/emoji 输出，桌面与同一 loopback WebSocket 的完整正文 SHA-256 均为 `fae561343f4f699a42d126cd024a4b9d57af76cfc5da33fa1ed58a1893ac5840`，事件游标均为 1317；观察端取得 4 次 hello，端口/token 身份保持。草稿哈希不变且 DOM 输入框中可见。`cleanup.complete=true`，`remainingOwnedPids=[]`；原安装版 PID 76792 保留运行，临时 Vite 已停止。

helper 对 shutdown 期间临时读取失败仅重试只读请求，保持游标及原 180 秒 deadline；严格前缀、冲突检查和最终全文断言没有放宽。remote helper 与 MCP helper 各 5 个测试通过。测试文件脚本通道只在 test-harness 启用，production 不包含该 feature；GUI 探针与假 CLI 不调用付费模型。公网 relay 仅有源码修复及 4 个测试通过，未部署。

实际进程用例使用隔离 profile、合成 HOME、假 Claude 和 loopback 协议，没有模型凭据或真实模型请求。它验证 launcher 已退出而 worker 与假 CLI 的同一 PID 仍存活、重复 Start 不再启动 CLI、1 MiB follow-up 在 accepted 阶段断开后以原 ID 恢复且不重复写入、跨 client 连续重放、显式 Interrupt 后 reader/子进程退出、Retire 后 worker 退出及归档事件/回执一致。host-chat 配置经过真实 worker 校验，但假 CLI 不调用 MCP，因此不是 host-chat 业务端到端验收。

Windows 本机 Cargo 测试运行器所在 Job 禁止 `BREAKAWAY`，直接 `cargo test` 启动 worker 曾得到 CreateProcess 错误 5。采用 `cargo test --features test-harness --test worker_continuity --no-run` 构建，再直接运行构建输出中列出的同一测试 EXE，验证仍保留生产 creation flags 和全部断言；没有删除 breakaway、放松独立生命周期要求或通过权限绕过制造通过结果。执行记录须保留这个环境区别。

剩余验收包括公网 relay 在线链路、其他平台、完整生产安装与首次旧单体基线切换，以及不同真实版本/schema 组合；本机 loopback 和同一二进制兼容切换不能代替这些场景，也不提供生产延迟结论。待回答/审批、队列及阻塞资源仍应按各自已有回归范围报告，不能从本次草稿与流连续性验证扩张为全部交互均已端到端覆盖。

### 2026-10-15 正式 profile 自更新

`working-tree-compatible-recovery-20261015`（`1.1.1+protected.31.launchguard.recovery.20261015`）
已由原生 MCP 提交并确认 `Committed`，活动清单哈希为
`9098ebbc7e5763456c366c400613427f1adc243216b25a07ad511109b1ef0785`。
新 GUI PID 49920 来自该版本目录，原 worker PID 53044 保持运行；恢复后的设置弹窗
可通过真实点击「返回应用」关闭。桌面统一为一个指向受保护版本的「CC GUI」快捷方式，
旧入口已备份。结构化证据见 [验收记录](../artifacts/compatible-recovery-acceptance.json)。

此次包包含内置启动保护及恢复阶段弹窗/inert 修复，独立副本中 8 项原生兼容性回归、
29 项前端恢复回归、完整 Tauri 生产构建和候选探针通过。当前工作区新增 TPS 诊断列
会产生不同数据库指纹，因此仅在打包副本中成对使用此前的 `db.rs` 与
`throughput_stats.rs`；工作区新代码未改动，新增列/排除原因诊断未装入本包。
仍使用原有 v1 指纹断言，没有放宽 schema 校验。包属于 `working-tree`，不声称干净
HEAD 验证或发布者签名；本次也不替代其它平台、公网 relay、数据库结构变更或新安装验收。

后续按用户明确的上线范围取消额外 TPS 诊断：主工作区已移除上述三列、对应迁移及排除原因
汇总，`db.rs` 与 `throughput_stats.rs` 恢复为已安装包中的 TPS 实现。保留本轮、会话、全局
及分引擎 TPS 统计，不再将诊断功能列为待发布事项；未删除用户历史统计数据。

### 2026-10-16 构建通道与提示词隔离验证

最终定向原生测试 143 项通过：live-update 27、host-chat 26、Leader 72、handoff 7、内置 skill 11；另一个标记 ignored 的通道 helper 由跨进程竞争用例显式启动两次。打包器 11 项通过。记录与源码摘要位于 `artifacts/update-channel/verification.json`，不将编译通过代替功能测试。

审查发现并修复两处交错：首次批次绑定须先验证独立 manifest 哈希，再验证本次读取的 provenance 字节确实被该 manifest 覆盖，错误哈希不留下绑定；替换唯一原生事务记录之前，在同一跨进程锁内持久化旧批次从事务推导的终态。回归分别覆盖「正确清单 P + 另一包 Q 的哈希，随后重试 Q」以及完成/失败/回退批次在传统入口启动下一次更新后不得重新变成进行中。

新 MCP 在旧宿主回退场景中，仅对明确的“不支持能力查询”回退为普通工具范围；认证失败或传输不确定仍报错，不推断 Leader 身份。发行 EXE 的独立协议检查入口为 `node scripts/test-host-chat-tool-modes.mjs <可信新构建 EXE 绝对路径>`，以隔离回环服务和测试 token 检查普通模式、Leader、旧宿主及认证拒绝，不读取真实聊天凭据。

这四项发行 EXE 检查均已通过。`1.1.1+protected.31.channel.20261016` 已在正式 profile 自更新并确认 `Committed`，活动清单为 `b6f7aeae8a61c611de5881d207e76991928cad44037039ec8cbc5b0a6ac07523`；活动 EXE 与已验证构建哈希一致，两个已安装 skill 的 `.agents` / `.codex` 托管副本与包内源码一致。记录见 `artifacts/update-channel/deployment.json`。本次为避免此前 LLVM 内存不足，使用单作业、主程序 64 个 codegen units、关闭发行 LTO 的本地构建覆盖项，未更改仓库默认 profile。当前运行继续保留原工具目录，新启动回合取得按模式过滤的工具。
