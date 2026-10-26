<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui 图标" src="./public/app-icon.png" />

[English](./README.md) · **简体中文**

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## 当前源码、安装包与升级

- **main 源码（2026-10-26）：V3 持久化契约，通用插件 SDK 0.3.28。** 查看[源码同步记录与范围](./docs/releases/main-2026-10-26.md)。不包含独立游戏工作台插件、素材及专属验收脚本；保留客户端与 SDK 的通用能力。
- **原始 tag `v1.1.1+protected.35`：V2，Windows x64。** [发行记录与校验值](./docs/releases/1.1.1+protected.35.md)对应原始构建，不代表当前 main。应用显示版本仍为 `1.1.1+protected.35`，须通过源码提交、schema 探针与安装包 SHA-256 区分实际构建。
- 已公开的定制安装包请查看[本仓库 Releases](https://github.com/Vanyangyang/ccgui-custom/releases)，并核对资源的构建记录。Source code ZIP/TAR 是源码，不是安装包。本次 main 源码同步没有发布新的安装包。
- **V1/V2 → 当前 V3 须使用目标源码构建并验证的完整安装包。** 保存工作、结束全部任务，退出全部 CC GUI 实例及相关 worker/supervisor 后再安装，保留数据目录。原始 V2 安装包不能完成这次升级；不能绕过 schema 检查、混用不兼容 worker 或直接降级。详见[安装与恢复](./docs/custom-maintenance.zh-CN.md#安装与恢复)。

## 原版仓库与鸣谢

- **原版开源仓库**：[**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **原版 Releases 下载**：<https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### 原版项目简介

**CC GUI（`desktop-cc-gui`）** 是由 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 发起并维护的开源 **多引擎 AI 编程桌面客户端**（基于 **Tauri 2 + React 18 + TypeScript + Rust** 构建）。

它通过 Rust 原生协议适配器将 **Claude Code**、**Codex CLI**、**Kimi CLI**、**Grok CLI**、**Pi CLI**、**OMP CLI**、**DeepSeek Harness（DSH）**、**Antigravity**、**OpenCode**、**Qoder** 等命令行 AI 编程工具统一到同一个图形界面中，支持实时流式输出、思考过程折叠、工具调用 Diff/Bash 查看、会话历史恢复、供应商渠道配置、虚拟化文件树、CodeMirror 编辑器、内置 PTY 终端、Git 面板、局域网 Web 访问以及插件系统（`@ccgui/plugin-sdk`）。

> 衷心感谢原作者 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 及所有上游社区贡献者的出色工作！如果您需要标准官方版本或了解原版完整功能列表，请直接访问 **[原版仓库](https://github.com/zhukunpenglinyutong/desktop-cc-gui)**。

---

## 本仓库定制说明（相比原版的增删改动）

本仓库基于原版 `v1.1.0` / `v1.1.1` 维护定制发行版。**公开源码使用 `main` 分支**，`custom/protected` 是本地维护分支。主要改造涵盖多代理协作、兼容更新中的任务连续性、配额可观测性、通用插件能力与隐私边界。

> [!IMPORTANT]
> **CLI 渠道兼容验证范围说明**
> 本定制版目前仅针对以下 **4 个 CLI 渠道** 进行了深度兼容检查与回归验证：
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> 原版中包含的其他 CLI 渠道（如 Kimi CLI、Grok CLI、Pi CLI、OMP CLI、DeepSeek Harness、OpenCode、Qoder 等）**暂未在本定制版中进行兼容验证**。
>
> 自动化源码回归不等于每个引擎、模型及计费渠道都完成真实模型端到端验收。Windows 安装包有对应构建记录，该记录不认证 macOS/Linux 安装包。

### 一、新增与增强的内容（Added & Enhanced）

1. **四大主力引擎深度运行时适配（Claude Code / Codex CLI / Antigravity CLI / Cursor CLI）**
   - **新增 Cursor CLI 引擎接入**：支持 Cursor 原生会话管理、模型与推理强度（Effort）切换、历史会话扫描与恢复。
   - **Antigravity (AGY) 深度增强与 Vertex 通道**：支持从本机 CLI 实时同步模型与推理档位、宿主暂存工作区（Staging）、独立 Vertex 计费通道桥接与历史隔离（拒绝跨计费通道混用或静默回退订阅）。
   - **Codex Desktop 线程无缝交接**：当续写的 Codex 线程被 Codex Desktop 占用时，自动通过本机命名管道交由 Desktop 执行并在 CC GUI 中同步展示进度与输出。
   - **Claude Code 原生中断与后台子代理共处**：支持后台任务运行期间主对话继续交互，`Stop` 仅中断当前回复而不误杀后台子代理；修复 Windows 下 Haiku 辅助探测闪烁终端窗口的问题。

2. **跨引擎子任务编排与跨会话通信（Host Chat MCP & Task Tools）**
   - 内置 `ccgui` 宿主 MCP 服务，支持 `task_spawn`、`task_list`、`task_wait`、`task_send`、`task_renew`、`task_stop` 创建和管理跨引擎（Claude / Codex / AGY / Cursor）父子任务树，支持按引擎配置允许的子任务模型白名单与默认 TTL。
   - 支持 `list_chats`、`send_message`、`get_message_status` 跨已保存会话异步投递消息与查询回执。
   - 跨工作区子任务保留真实执行目录与原生父任务权限；侧栏归属整理不迁移会话执行目录，待成本审批仍由人工决定。

3. **轻量旁聊（Sidechat / `/btw`）、图片圈选批注与交互式回答（Intelligence UI）**
   - 支持在主任务运行期间发起 `/btw` 临时提问与 `/sidechat` 连续旁聊（支持**只读 / 可执行模式实时切换**、粘贴截图附件、复制、插回主输入框或晋升为独立对话）。
   - **图片预览圈选批注**：点击会话或输入框中的图片打开大图预览，支持拖拽绘制最多 9 处编号红框（`#1`–`#9`）并填写修改说明，一键「加入草稿」自动附图与精确归一化坐标说明。
   - 新增结构化交互问答卡片（Intelligence UI），支持按会话与代码块持久化参数、冲突检测及一键追加到来源草稿。

4. **内置助手提醒与独立进度旁白（Assistant Notices & Observer）**
   - 原生管理任务完成桌面浮层提醒、顶栏铃铛历史、精确会话回跳与 Windows 离线语音提示。
   - 支持可选的运行中/完成后独立进度旁白生成（支持 Vertex 及 Claude / Codex / Pi 的无工具隔离调用）。

5. **多引擎剩余额度、TPS 吞吐监测与上下文管理**
   - 按供应商实际口径展示：Claude/Codex 提供的 5 小时与周窗口、AGY 模型额度，以及 Cursor 本计费周期的 Auto/其他模型用量。缺失数据不编造，重置时间与旧样本保留各自含义。
   - 展示可得的 TPS、Prompt 缓存热度与每轮回复小结（耗时、Token、缓存、思考量、工具调用次数与整轮均速）。Cursor 不估算 TPS；其 5 分钟缓存窗口与 Codex 的永久缓存显示均为客户端策略，不证明供应商实际命中或永久保留。
   - 支持配置并同步 Claude（默认 750K）与 Codex 的自动压缩上下文窗口阈值，以及基于隔离调用的会话自动命名。

6. **独立任务执行器与兼容性受控的运行中更新**
   - **由 worker 持有的任务连续性**：受支持的本机 Claude/Codex/AGY/Cursor 普通及托管运行使用独立 worker、耐久事件与幂等回执。兼容的宿主切换恢复原运行及事件游标；旧宿主已持有的任务、WSL 和其他未支持链路不会追溯获得这种能力。
   - **后台隔离构建**：协调器固定源码快照；通过输入校验的缓存可以复用未变的原生代码，耗时取决于实际改动与缓存状态。
   - **受支持的检查点与安全边界**：界面切换可能短暂重连。已支持的会话、草稿、图片、布局和 worker 游标可恢复；未保存编辑器、仍由宿主持有的活动资源和不支持接管的插件视图可能阻塞切换，恢复证据缺失或损坏时不能确认健康。
   - **兼容与回退门闩**：worker 协议、检查点与持久化契约必须匹配，健康失败仅在兼容事务内回退。V1/V2 → V3 必须按上文完整退出安装，按钮不能让不兼容的数据契约热升级。
   - **自开发目录与构建入口**：本地源码可登记为 `ccgui-custom [自开发]`，在工作区及更新设置中提供「构建并热更新」。手动改码或 `git pull` 后，是否允许热切换仍由同一兼容检查决定。

7. **代理隧道与启动保护门闩（三态自适应）**
   - **严格代理隧道**：外网 Relay 中继连接严格通过应用配置的 HTTP CONNECT 代理隧道建立连接，代理未就绪时拒绝直连降级，防止流量意外泄露。
   - **自适应单实例与启动前校验**：Windows 正式版与自更新版本目录（`~/.ccgui-next/runtime-updates/releases/<hash>`）内置单实例互斥锁与可选的启动前代理/防火墙校验——全新安装默认关闭强制代理门禁（开箱即用），而已启用本地代理保护的老版本在热自更新时会自动识别并延续保护策略。
   - 启用保护时，普通程序入口也执行内置校验；已有的 **「CC GUI（代理保护）」** 快捷方式先运行本机保护脚本，再启动同一程序。脚本与防火墙配置是本机前提，不会在每台全新机器上自动部署。

8. **项目视图与通用插件 SDK 0.3.28**
   - 将登记工作区组织为项目，聚合文件与引用视图，同时保留各会话真实目录；解除组织关系不删除文件，也不转移执行权限。
   - 提供受授权约束的项目发布、独立窗口、原生任务协调、持久讨论/任务会话和所属图片附件。固定指令使用已支持的原生指令通道；`host:memory` 下的受限记忆提炼依据所属来源证据执行。
   - 更新前关闭钩子排空已受理操作并核实插件服务已退出；各接口继续执行所有权、取消、未知结果不重放与证据校验。详见 [SDK 变更记录](./packages/plugin-sdk/CHANGELOG.md)和[插件开发指南](./docs/plugin-development-guide.zh-CN.md)。

---

### 二、删除与停用的内容（Removed & Disabled）

1. **移除第三方统计与遥测代码**
   - 删除了原版中的百度统计模块（`src/lib/analytics.ts`、`src-tauri/src/baidu_tongji.rs`）及相关 IPC 命令。
   - 收紧打包应用的 CSP（Content Security Policy）策略，仅允许加载打包与本地资源，禁止远程脚本与外部图片信标（由 `tests/privacy-boundary.test.ts` 回归守护）；插件 HTTP 请求默认禁止自动跟随重定向。

2. **停用原版 GitHub Releases 在线自动更新**
   - 显式启用 `IS_CUSTOM_DISTRIBUTION = true` 并关闭 `createUpdaterArtifacts`，移除设置页向原版仓库拉取在线安装包更新的入口，防止上游通用安装包覆盖定制版。冷升级使用验证过的完整定制安装包，兼容改动可使用本地更新通道。

3. **精简聊天底栏冗余代理入口**
   - 移除了聊天输入框底栏的快捷代理切换按钮（网络代理配置统一在「设置 → 网络代理」中集中管理）。

---

## 从 GitHub 构建与自开发更新（`ccgui-custom`）

### 1. 首次从 GitHub 克隆与安装
环境要求：**Node.js 24**（实测 24.14；最低 **22.13.0**）、固定版本 **pnpm 11.19.0**、**Git** 和 **Rust stable 1.95+**（已测试 1.99）。Windows 请按 [Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/) 安装 MSVC C++ 构建工具、Windows SDK 和 WebView2（**无需安装 Perl**）。其他平台需安装各自的 Tauri 系统依赖；以下 Windows 打包流程不代表 macOS/Linux 安装包已完成验证。

```bash
# 1. 克隆仓库到本地目录（建议命名为 ccgui-custom）
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. 安装固定版本包管理器与工作区依赖
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. 在同一干净检出中验证 main，再构建 Windows 正式安装包
pnpm maint:check
pnpm maint:build
# 构建完成后运行 src-tauri/target/release/bundle/nsis/ 下的 setup.exe 完成安装
```

**构建与分发注意事项：**
- **校验与打包一致性**：`maint:check` 与 `maint:build` 之间请保持源码工作区干净且处于同一 Git 提交；若检查失败，请修复后重新运行 `maint:check`（`maint:build` 会校验同提交的成功检查记录）。
- **路径字符要求**：Windows 发布路径脱敏已支持空格与中文，但源码目录、用户主目录及 Cargo 缓存路径**不能包含 `=` 号**（MSVC 对含 `=` 的路径只能部分裁剪，打包脚本会在编译前直接拦截）。
- **安全分享安装包**：正式安装版已内嵌完整前端资源，无需运行开发服务器。打包过程会自动检查本机路径提示与可执行文件中的构建路径；对外分享时只需分发生成的 NSIS 安装包，切勿直接上传本地构建报告、日志或用户数据目录。
- **按需配置引擎**：构建和启动应用无需预先安装各个 AI CLI，后续实际使用哪个引擎再配置即可。构建脚本仅继承当前进程环境与 Git 代理设置，不依赖特定本地代理端口，也不会读取本机 Claude 配置（`maint:integrate` 与 `maint:install` 仅为内部维护工作流，普通安装无需执行）。

需要开发调试时，可在安装依赖后单独运行：

```bash
pnpm dev
```

### 2. 自开发目录登记与后续更新
**构建会为同一系统账号记录本地源码目录。只有运行版与候选契约兼容时才能热切换；尤其不能通过热更新从原始 V2 tag 跨入当前 V3 main。**

1. **构建后首次启动自动识别**：执行 `pnpm maint:build` 或 `pnpm dev` 时，构建脚本会将当前仓库路径记录到用户应用数据目录的 `default-source-root.txt`（位于仓库外部的本机提示文件，切勿提交或随包分发）。同一系统账号下首次启动正式版时，会自动填充侧栏的 `ccgui-custom [自开发]` 工作区及「设置 → 工作区 → CC GUI 自开发工程目录」；若将安装包复制到其他机器使用，只需在设置中手动指定那台机器上的源码目录即可。
2. **让 AI 准备更新**：源码修改通过验证后可登记 `coordinate_self_update(ready)`。登记只记录就绪，不请求构建或激活；明确提出更新请求后进入协调流程，仍须检查兼容性与切换阻塞。
3. **手动 `git pull` 或改码之后**：兼容改动可以使用工作区/更新设置中的「构建并热更新」。不兼容候选会被拒绝，应改走完整安装包升级，不能绕过检查。
4. **兼容更新期间**：后台构建使用隔离快照，切换等待资源所有权与检查点的安全边界，界面可能短暂重连。受支持的 worker 运行与草稿可恢复；不受管理的进程或不支持接管的视图可能要求先结束工作。只有健康事务实际提交才表示更新成功。

---

## 常用开发与维护命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Tauri 开发模式 |
| `pnpm build` | TypeScript 类型检查 + 前端生产构建 |
| `pnpm test` | 运行 Vitest 测试套件 |
| `pnpm maint:check` | 运行定制版全量回归检查（含隐私边界、类型、Vitest 与 Rust 核心模块测试） |
| `pnpm maint:build` | 构建带 `+protected.N` 标识的 Windows NSIS 安装包并生成校验报告 |
| `pnpm maint:self-update` | 构建本地热自更新（Live Update）候选包 |

发布源码必须排除本机路径、凭据、会话历史、运行数据库、日志与构建产物。当前源码扫描通过，不会自动清除旧 Git 历史中已有的信息。

详细架构与维护规范参见：
- [定制维护说明](./docs/custom-maintenance.zh-CN.md)
- [运行中热更新说明](./docs/runtime-live-update.zh-CN.md)
- [内置助手提醒与独立旁白](./docs/assistant-notices.zh-CN.md)
- [界面与交互规范](./docs/ui-ux-spec.zh-CN.md)

---

## License

本项目遵循 [MIT License](./LICENSE) 开源协议，保留原作者 `Thomas Ricouard` 与 `zhukunpenglinyutong（朱昆鹏）` 的版权声明。
