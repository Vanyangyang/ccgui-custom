---
name: ccgui-self-update
description: 在 CCGUI 会话中登记已验证的自身源码改动，或按用户要求更新正在使用的 CCGUI：完成验证后默认调用 coordinate_self_update(ready) 登记待更新；用户要求更新时领取批次、准备可信新版本包、提交宿主自更新并核对 Committed 或回退结果。项目依赖升级不属于此流程。
---

# CCGUI 自更新

自更新由 CCGUI 的原生协调器执行。日常修改任务完成验证后默认登记到共享待更新队列；用户要求“更新”时，保存一次持久更新请求并锁定本批任务范围，待本批任务全部就绪后由协调器固定源码快照、统一打包并自动等待安全时机切换宿主，失败时恢复上一版。短暂自动重连属于正常过程。

## 使用宿主入口

使用当前会话已经连接的 **ccgui MCP** 工具：

- `get_self_update_status`：读取当前支持范围、待更新通道（`working` / `ready` / `updateRequest` / `batch`）、更新事务、阻塞原因和活动版本；可传 `manifestSha256` 查询某个候选。
- `coordinate_self_update`：声明正在修改源码（`working`）、登记已验证改动（`ready`）、撤销未领取项（`withdraw`）、保存持久更新请求（`request_update`）、取消未冻结的更新请求（`cancel_request`）、手动领取唯一构建批次（`begin`）或释放已停止的失败构建（`abort`）；所有供应商共用一个通道。
- `prepare_self_update`：提交 `{ "packageDir": "绝对本地包目录", "manifestSha256": "64 位 SHA-256", "batchId": "已领取批次" }`。

工具的客户端前缀可能不同，通过工具发现取得实际名称。无需读取私有 token、检查点或自行拼接宿主 HTTP 请求。

区分**默认登记**与**请求更新**：
- **正在修改源码（可选声明）**：任务开始修改 CCGUI 源码时，可调用 `coordinate_self_update({ action: "working", changeId: "本聊天内稳定标识", summary: "正在修改的内容", sourceRoot: "源码绝对目录" })`，以便在用户发起更新请求时将该任务纳入本批等待范围。
- **默认登记（无需用户额外提醒）**：只要在已保存的聊天中修改了 CCGUI 源码并通过相应验证，结束前自动调用 `coordinate_self_update({ action: "ready", changeId, summary: "改动摘要与实际验证范围", sourceRoot, revision })` 登记就绪状态；不自动启动构建或提交更新。若当前已有持久 `updateRequest` 正在等待本任务，本任务登记 `ready` 后会由原生协调器自动冻结本批并接手后台快照构建，当前任务无需自行执行构建。
- **请求更新（用户说“更新”时）**：调用 `coordinate_self_update({ action: "request_update", requestId: "本次稳定标识", sourceRoot: "源码绝对目录", waitForChangeIds?: ["可选额外等待的changeId"] })`。
  - 系统自动清理已结束/闲置会话遗留的孤儿 `working` 条目与中断的手动构建批次（未完成条目自动归还 `ready`），持久保存更新请求并将本批范围锁定为当前已 `ready` 与活跃 `working`（含仍活跃的 `waitForChangeIds`）的任务；此后新开启的任务列入下一批，不阻塞本批。
  - 当本批 `waitingFor` 清空时，宿主常驻协调器自动将本批冻结为 `Building`（`autoBuild: true`），在后台固定源码快照（`--capture-snapshot`）、统一打包、校验/申请候选防火墙规则并调用 `prepare_self_update`，随后在安全边界自动保存检查点并切换宿主。
  - **严禁轮询等待（No Schedule / No Polling Loops）**：调用 `request_update` 后，无论 `waitingFor` 是否为空、`batch` 是否正在 `Building`、`originWorkerOwned` 是 `true` 还是 `false`，都只需向用户汇报当前已锁定的批次范围与状态并**立即结束当前回合**。**严禁**调用 `schedule` 定时器、`sleep` 或在回合内循环调用 `get_self_update_status` 等待其他会话就绪、等待后台构建或等待宿主切换（挂起回合轮询不仅浪费上下文，还会阻碍桌面进入空闲切换时机）。

## 手动构建与候选准备（兼容或显式打包场景）

1. 当协调器已通过 `request_update` 启动自动构建（`batch.autoBuild: true`）时，无需在聊天中重复执行 `pnpm maint:self-update`，也不要挂起回合轮询构建进度。
2. 如需显式手动构建，调用 `{action:"begin", requestId:"本次稳定标识", sourceRoot}`。只有 `startBuild:true` 才开始构建；否则观察现有批次，不启动第二份。所有已登记项必须已集成到同一源码目录。新登记项留到下一批。
3. 手动构建优先使用 `pnpm maint:self-update --mode working-tree --capture-snapshot --batch-file <已领取批次文件> --output <全新包目录> --release-id <本次标识>`。`--capture-snapshot` 会在构建开始前固定源码快照并在快照目录上执行类型检查与编译，避免后续任务修改工作区打断当前构建。
4. 构建失败或取消且构建进程已停止后，用 `{action:"abort", batchId, reason}` 释放通道（未进入激活的批次条目会自动归还到 `ready` 队列，且不覆盖期间新登记的同 `changeId` 版本）；若原构建运行已意外终止，协调器也会在下次请求时自动回收并将条目归还 `ready`。
5. Windows 正式安装版与自更新版本目录都执行内置启动保护。原生暂存阶段若检测到候选缺少独立防火墙规则，会自动请求一次管理员授权执行 `ccgui-firewall.ps1 -Mode Install -GuiExe <确切路径>` 并复核；也可预先手动执行。

## 提交、等待与确认

1. 候选进入 `Preparing` 后，主界面的常驻协调器会等待安全边界，自动保存检查点并切换宿主，无需打开设置。
2. 按需单次调用 `get_self_update_status` 观察结果（严禁在单次回合内用 `schedule` 或循环轮询）：对外只需呈现“待更新、等待任务（`updateRequest.waitingFor`）、构建中（`batch.phase == Building`）、等待切换（`blockers` 具体阻塞对象与原因）、已生效（`Committed`）/失败（`Failed` / `RolledBack` / `Aborted`）”。
3. 阻塞原因表示更新在等待。保留正在执行的任务、终端和未保存内容；不要用关闭它们来强行完成更新。确实需要用户处理的阻塞，明确说明具体对象与原因。
4. 当宿主完成切换重连后或用户询问结果时，核对目标事务为 `Committed` 且活动版本匹配此次哈希，即可报告自更新完成并简短说明新版本及验证结果。
5. `Failed` 或 `RolledBack` 表示更新失败或已回退；报告真实原因与当前版本。同一失败包不会自动重新激活，先修正候选再发起新的更新请求。

原生协调器拥有激活、正常回退和任务生命周期。不要用普通进程退出、手工杀宿主、覆盖运行中的 EXE 或直接改写更新状态文件代替这些步骤。
