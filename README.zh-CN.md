<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui 图标" src="./public/app-icon.png" />

[English](./README.md) · **简体中文**

基于多引擎架构的 AI 编程桌面客户端定制发行版，聚焦跨引擎子任务编排、任务连续性更新机制、多渠道配额可观测性与严格的隐私安全边界。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## 源码状态、安装包与升级指南

- **当前 `main` 源码状态**：采用 **V3 持久化契约** 与 **通用插件 SDK 0.3.28**（详见[源码同步记录](./docs/releases/main-2026-10-26.md)）。应用界面显示版本标识仍为 `1.1.1+protected.35`。
- **原始 Tag 与安装包构建记录**：原始 tag `v1.1.1+protected.35` 的[构建记录与校验值](./docs/releases/1.1.1+protected.35.md)对应早期 **V2** 架构，不代表当前 main 源码。本次 main 源码同步并未打包发布新的安装包。已公开的安装包请前往 [GitHub Releases](https://github.com/Vanyangyang/ccgui-custom/releases) 结合资产构建记录核对；Source code (ZIP/TAR) 仅代表源码归档，并非安装包。
- **跨架构升级说明（V1/V2 → V3）**：
  - 从 V1 或 V2 升级至当前 V3 需进行**退出全部实例后用完整安装包升级**（使用由目标源码构建并通过验证的完整安装包）。
  - 升级前准备：请保存正在进行的工作、结束所有活动任务，并彻底退出所有 CC GUI 桌面实例及关联的后台 worker / supervisor 进程。
  - 运行完整安装包进行覆盖安装，既有用户数据目录会自动保留。
  - *注意*：应用内热更新无法跨越不兼容的底层数据契约；请勿尝试绕过兼容性校验、混用不兼容的 worker 版本或直接降级。详见[安装与恢复指南](./docs/custom-maintenance.zh-CN.md#安装与恢复)。

---

## 原版项目与鸣谢

- **原版开源仓库**：[**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **原版 Releases 下载**：<https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### 关于 CC GUI

**CC GUI (`desktop-cc-gui`)** 是由 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 发起并维护的开源 **多引擎 AI 编程桌面客户端**，基于 **Tauri 2 + React 18 + TypeScript + Rust** 构建。

项目通过 Rust 原生协议适配器将多种命令行 AI 编程工具统一整合到流畅的图形界面中，提供实时流式输出、思考链路折叠、Git Diff 与 Bash 工具交互查看、会话历史恢复、多供应商渠道管理、虚拟化工程文件树、内置 PTY 终端以及插件扩展系统。

> 衷心感谢原作者 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 及所有上游社区贡献者的出色工作！如需体验标准官方版本或查看原版完整指南，请访问 [原版仓库](https://github.com/zhukunpenglinyutong/desktop-cc-gui)。

---

## 本定制发行版的核心特性

本发行版基于上游 `v1.1.0` / `v1.1.1` 定制演进。公开源码统一维护于 **`main`** 分支（`custom/protected` 为本地部署维护分支）。主要改造涵盖多 Agent 编排协同、兼容更新中的任务连续性保持、多渠道用量可观测性以及网络通信与隐私安全加固。

> [!IMPORTANT]
> **CLI 渠道兼容验证范围**
> 本定制版目前针对以下 **4 个主流 CLI 渠道** 开展持续的深度兼容适配与自动化回归测试：
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> 原版中的其他 CLI 渠道（如 Kimi CLI、Grok CLI、Pi CLI、OMP CLI、DeepSeek Harness、OpenCode、Qoder 等）在源码中保留，但**未在本定制分支中做持续验证**。自动化回归用于保证代码库本身契约完整，不代表对所有模型及计费渠道均完成了真实模型端到端验收。Windows 安装包有对应构建记录，该记录不认证 macOS/Linux 安装包。

### 1. 四大主力引擎深度运行时适配
- **Cursor CLI 引擎适配**：接入 Cursor 原生会话体系，支持模型选择、推理强度（Effort）切换与历史会话识别恢复。
- **Antigravity CLI (AGY) 与 Vertex 独立通道**：支持本机 CLI 模型及推理档位实时同步、宿主暂存工作区（Staging），并建立了独立的 Vertex 计费通道桥接机制，防范跨计费通道的会话混淆或非预期静默回退。
- **Codex Desktop 命名管道协同**：当 Codex 线程已被活动的 Codex Desktop 占用时，自动通过本地命名管道交接任务，并在 CC GUI 界面中实时回显输出与执行进度。
- **Claude Code 原生中断与后台协同**：支持在后台任务执行期间主对话继续交互；点击 `Stop` 仅中断当前轮次输出，不误杀正在运行的后台子任务；抑制了 Windows 环境下 Haiku 辅助探测时触发的控制台闪烁。

### 2. 跨引擎任务编排与跨会话通信（`ccgui` 宿主 MCP）
- **层次化任务编排**：内置 `ccgui` MCP 工具集（`task_spawn`、`task_list`、`task_wait`、`task_send`、`task_renew`、`task_stop`），支持构建跨 Claude、Codex、AGY 与 Cursor 的父子任务执行树，支持配置各引擎允许的模型白名单与生命周期 TTL。
- **跨会话异步通信**：通过 `list_chats`、`send_message`、`get_message_status` 实现已保存会话间的消息互通与状态查询。
- **真实工作区与权限保留**：跨工作区子任务保留各自真实的执行目录与原生父任务权限；侧边栏项目归属整理不会擅自迁移会话执行路径；待成本审批由用户明确批准或取消。

### 3. 便捷交互体验：轻量旁聊、图片标注与交互卡片
- **轻量旁聊（`/btw` 与 `/sidechat`）**：在不中断主任务的情况下，可通过 `/btw` 临时提问或开启 `/sidechat` 独立旁聊，支持**只读 / 可执行权限实时切换**、截图粘贴、内容一键复制、插入输入框草稿或晋升为正式对话。
- **图片预览与区域标注**：会话或草稿中的图片支持打开灯箱视图，可交互拖拽标注最多 9 处编号红框（`#1`–`#9`）并添加文字说明，点击「加入草稿」即可自动携带图片与归一化矩形坐标。
- **Intelligence UI 交互式回答**：支持结构化问答卡片，状态参数按会话与代码块持久化隔离，支持参数调整、冲突检测并可一键将结果追加至输入框草稿。

### 4. 内置助手完成提醒与独立进度旁白
- **管理任务完成提醒**：原生桌面完成浮层提醒、顶栏铃铛历史、精确会话回跳与 Windows 离线语音提醒。
- **独立进度旁白**：提供可选的独立进度旁白，通过 Vertex、Claude、Codex 或 Pi 等已接入渠道的无工具隔离调用生成简明旁注；接入支持不代表每个模型均已完成实机端到端验收。

### 5. 额度用量监测、吞吐遥测与上下文管理
- **供应商真实口径用量展示**：客观呈现供应商原始额度窗口（Claude/Codex 5 小时与周度窗口、AGY 模型额度、Cursor 当前计费周期用量）。无数据时保持未知状态，明确区分重置时间与陈旧指标，不伪造数据。
- **吞吐与缓存遥测**：支持展示可用引擎的实时输出速率（TPS）、Prompt 缓存热度指示以及单轮回复总结（耗时、Token 分布、缓存用量、思考量、工具调用计数与均速）。
  > [!NOTE]
  > 本客户端不展示/不估算 Cursor TPS 指标；Cursor 的 5 分钟缓存窗口提示与 Codex 的永久缓存标识均属于客户端可视化辅助策略，不代表供应商实际缓存命中或永久驻留保证。
- **上下文管理**：支持自定义 Claude（默认 750K）与 Codex 的自动压缩上下文窗口阈值，并提供隔离调用生成的智能会话命名功能。

### 6. 独立任务 Worker 与受控平滑更新机制
- **Worker 托管任务连续性**：受支持的主力引擎（Claude、Codex、AGY、Cursor）普通及托管运行由独立的后台 worker 承载，具备持久化事件流与幂等回执。在向兼容的新版本切换时，正在运行的任务与事件游标可接管恢复。
- **后台快照隔离构建**：更新协调器固定源码快照构建，经校验无变更的原生编译缓存可直接复用；构建耗时取决于实际改动与缓存状态。
- **状态检查点与安全边界恢复**：切换过程界面可能经历短暂重连；受支持的会话状态、草稿输入、附件、布局以及 worker 游标将被恢复。若存在未保存的外部编辑器或不受管资源，系统会等待达到安全检查点再执行切换。
- **兼容性门禁与安全回退**：更新过程核验 worker 协议、检查点与持久化契约的兼容性。如切换后健康检查未通过，系统将在兼容事务内自动回退。不兼容的架构升级（如 V1/V2 到 V3）必须退出全部实例后使用完整安装包升级；应用内热更新无法让不兼容的数据契约热升级。平滑更新不能承诺任意任务零打断、所有插件状态无损恢复或秒级构建。
- **自开发工作区联动**：可将本地代码库注册为 `ccgui-custom [自开发]`，在设置中支持一键「构建并热更新」。

### 7. 网络代理隧道、启动保护与隐私加固
- **严格 HTTP CONNECT 代理隧道**：外网 WebSocket Relay 通信严格经由配置的代理通道建立，当代理不可用时坚决拒绝降级直连，防范意外流量外泄。
- **自适应单实例与启动前校验**：安装包与自更新目录内置单实例互斥锁与可选的代理/防火墙预检门禁。全新安装默认关闭强制校验以保证开箱即用，已启用本地代理保护的环境在更新时延续保护策略。开启保护后，普通程序入口也会执行内置预检；已有的「CC GUI（代理保护）」快捷方式会在此基础上额外执行一层本机脚本预检（脚本与防火墙规则为本机前提，非全新设备自动部署）。
- **停用上游在线自动更新**：显式设置 `IS_CUSTOM_DISTRIBUTION = true` 并关闭 `createUpdaterArtifacts` 与上游 GitHub Releases 更新检查，防止上游通用安装包覆盖定制版。冷升级使用经过验证的完整定制安装包，兼容改动走本地更新流程。
- **彻底移除第三方遥测**：删除了原版内置的百度统计模块（`analytics.ts`、`baidu_tongji.rs`）及关联的 IPC 接口；打包构建严格实施 CSP（内容安全策略）限制（由 `tests/privacy-boundary.test.ts` 守护），禁止加载非本地脚本或外部图片追踪像素，并默认禁止插件请求自动重定向。

### 8. 项目管理视图与通用插件 SDK 0.3.28
- **项目级工作区管理**：支持将多个登记的工作区聚合归纳为统一项目视图，合并文件浏览与引用视图，同时严格保留各会话的原生工作目录（cwd）。解除项目组织关系不删除文件，也不转移执行权限。
- **通用插件 SDK 0.3.28**：支持带权限作用域的项目发布、独立窗口生命周期、原生任务协调机制、持久化讨论串以及**所属图片附件**。
- **原生固定指令与受限记忆**：固定指令使用受支持的原生指令通道；`host:memory` 记忆提炼依据所属来源证据执行。
- **更新前服务关闭与确认退出**：更新前关闭钩子排空已受理操作并核实插件服务已退出；各接口严格实施所有权校验、取消控制、未知结果不重放与证据检验。详见 [SDK 变更记录](./packages/plugin-sdk/CHANGELOG.md)和[插件开发指南](./docs/plugin-development-guide.zh-CN.md)。

---

## 源码构建指南

### 环境准备
- **Node.js**：推荐 **Node 24**（实测 24.14；最低支持 **22.13.0**）。
- **pnpm**：要求固定使用 **11.19.0**（`npm install --global pnpm@11.19.0`）。
- **Rust**：Stable **1.95+**（实测 1.99）。
- **Git**。
- **系统依赖**：
  - **Windows**：按照 [Tauri 官方指引](https://v2.tauri.app/start/prerequisites/) 安装 MSVC C++ 构建工具、Windows SDK 与 WebView2（**无需安装 Perl**）。
  - **macOS / Linux**：安装 Tauri 2 所需的 WebKit 及编译套件（注：本仓库的主力打包验证目前主要以 Windows 为准）。

### 构建步骤

```bash
# 1. 克隆代码仓库（建议目录名：ccgui-custom）
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. 安装指定版本 pnpm 并安装项目依赖
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. 在同一干净检出中执行全量验证并构建 Windows 安装包
pnpm maint:check
pnpm maint:build
# 构建产物位于：src-tauri/target/release/bundle/nsis/
```

### 构建与分发注意事项
- **检验与构建版本一致性**：`pnpm maint:check` 与 `pnpm maint:build` 必须在**同一个干净的 Git commit** 上运行。打包程序会核对当前 commit 是否具备完整的校验通过记录。
- **构建路径限制**：源码根目录、用户主目录以及 Cargo 缓存路径中**切勿包含 `=` 字符**。MSVC 对含 `=` 的路径脱敏/裁剪处理不完全，打包程序会在编译前主动拦截并拒绝该路径。中文与空格路径已提供良好支持。
- **独立离线打包**：构建生成的正式安装包已完整内置前端资源，无需在后台启动任何 dev server。分发时仅需提供生成的 NSIS 安装包，切勿打包或分享本地构建日志、调试记录或用户配置目录。
- **按需配置 CLI**：构建和启动客户端并不要求预先安装全部 AI CLI 工具，日常使用哪款引擎在客户端内按需配置即可。构建脚本继承进程环境与 Git 代理设置，无需固定本地代理端口（`maint:integrate` 与 `maint:install` 仅为内部维护工作流，普通安装无需执行）。

启动本地前端热更新开发调试：

```bash
pnpm dev
```

---

## 自开发工作区登记与增量更新

1. **自动识别源码目录**：运行 `pnpm maint:build` 或 `pnpm dev` 会将当前源码路径自动记录到本机用户数据目录下的 `default-source-root.txt`（该文件位于仓库外，切勿提交或外发）。同一系统账户首次启动正式版时，侧边栏会自动载入 `ccgui-custom [自开发]` 工作区及设置中的路径配置；若将安装包复制到其他机器或切换账户，只需在设置中手动指定当前机器上的源码目录即可。
2. **AI 辅助更新就绪**：源码改动通过测试后，可通过 `coordinate_self_update(ready)` 登记更新就绪状态。登记仅表示代码已验证，不会直接触发编译或切换。
3. **触发平滑更新**：在代码拉取（`git pull`）或本地修改后，可在设置中点击「构建并热更新」。系统会比对持久化契约版本；若候选版本契约不兼容，热更新将被拦截，须改为退出全部实例后使用完整安装包升级。
4. **切换与事务回退**：后台构建在独立快照中进行。编译完成后等待安全检查点接入新版本并恢复界面连接。如新实例健康检查失败，将在事务内安全回退。

---

## 常用开发与维护命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动本地 Tauri 开发调试环境（支持热重载） |
| `pnpm build` | 执行 TypeScript 类型检查并打包前端生产资源 |
| `pnpm test` | 运行 Vitest 测试用例 |
| `pnpm maint:check` | 运行定制版全套回归检验（隐私边界、类型、Vitest、Rust 单元测试） |
| `pnpm maint:build` | 构建带 `+protected.N` 标识的 Windows NSIS 安装包并输出校验记录 |
| `pnpm maint:self-update` | 构建本地运行中热更新候选包 |

*注意*：发布或同步源码时，请务必排除本机特有路径、访问凭证、历史会话、运行数据库、调试日志及编译产物。

---

## 相关文档指引

更详细的设计与开发规范请参考（中文）：
- [定制维护指南](./docs/custom-maintenance.zh-CN.md)
- [运行中热更新设计说明](./docs/runtime-live-update.zh-CN.md)
- [助手提醒与独立旁白说明](./docs/assistant-notices.zh-CN.md)
- [界面与交互规范 (UI/UX Spec)](./docs/ui-ux-spec.zh-CN.md)
- [插件 SDK 变更日志](./packages/plugin-sdk/CHANGELOG.md)
- [插件开发指南](./docs/plugin-development-guide.zh-CN.md)

---

## 开源许可证

本项目基于 [MIT License](./LICENSE) 开源，保留原作者 `Thomas Ricouard` 与 `zhukunpenglinyutong（朱昆鹏）` 的原始版权声明。
