# CC GUI v1.0.3 版本记录

**发布日期**：2026-09-16（含 2026-09-15 起合并）
**对比**：v1.0.2 → v1.0.3（20 个提交，含 3 个合并 PR：#1219、#1221、#1224）

---

## ✨ 新功能

- **Windows 仿 Mac 自绘标题栏**（PR #1219, `ae4267bd9`）：Windows 版可切换为 macOS 风格的自绘标题栏。
- **侧栏工作区拖拽移动**（`97f64e810`）：工作区行可直接拖拽到分组 / 未分组 / 已归档容器完成移动。
- **插件 SDK 0.3.5 — 会话右键菜单扩展点**（`65d0fea9b`）：插件经 `ctx.ui.registerSessionMenuItem` 在侧栏会话右键菜单追加行（权限 `ui:session-menu`）。首个消费者：auto-title 的「重新命名」菜单项。
- **插件 SDK 0.3.6 — 深链自身设置页**（`5b8cd5bd9`）：`ctx.ui.openSettings(key?)` 跳转插件设置页（复用 `ui:settings-section` 权限，无新增授权项）。首个消费者：auto-title 状态栏 chip 点击改跳设置页。

## 🐛 问题修复

### Windows 进程泄漏（同一根因，多处封堵）

- **对话孙进程孤儿泄漏**（`9a46d259c`）：每轮 Claude 对话残留 pwsh.exe/conhost.exe 孤儿进程累积上千个拖垮系统。改用 Windows Job Object + `KILL_ON_JOB_CLOSE`，正常结束 / 停止 / 错误 / 崩溃收敛到同一次内核级清扫；Unix 侧同步清扫进程组。
- **dsh host 进程泄漏**（`8a6a00b3e`）：常驻 dsh web host spawn 接入 kill-on-close job，封堵退出后 pwsh 孙进程泄漏。
- 同时修复 codex 登录 shell 探针超时泄漏、`plugin_exec_run` 超时产生的孤儿进程。

### 上下文窗口显示（PR #1224）

- **压缩后分母回落 200k**（`f54dceab0`）：`/compact` 后 compact_boundary 的 usage 不含窗口、`refreshSessionUsage` 重读历史丢窗口，导致分母掉回 200k——两处补齐 mergeUsage（#227 #616 #683）。
- **跨会话记忆 + 回合结束自动重读**（`3292da68b`）：新会话分母不再从 200k 猜起，记忆每个 engine+model 最近一次上报的窗口（优先级：实时上报 > 记忆 > 模型目录 > 200k 兜底）；claude 回合结束自动重读真实占用，不再显示整回合请求累加值，无需手动「刷新用量」。

### 引擎与会话管理

- **claude auto 模式联网被拦截**（`3f4b54a54`）：预批准 WebSearch/WebFetch。
- **模型目录探测死循环风暴**（PR #1221, `6c0df4aca`）：DSH 客户端本机 origin 恒直连。
- **codex 旧 CLI 预检与错误横幅兜底**（`f6edea6db`）：send 前探测 `exec --json/resume` 支持并给出升级提示；非 JSON stdout 行进环形缓冲，stderr 为空时兜底进错误横幅；修复 ring 截断落在 CJK 边界导致 drain panic。
- **dsh/远程会话删除修复**（`f6edea6db`）：kimi/grok/dsh 发现与删除共用 anchor roots，修复 dsh 删除必失败复活；新增 `delete_remote_session` IPC 支持远程会话删除；未知引擎硬失败。会话标题截断时 hover 显示 tooltip。

## 🔧 重构

- `agent-thinking` 抽出 VariantIndicator/MetaRow 子组件，渲染行为不变（`b133d767c`）。

## 📄 文档

- README 新增 AtomGit 徽章与 G-Star 认证、托管致谢；Trendshift 与 AtomGit 徽章并排展示并修正仓库链接（`0412a1df6`、`15c8e8905`、`d713d1041`）。

---

**贡献者**：zhukunpenglinyutong、zhuji（朱昆鹏）、yi（Yi-Page）、MurasameCyan
