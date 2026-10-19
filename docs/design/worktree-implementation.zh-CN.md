# Worktree 功能实现文档

> **状态**：待实施 · 设计稿已通过评审（`docs/design/worktree-mockup.html`）
> **版本**：v1 方案 · 2026-09-23
> **关联规范**：`docs/ui-ux-spec.zh-CN.md`（实施后同提交更新）

---

## 1. 背景与目标

### 1.1 痛点

用户作为开源项目 maintainer 需要审查大量 PR。单一工作区下，审查不同分支的 PR 只能串行切分支，互相干扰（未提交改动、构建产物、依赖状态），无法并行。

### 1.2 方案核心

每个 PR（或分支）一个 **git worktree** = 一个独立的磁盘目录 + 独立分支。在本应用中，worktree 注册为**父工作区的子工作区**，自动获得会话、终端（⌘J）、变更面板、文件树上色的全链路能力——因为：

- `git_repository_summaries` 已把 linked worktree（`.git` 文件）识别为仓库根（`src-tauri/src/git.rs:44`）；
- git IPC 接受 worktree 内任意路径（`src/features/files/repositorySelection.ts` 逐级向上找最深仓库根）；
- 会话/终端/变更面板全部按 workspacePath 隔离，天然并行。

### 1.3 设计决策（评审已确认）

| # | 决策 | 结论 |
|---|---|---|
| 1 | worktree 在侧栏的形态 | 父工作区下的**子工作区**（WORKTREES 分组，缩进子行），恢复旧版 `kind` + `parentId` 数据先例 |
| 2 | 创建来源 | 三种：**新分支**（默认 Tab）/ 检出已有分支 / 从 PR 创建，同一对话框 |
| 3 | PR 获取 | 不依赖 GitHub token：fork/同仓 PR 统一走 `git fetch origin +refs/pull/N/head:refs/heads/<branch>`；PR 标题等元信息在 `gh` CLI 可用时增强，缺失降级不阻塞 |
| 4 | 创建方式 | 后台化：对话框即交即走，侧栏进度行（转圈 → 成功/失败），可取消、失败可重试；分支/目录冲突**行内报错**，不做自动重试 |
| 5 | 父工作区移除/归档 | **级联提示**：弹窗列出受影响 worktree，确认后一并处理 |
| 6 | 默认目录 | 仓库同级 `<repo>-worktrees/<branch>` |
| 7 | 偏好记忆 | localStorage 记忆上次的「位置 / 创建后打开新会话」 |
| 8 | 删除策略 | 后台任务直接删（`git worktree remove` + 删目录），默认保留分支；预检未提交/未推送/未合入 |

### 1.4 v1 明确不做

PR 列表拉取与状态轮询、共享目录 symlink、setup hook、sparse checkout、预热 checkout 池、SSH/WSL/远程主机特判、archive hook、agent scratch 分类、CLI 等价物、分支名自动重试（name-2 层叠）。

---

## 2. 数据模型

### 2.1 workspaces 表迁移（`src-tauri/src/db.rs`）

沿用现有**加性迁移**模式（`PRAGMA table_info` 探测 + `ALTER TABLE`，参考 `sort_order`/`group_id`/`meta` 三处先例，db.rs:635-666）：

```sql
ALTER TABLE workspaces ADD COLUMN kind TEXT;        -- NULL = 普通工作区；"worktree" = 子工作区
ALTER TABLE workspaces ADD COLUMN parent_id TEXT;   -- 仅 kind="worktree"：父工作区 workspaces.id
```

- 不加外键约束（父行可被移除，级联由应用层提示处理，见 §6.4）。
- 查询索引不需要（workspaces 行数为几十量级）。

### 2.2 Rust `Workspace` 结构（`src-tauri/src/history/reader.rs:975`）

```rust
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub last_opened_at: Option<i64>,
    pub sort_order: Option<i64>,
    pub group_id: Option<String>,
    /// "worktree" = git worktree 子工作区；None = 普通工作区。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// kind="worktree" 时的父工作区 id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub meta: Option<serde_json::Value>,
}
```

`list_workspaces` 的 SELECT 与行映射同步加两列。

worktree 元信息存 `meta`（后端不解释，与 WSL 插件同一模式）：

```json
{
  "worktree": {
    "branch": "pr-1842-fix-crash",
    "baseRef": "origin/main",
    "prNumber": 1842,
    "prTitle": "fix: 启动时偶发崩溃",
    "prUrl": "https://github.com/owner/repo/pull/1842"
  }
}
```

### 2.3 `add_workspace` 命令扩展

`add_workspace(state, path, meta)` 增加可选参数 `kind: Option<String>`、`parent_id: Option<String>`（Tauri 命令加可选参数对现有调用方兼容）。校验：

- `kind` 只接受 `None` / `"worktree"`；`kind="worktree"` 时 `parent_id` 必填且对应行存在；
- 普通工作区不得携带 `parent_id`；
- `add_workspace_inner` 的 upsert 语句写入两列。

### 2.4 前端类型（`src/lib/ipc.ts:113`）

```ts
export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number | null;
  sortOrder: number | null;
  groupId: string | null;
  /** "worktree" = git worktree 子工作区；undefined = 普通工作区。 */
  kind?: "worktree";
  /** kind="worktree" 时的父工作区 id。 */
  parentId?: string;
  meta?: Record<string, unknown>;
}

export interface WorktreeMeta {
  branch: string;
  baseRef?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
}
```

### 2.5 旧版导入恢复（`src-tauri/src/db.rs:894` 测试区）

旧版 workspaces.json 的 `kind:"worktree" + parentId` 子项**当前被导入逻辑跳过**（测试断言 "the worktree child is skipped"）。实施时：

- 导入逻辑改为接受 worktree 子项：`parentId` 指向的行存在才导入（父缺失则跳过并记日志）；目录在磁盘上不存在时同样跳过（worktree 可能早已被清理）；
- 更新该测试：worktree child 出现在结果中，且 `kind`/`parent_id` 落库。

---

## 3. 后端实现（`src-tauri`）

### 3.1 技术选型：创建/删除走 git CLI 子进程，查询走 git2

| 操作 | 实现 | 理由 |
|---|---|---|
| `git_worktree_create`（fetch + add） | `tokio::process::Command` 调 `git` CLI | 可 kill 实现**取消**；stderr 实时行可作**阶段进度**；错误文本与 git CLI 一致（网络/认证/冲突都是成熟文案） |
| `git_worktree_remove` | `git` CLI | `git worktree remove --force` 一步完成注销+检查；git2 没有等价删除 API |
| `git_worktree_list` | git2 `Repository::worktrees()` | 与现有 git.rs 一致；无需子进程 |
| 删除预检（status/ahead/merged） | git2（复用现有函数） | `git_status` 已提供文件数与 ahead/behind；merged 判定用 git2 graph |
| PR 元信息（可选增强） | `tokio::process` 调 `gh` CLI | 仅做存在性探测 + 标题读取，失败静默降级 |

git2 与子进程并发的锁竞争：创建/删除期间不对同一仓库跑 git2 写操作（前端在进度期间禁用该仓库的变更面板 mutation，见 §5.5）；只读 status 与 CLI fetch 可安全并发。

### 3.2 新增命令一览（`src-tauri/src/git.rs` 或新文件 `git_worktree.rs`，在 `lib.rs` 注册）

```
git_worktree_list(repo_path) -> Vec<WorktreeInfo>
git_worktree_create(app, creation_id, args) -> ()          // 进度经事件上报
git_worktree_create_cancel(creation_id) -> ()
git_worktree_remove(repo_path, worktree_path, delete_branch, branch) -> RemoveResult
git_branch_merged(repo_path, branch, base) -> bool
git_resolve_pr(repo_path, input) -> PrPreview              // 见 §3.5
```

### 3.3 `git_worktree_create`（核心）

**参数**：

```rust
pub struct WorktreeCreateArgs {
    pub repo_path: String,          // 父工作区路径（主检出）
    pub branch: String,             // 新分支名（已校验）
    pub worktree_path: String,      // 目标目录（不存在）
    pub base_ref: Option<String>,   // "origin/main" 等；PR 流程为 None（用 pull/N ref）
    pub pr_number: Option<u64>,     // PR 流程：拉 pull/N/head
    pub existing_branch: bool,      // true = 检出已有分支（不带 -b）
}
```

**流程**（每步 emit 进度事件，事件名 `worktree://create-progress`）：

1. **校验**（同步快速失败）：`repo_path` 是 git 仓库；`worktree_path` 不存在；`branch` 通过 `git check-ref-format --branch <branch>` 校验；分支未存在（`existing_branch=false` 时）；分支未被其他 worktree 占用（`existing_branch=true` 时，用 `git_worktree_list` 检查）。
2. **拉取**（PR 流程）：`git -C <repo> fetch origin +refs/pull/<N>/head:refs/heads/<branch>`。stderr 行转进度事件（"正在 fetch pull/N…"）。失败分类：ref 不存在 → `pr_not_found`；网络/认证 → `fetch_failed`。
3. **拉取**（新分支流程）：`git -C <repo> fetch origin <base_ref>` 失败不阻断——base 可能是本地 ref；解析 base 失败才报 `base_not_found`。
4. **创建**：`git -C <repo> worktree add --no-track -b <branch> <path> <base>`（`existing_branch=true` 时不带 `-b`）。`--no-track` + 随后写 `git config push.autoSetupRemote=true`（仓库级已有则不覆写）——避免 status 误报 behind（借鉴 Orca `worktree-add.ts`）。
5. **失败清理**：步骤 4 失败时若分支是新建的，保留分支（无害）；若目录残留，尝试 `git worktree remove --force <path>` 清理半成品。

**取消**：`creation_id → Child` 存入 `AppState` 的 `Mutex<HashMap>`；cancel 命令 kill 子进程并执行步骤 5 的清理。进程正常退出后从 map 移除。前端取消后把进度行置为「已取消」并允许关闭。

**进度事件载荷**：

```json
{
  "creationId": "uuid",
  "stage": "fetch" | "add" | "register" | "done" | "failed" | "canceled",
  "message": "正在 fetch origin pull/1842/head…",
  "errorKind": "pr_not_found" | "fetch_failed" | "branch_exists" | "dir_exists" | "not_a_repo" | "invalid_branch" | "unknown",
  "error": "原始错误文本（日志用，UI 用 errorKind 走 i18n）"
}
```

事件发送沿用 `event_sink.rs` 的 emit 模式（参考 `SCAN_PROGRESS_EVENT`）。

### 3.4 `git_worktree_remove`

1. `git -C <repo> worktree remove --force <path>`（`--force` 覆盖脏目录；预检已在前端确认）；
2. 若残留目录（git 报 removed 但目录仍在，如权限问题）→ `tokio::fs::remove_dir_all` 兜底，仍失败则返回 `orphan_directory`（UI 提示「已在 git 中注销，目录可手动删除」）；
3. `delete_branch=true` 时：先 `git branch -d <branch>`（保守）；失败且 `delete_branch` 是用户显式勾选 → `git branch -D <branch>`。返回 `RemoveResult { branchDeleted: bool, branchKeptReason?: "unmerged" | "checked_out_elsewhere" }`——**「保留了分支」不能报成「已删除」**（对齐规范「禁用目标不能谎报」）。

`git_worktree_list` 返回 `{ path, branch, head, isMain, locked, lockReason? }`，用于：占用检查、locked 禁删、外部 worktree 识别（v1 不展示外部 worktree，仅用于冲突检测）。

### 3.5 `git_resolve_pr`（PR 预览）

输入：`repo_path` + 用户输入（`1842` / `#1842` / `https://github.com/owner/repo/pull/1842`）。

1. 解析输入 → `number`（纯前端也可做，放后端保持单一口径）；
2. 从 `origin` remote URL 解析 GitHub `owner/repo`（https/ssh 两种形式）；
3. 探测 `gh` CLI（`gh --version`，有缓存）：可用则 `gh pr view <N> --repo <owner/repo> --json number,title,author,additions,deletions,state` → 返回完整预览；
4. `gh` 不可用/未登录/超时（3s）→ 降级返回 `{ number, repo: "owner/repo", degraded: true }`，**不阻塞创建**（pull/N ref 在 GitHub 上对同仓与 fork PR 都有效）；
5. `origin` 不是 GitHub 地址 → 返回 `not_github` 提示，引导用户改用「已有分支」Tab。

分支名推导（前端做，后端校验）：`pr-<N>-<slug>`，slug 取自标题前 4 个单词（kebab-case，仅 ASCII；无标题时仅 `pr-<N>`）。冲突（分支或目录已存在）在预览阶段即提示。

### 3.6 `git_branch_merged`

git2 实现：`repo.merge_base(branch_tip, base_tip)`；`base_tip` 是 `branch_tip` 的祖先（`repo.graph_descendant_of(branch_tip, base_tip)`）即已合入。squash merge 场景判不准（历史未真正合并）——v1 如实按「未合入」警示，文案写「未合入 main（含 squash 合入的误报可能）」，把决定权给用户。

---

## 4. IPC 契约（`src/lib/ipc.ts`）

```ts
export interface WorktreeInfo {
  path: string;
  branch: string | null;     // detached 时为 null
  head: string;
  isMain: boolean;
  locked: boolean;
  lockReason?: string;
}

export interface PrPreview {
  number: number;
  repo: string;              // "owner/repo"
  degraded: boolean;         // true = 无 gh，仅 PR 号可确认
  title?: string;
  author?: string;
  additions?: number;
  deletions?: number;
  suggestedBranch: string;   // pr-1842-fix-crash
  branchConflict: boolean;   // 分支或目录已存在
}

export type WorktreeCreateStage =
  | { stage: "fetch" | "add" | "register"; message: string }
  | { stage: "done"; workspace: Workspace }
  | { stage: "failed"; errorKind: WorktreeErrorKind; error: string }
  | { stage: "canceled" };

export interface WorktreeRemoveResult {
  branchDeleted: boolean;
  branchKeptReason?: "unmerged" | "checked_out_elsewhere" | "orphan_directory";
}
```

封装函数（与现有 git 封装同文件同风格）：`gitWorktreeList`、`gitWorktreeCreate`、`gitWorktreeCreateCancel`、`gitWorktreeRemove`、`gitBranchMerged`、`gitResolvePr`，以及 `onWorktreeCreateProgress(cb)`（`@tauri-apps/api/event` 的 `listen("worktree://create-progress")`）。

---

## 5. 前端实现

### 5.1 新 feature 目录 `src/features/worktree/`

```
src/features/worktree/
├── store.ts                    // pending creations（进度行）+ 偏好记忆
├── WorktreeCreateDialog.tsx    // 三来源创建对话框
├── DeleteWorktreeDialog.tsx    // 删除预检确认
├── WorktreeProgressRow.tsx     // 侧栏进度行（进行中/失败）
├── pr-input.ts                 // PR 输入解析（纯函数，可测）
├── branch-name.ts              // slug/分支名推导（纯函数，可测）
└── api.ts                      // ipc 封装 + 事件订阅
```

### 5.2 `store.ts`（zustand，参考 `src/features/git/store.ts` 模式）

```ts
interface PendingCreation {
  creationId: string;
  parentWorkspaceId: string;
  branch: string;
  stage: "fetch" | "add" | "register" | "failed" | "canceled";
  message: string;
  errorKind?: WorktreeErrorKind;
  /** 重试所需的原参数快照 */
  retryArgs: WorktreeCreateArgs;
}

interface WorktreePrefs {
  location?: string;          // 上次自定义位置
  openSessionAfter: boolean;  // 默认 true
}
```

- `pending: PendingCreation[]`：进度行数据源；`done` 即移除（成功 = 行变为正常 worktree 行）；`failed`/`canceled` 保留到用户关闭；
- 偏好 `localStorage["ccgui-next.worktreePrefs:v1"]`；
- 事件订阅在 ChatPage 挂载一次：进度事件 → 更新 pending；`done` → 调 `addWorkspace` 结果已在后端写库，前端走 `sessions://changed` 式的重读（复用现有 workspaces 加载链路）→ 若 `openSessionAfter` 则 `startNewChat(worktreePath)`（**必须先 `dismissCenterSurfaces`**，对齐 center-surfaces 清场契约）。

### 5.3 `WorktreeCreateDialog.tsx`

- `ModalShell` 容器（`src/components/dialogs.tsx`），标题「新建 Worktree」+ 副标题父仓库名与路径；
- 三 Tab 用 `Chip`（`src/components/base/chips/chip.tsx`，与 Skills/MCP 页同形）：新分支（默认）/ 已有分支 / 从 PR 创建；
- **从 PR 创建**：Input（mono）→ 防抖 400ms 调 `gitResolvePr` → 预览卡（标题/作者/+a −d/分支名；`degraded` 时只显示「PR #N · owner/repo · 将通过 pull/N/head 获取」）；`branchConflict` 行内红字；
- **新分支**：分支名 Input（实时 `check-ref-format` 经后端校验太重——前端正则粗检 + 提交时后端终检）+ base 选择（复用 `ChangesPanelHeader` 的 Dropdown+搜索模式）；
- **已有分支**：同一分支选择器，占用分支（`gitWorktreeList` 已挂载）禁用并注明「已被 worktree 占用」；
- **公共区**：位置 Input（默认 `<parentDir>/<repo>-worktrees/<branch>`，分支名变化联动刷新直到用户手改过该字段）+ 「创建后打开新会话」Switch（默认开，记忆）；
- 提交（⌘↵ / 主按钮）：前端校验 → `gitWorktreeCreate` → **立即关闭对话框**，后续走进度行；提交期间按钮禁用防重入（规范 §3）。

### 5.4 侧栏改造

**类型**（`sidebar-types.ts`）：`AiChatRepo` 增加 `kind?: "worktree"`、`parentId?: string`、`worktreeMeta?: WorktreeMeta`、`dirtyCount?: number`。

**树构建**（`use-chat-sidebar.ts`）：workspaces 扁平列表 → worktree 项按 `parentId` 挂到父行下；父缺失（数据异常）降级为普通行并打日志，不丢条目。

**渲染**（`workspace-sections.tsx`）：
- 父行会话列表之后渲染「WORKTREES · n」分组标签（可折叠，折叠状态持久化，同分组折叠机制）；
- worktree 子行：缩进 + `git-branch` 图标 + 分支名（`name` 即目录名，分支名以 `worktreeMeta.branch` 为准）+ PR 徽标（`prNumber` 存在时，`status-purple` 对）；
- 子行可展开列出该 worktree 的会话线程（现有线程行渲染复用，缩进加深一级）；
- 激活态/未读/streaming 呼吸点沿用现有语义；
- worktree 行**禁用**拖拽排序与拖入分组（父子绑定，拖拽会破坏 parentId 语义）；右键菜单给出说明性禁用项而不是隐藏（对齐「禁用目标不能谎报」）。

**右键菜单**（`workspace-context-menu.tsx`）：
- 普通工作区行：新增「新建 Worktree… ⌘⇧N」（仅当该目录是 git 仓库时可用——用 git store 的 `notRepo` 标记判定，非仓库禁用并注明原因）；
- worktree 行：「在访达中显示」「删除 Worktree… ⌘⇧⌫」（`locked` 时禁用 + `title` 原因）；不提供「新建分组/归档」（归档语义对 worktree 由父级联决定）。

**进度行**（`WorktreeProgressRow.tsx`）：渲染在对应父行的 WORKTREES 分组下首行；进行中 = `animate-refresh-spin` 转圈 + 阶段文案 + ✕取消；失败 = ⚠ + 原因（i18n by errorKind）+ 重试/关闭，容器 `role="alert"`（规范 §5）。

### 5.5 `DeleteWorktreeDialog.tsx`

- 打开即预检（并行）：`gitStatus(path)`（未提交文件数 + 前 2 个文件名 + ahead 数）、`gitBranchMerged`；
- 进行中任务检查：chat store 里 `workspacePath == 该路径` 的活跃流式会话 + terminal store 的运行中终端 → 额外警示行；
- 全干净：不渲染警告行，只显示「没有未提交或未推送的改动」；
- 「同时删除本地分支」Checkbox：默认不勾；勾选后主按钮文案变为「删除 Worktree 和分支」；有未合入提交时该行加警示色；
- 会话保留说明行（历史记录仍可只读查看）；
- 确认 = danger Button（规范 §6）；执行期间按钮禁用；结果含 `branchKeptReason` 时行内/toast 说明分支保留原因；
- 成功后：worktree 从侧栏移除（`removeWorkspace(id, { skipConfirm: true })` 内部路径）、关联 openTabs 关闭、终端 dock 清理（`removeTerminalWorkspace` 已有先例）。

### 5.6 级联提示（决策 #5）

`removeWorkspace` / `setWorkspaceArchived` 动作入口（`src/features/chat/store/workspaces.ts`）检查 `workspaces.some(w => w.parentId === id)`：有则先弹级联确认对话框（列出受影响 worktree 名，说明「一并移除，仅移除侧栏登记，不删磁盘目录——删除目录请逐个走删除 Worktree 流程」），确认后一并移除/归档。**注意区分**：移除父工作区登记 ≠ 删除 worktree 磁盘目录；git 层面 worktree 属于仓库不属登记，父登记移除后 worktree 仍在磁盘上，提示文案必须说清这一点。

### 5.7 i18n

新命名空间 `worktree.*`（`src/i18n/zh.ts` / `en.ts` 同步），约 40 条：对话框标题/Tab/字段/提示、进度阶段文案、errorKind 文案、删除预检文案、级联提示、菜单项。组件不写死中文。

### 5.8 规范更新（同提交，`docs/ui-ux-spec.zh-CN.md`）

- §3：worktree 侧栏行表达（层级/徽标/脏状态/禁用拖拽）、进度行三态、locked 禁删；
- §4/§7：进度行转圈**不是刷新入口**（一次性过程，不登记 §7），说明理由；
- §6：删除 Worktree 确认契约（预检三项 + 分支保留语义 + 级联提示）；
- 变更记录加一行。

---

## 6. 边界与错误处理

### 6.1 错误分类（`WorktreeErrorKind`）

| errorKind | 触发 | UI |
|---|---|---|
| `pr_not_found` | fetch pull/N ref 不存在 | 「PR 不存在、已关闭且 ref 被清理，或远端不是 GitHub」+ 重试 |
| `fetch_failed` | 网络/认证 | 「fetch 失败」+ 原始摘要 + 重试 |
| `branch_exists` | 分支已存在 | 预览阶段即红字；提交竞态时失败行给重试（改名后） |
| `dir_exists` | 目标目录已存在 | 同上 |
| `not_a_repo` | 父目录非 git 仓库 | 菜单项即禁用，正常到不了这步 |
| `invalid_branch` | check-ref-format 拒绝 | 行内红字 |
| `unknown` | 其他 | 原始错误摘要 + 重试 |

### 6.2 关键边界

- **父仓库自身是 linked worktree**：在其上再建 worktree 合法（git 支持），`repo_path` 照常解析；无需特判。
- **父工作区路径被改名/移动**：`parentId` 按 id 关联不受路径变化影响；worktree 磁盘目录若被外部移动，git 注册失效——`gitWorktreeList` 发现 prunable 时该行显示「目录已丢失」态（点击提供「从侧栏移除」），不假装正常。
- **创建期间应用退出**：子进程随应用退出被杀；下次启动时若发现 `kind="worktree"` 的登记对应目录不存在 → 同「目录已丢失」处理。
- **同名分支跨仓库**：分支名校验只在父仓库范围内，不跨工作区。
- **PR 已合并/关闭**：pull/N/head ref 通常仍在，可正常创建（审查历史 PR 是合法场景）；`gh` 可用时预览卡显示 state。
- **删除时有未推送提交**：预检 ahead > 0 即警示，无论是否删分支。
- **会话/终端进行中删除**：§5.5 的额外警示；确认后先停终端（现有 `removeWorkspace` 链路）再删目录。
- **Windows 路径**：`worktree_path` 构造统一走后端 `PathBuf`；分支名禁止 `\` 由 check-ref-format 兜底。

---

## 7. 测试计划

### 7.1 后端（`src-tauri`，`cargo test`）

- `git_worktree.rs`：PR 输入解析（`1842` / `#1842` / URL / 非法输入）；remote URL → owner/repo（https/ssh/非 GitHub）；分支名推导与冲突检测；`git_branch_merged`（已合入/未合入/无 base）；worktree add + list + remove 端到端（Scratch 仓库模式，参考 git.rs:1344 起的现有测试基建）；取消创建清理半成品；
- `db.rs`：workspaces 表两列迁移（旧库升级）；worktree 子项 upsert；旧版导入恢复（改造 :894 测试：worktree child 落库、父缺失跳过、目录不存在跳过）。

### 7.2 前端（vitest）

- `pr-input.test.ts` / `branch-name.test.ts`：纯函数全覆盖；
- `worktree/store.test.ts`：进度事件状态机（fetch→add→done / failed / canceled→retry）；
- `use-chat-sidebar.test.tsx`：树构建（worktree 挂载、父缺失降级、脏数据不丢条目）——沿用现有 fixture；
- `WorktreeCreateDialog.test.tsx`：三 Tab 校验、degraded 预览、冲突红字、提交即关；
- `DeleteWorktreeDialog.test.tsx`：预检三态（干净/脏/进行中任务）、分支保留语义。

### 7.3 冒烟（`pnpm dev`）

1. 从 PR 创建（有 gh / 无 gh 降级各一遍，含 fork PR）；
2. 新分支 + 已有分支创建；
3. 两个 worktree 各开会话并行跑 CLI，确认互不干扰、变更面板各自独立；
4. 取消创建（fetch 大仓库中途 ✕）；
5. 删除：干净 / 脏目录 / 未推送提交 / 勾选删分支 / locked；
6. 父工作区移除的级联提示；
7. 重启应用后 worktree 行状态正确（目录丢失态）。

---

## 8. 实施切片（按依赖排序，每片可独立验证）

| 片 | 内容 | 验证 |
|---|---|---|
| 1 | db 迁移 + Rust/TS `Workspace` 两字段 + `add_workspace` 扩展 + 旧版导入恢复 | cargo test（迁移/导入/upsert） |
| 2 | `git_worktree.rs`：list / create（含事件与取消）/ remove / branch_merged / resolve_pr | cargo test（Scratch 仓库端到端） |
| 3 | `src/features/worktree/`：store + api + 创建对话框 + 进度行 | vitest + 冒烟 1-4 |
| 4 | 侧栏：树构建 + worktree 子行渲染 + 右键菜单 | vitest + 冒烟 3 |
| 5 | 删除对话框 + 级联提示 + 目录丢失态 | vitest + 冒烟 5-7 |
| 6 | i18n 补全 + ui-ux-spec 更新 + 全量回归（`pnpm build`、相关 vitest、cargo test） | 规范清单逐项核对 |

---

## 9. 风险与开放点

- **git CLI 依赖**：创建/删除依赖用户机器有 `git` 命令。开发者桌面场景可假定存在；启动时探测一次，缺失则 worktree 入口整体禁用并说明（与 CLI 引擎缺失同一表达）。
- **gh CLI 增强的缓存**：`gh` 存在性探测结果缓存到进程生命周期；用户中途安装 gh 只需重开对话框（探测随对话框打开重跑）。
- **非 GitHub 远端**：v1 「从 PR 创建」只支持 GitHub；GitLab 等提示改用「已有分支」。若用户后续需要，`glab`/API 是 v2 议题。
- **meta 与 kind/parentId 双写一致性**：注册失败（`add_workspace` 报错）时磁盘 worktree 已存在——进度行转为失败并给「已创建但未登记，重试将复用现有目录」的恢复路径（重试时 `dir_exists` 分支识别该目录是合法 worktree 且分支匹配 → 直接补登记）。
