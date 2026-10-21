<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui 图标" src="./public/app-icon.png" />

[English](./README.md) · **简体中文**

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## 定制版版本与下载

- 当前发布候选：**1.1.1+protected.35（Windows x64）**。查看[版本说明、升级步骤与校验信息](./docs/releases/1.1.1+protected.35.md)。
- 定制安装包通过[本仓库 Releases](https://github.com/Vanyangyang/ccgui-custom/releases)分发；若尚未列出安装包，表示上传发布尚未完成。Git tag 的 Source code ZIP/TAR 是源码，不是安装包。
- **从 protected.34/V1 升级须先结束任务并退出全部 CC GUI 实例，再安装完整 NSIS 包**，不能使用无重启热更新。主分支可能包含发布后的改动；安装包对应固定 tag 与 SHA-256，不随 main 自动变化。

## 原版仓库与鸣谢

- **原版开源仓库**：[**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **原版 Releases 下载**：<https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### 原版项目简介

**CC GUI（`desktop-cc-gui`）** 是由 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 发起并维护的开源 **多引擎 AI 编程桌面客户端**（基于 **Tauri 2 + React 18 + TypeScript + Rust** 构建）。

它通过 Rust 原生协议适配器将 **Claude Code**、**Codex CLI**、**Kimi CLI**、**Grok CLI**、**Pi CLI**、**OMP CLI**、**DeepSeek Harness（DSH）**、**Antigravity**、**OpenCode**、**Qoder** 等命令行 AI 编程工具统一到同一个图形界面中，支持实时流式输出、思考过程折叠、工具调用 Diff/Bash 查看、会话历史恢复、供应商渠道配置、虚拟化文件树、CodeMirror 编辑器、内置 PTY 终端、Git 面板、局域网 Web 访问以及插件系统（`@ccgui/plugin-sdk`）。

> 衷心感谢原作者 [**@zhukunpenglinyutong（朱昆鹏）**](https://github.com/zhukunpenglinyutong) 及所有上游社区贡献者的出色工作！如果您需要标准官方版本或了解原版完整功能列表，请直接访问 **[原版仓库](https://github.com/zhukunpenglinyutong/desktop-cc-gui)**。

---

## 本仓库定制说明（相比原版的增删改动）

本仓库是基于原版 `v1.1.0` / `v1.1.1` 维护的个人定制发行版（`custom/protected`），在保留原版多引擎桌面体验的基础上，针对多代理协作、运行连续性、配额可观测性与隐私边界进行了以下增删改造：

> [!IMPORTANT]
> **CLI 渠道兼容验证范围说明**
> 本定制版目前仅针对以下 **4 个 CLI 渠道** 进行了深度兼容检查与回归验证：
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> 原版中包含的其他 CLI 渠道（如 Kimi CLI、Grok CLI、Pi CLI、OMP CLI、DeepSeek Harness、OpenCode、Qoder 等）**暂未在本定制版中进行兼容验证**。

### 一、新增与增强的内容（Added & Enhanced）

1. **四大主力引擎深度运行时适配（Claude Code / Codex CLI / Antigravity CLI / Cursor CLI）**
   - **新增 Cursor CLI 引擎接入**：支持 Cursor 原生会话管理、模型与推理强度（Effort）切换、历史会话扫描与恢复。
   - **Antigravity (AGY) 深度增强与 Vertex 通道**：支持从本机 CLI 实时同步模型与推理档位、宿主暂存工作区（Staging）、独立 Vertex 计费通道桥接与历史隔离（拒绝跨计费通道混用或静默回退订阅）。
   - **Codex Desktop 线程无缝交接**：当续写的 Codex 线程被 Codex Desktop 占用时，自动通过本机命名管道交由 Desktop 执行并在 CC GUI 中同步展示进度与输出。
   - **Claude Code 原生中断与后台子代理共处**：支持后台任务运行期间主对话继续交互，`Stop` 仅中断当前回复而不误杀后台子代理；修复 Windows 下 Haiku 辅助探测闪烁终端窗口的问题。

2. **跨引擎子任务编排与跨会话通信（Host Chat MCP & Task Tools）**
   - 内置 `ccgui` 宿主 MCP 服务，支持 `task_spawn`、`task_list`、`task_wait`、`task_send`、`task_renew`、`task_stop` 创建和管理跨引擎（Claude / Codex / AGY / Cursor）父子任务树，支持按引擎配置允许的子任务模型白名单与默认 TTL。
   - 支持 `list_chats`、`send_message`、`get_message_status` 跨已保存会话异步投递消息与查询回执。

3. **轻量旁聊（Sidechat / `/btw`）、图片圈选批注与交互式回答（Intelligence UI）**
   - 支持在主任务运行期间发起 `/btw` 临时提问与 `/sidechat` 连续旁聊（支持**只读 / 可执行模式实时切换**、粘贴截图附件、复制、插回主输入框或晋升为独立对话）。
   - **图片预览圈选批注**：点击会话或输入框中的图片打开大图预览，支持拖拽绘制最多 9 处编号红框（`#1`–`#9`）并填写修改说明，一键「加入草稿」自动附图与精确归一化坐标说明。
   - 新增结构化交互问答卡片（Intelligence UI），支持按会话与代码块持久化参数、冲突检测及一键追加到来源草稿。

4. **内置助手提醒与独立进度旁白（Assistant Notices & Observer）**
   - 原生管理任务完成桌面浮层提醒、顶栏铃铛历史、精确会话回跳与 Windows 离线语音提示。
   - 支持可选的运行中/完成后独立进度旁白生成（支持 Vertex 及 Claude / Codex / Pi 的无工具隔离调用）。

5. **多引擎剩余额度、TPS 吞吐监测与上下文管理**
   - 输入框下方状态栏常驻展示 Claude、Codex、Antigravity、Cursor 的 **5 小时 / 7 天窗口剩余额度百分比**及本地重置时间（通过正常对话流快照与本地缓存读取，不额外发起轮询请求）。
   - 新增独立 TPS（Token 生成吞吐率）统计链、Prompt 缓存热度指示与每轮回复小结（耗时、Token、缓存、思考量、工具调用次数与整轮均速）。
   - 支持配置并同步 Claude（默认 750K）与 Codex 的自动压缩上下文窗口阈值，以及基于隔离调用的会话自动命名。

6. **独立任务执行器（Task Worker）与无感热自更新（Live Update）**
   - **后台任务独立保活，界面重启不断连**：普通本地 Claude / Codex 会话运行在独立于 GUI 宿主的 `task-worker` 进程中，具备耐久事件日志（`events.jsonl`）与幂等命令回执。即使 GUI 界面重启或热切换，正在运行的 AI 任务也不会中断，切换完成后流式输出按游标无缝续接，不丢字、不重发。
   - **自更新全程不影响正常使用**：内置 `ccgui-self-update` 协调器与 `self-update-build.mjs`，从构建到切换均经过无感设计：
     - **后台快照隔离构建，不卡界面不占工作区**：触发更新后，后台自动抓取隔离的源码快照进行增量编译（纯前端改动直接秒级复用原生二进制）。构建期间你仍可照常聊天、切换会话或继续修改代码。
     - **现场与草稿原样恢复**：切换前自动保存 UI 与事件游标检查点，正在编辑的输入框草稿、上传的附图、当前打开的会话与布局在切换后原样恢复。
     - **安全时机等待与异常自动回退**：若当前有尚未结束的宿主内回合、活跃终端 PTY 或未保存编辑器内容，协调器会先完成后台构建并等待安全时机再切换，绝不强杀正在工作的进程；若新版本启动异常或健康检查超时，Supervisor 会自动回退至上一版本并恢复现场。
   - **自开发工程目录（`ccgui-custom [自开发]`）自动识别与一键「构建并热更新」**：本地 `git clone` 构建后首次启动自动识别并绑定自开发工程目录（侧栏显示紫色「自开发」标识与移除确认保护）；在「设置 → 工作区」或「设置 → 检查更新 → 运行中更新」提供一键 **「构建并热更新」** 按钮，无论 AI 改码还是手动 `git pull`，无需命令行即可后台增量构建并无感热切换。

7. **代理隧道与启动保护门闩（三态自适应）**
   - **严格代理隧道**：外网 Relay 中继连接严格通过应用配置的 HTTP CONNECT 代理隧道建立连接，代理未就绪时拒绝直连降级，防止流量意外泄露。
   - **自适应单实例与启动前校验**：Windows 正式版与自更新版本目录（`~/.ccgui-next/runtime-updates/releases/<hash>`）内置单实例互斥锁与可选的启动前代理/防火墙校验——全新安装默认关闭强制代理门禁（开箱即用），而已启用本地代理保护的老版本在热自更新时会自动识别并延续保护策略。

---

### 二、删除与停用的内容（Removed & Disabled）

1. **移除第三方统计与遥测代码**
   - 删除了原版中的百度统计模块（`src/lib/analytics.ts`、`src-tauri/src/baidu_tongji.rs`）及相关 IPC 命令。
   - 收紧打包应用的 CSP（Content Security Policy）策略，仅允许加载打包与本地资源，禁止远程脚本与外部图片信标（由 `tests/privacy-boundary.test.ts` 回归守护）；插件 HTTP 请求默认禁止自动跟随重定向。

2. **停用原版 GitHub Releases 在线自动更新**
   - 显式启用 `IS_CUSTOM_DISTRIBUTION = true` 并关闭 `createUpdaterArtifacts`，移除设置页向原版仓库拉取在线安装包更新的入口，防止上游通用安装包覆盖定制版；应用更新统一收敛至本地 `runtime-updates` 自更新通道。

3. **精简聊天底栏冗余代理入口**
   - 移除了聊天输入框底栏的快捷代理切换按钮（网络代理配置统一在「设置 → 网络代理」中集中管理）。

---

## 从 GitHub 安装与自开发热更新（`ccgui-custom`）

### 1. 首次从 GitHub 克隆与安装
环境要求：**Node.js 24 LTS**（已测试；最低 **22.13**）、固定版本 **pnpm 11.19.0**、**Git** 和 **Rust stable 1.95+**（已测试 1.99）。Windows 请按 [Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/) 安装 MSVC C++ 构建工具、Windows SDK 和 WebView2（**无需安装 Perl**）。其他平台需安装各自的 Tauri 系统依赖；以下 Windows 打包流程不代表 macOS/Linux 安装包已完成验证。

```bash
# 1. 克隆仓库到本地目录（建议命名为 ccgui-custom）
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. 安装固定版本包管理器与工作区依赖
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. 在同一干净检出中先验证，再构建 Windows 正式安装包
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

### 2. `ccgui-custom` 自开发工程目录会自动生成吗？后续需要手动构建吗？
**首次构建后会自动登记本地源码目录，后续无需手动敲命令，在 CC GUI 内即可随时无感自更新：**

1. **构建后首次启动自动识别**：执行 `pnpm maint:build` 或 `pnpm dev` 时，构建脚本会将当前仓库路径记录到用户应用数据目录的 `default-source-root.txt`（位于仓库外部的本机提示文件，切勿提交或随包分发）。同一系统账号下首次启动正式版时，会自动填充侧栏的 `ccgui-custom [自开发]` 工作区及「设置 → 工作区 → CC GUI 自开发工程目录」；若将安装包复制到其他机器使用，只需在设置中手动指定那台机器上的源码目录即可。
2. **让 AI 改码并自动热更新**：直接在 `ccgui-custom` 工作区新建会话让 AI 修改 CC GUI。AI 完成修改并验证通过后会自动登记「待更新」状态，你只需对 AI 说一句 **「更新」**，宿主就会在后台自动完成增量构建与热切换。
3. **手动 `git pull` 或改码后一键热更新**：当你从 GitHub 拉取最新代码（`git pull`）或自己修改了源码后，无需打开终端——直接点击 **「设置 → 工作区 → CC GUI 自开发工程目录」**（或 **「设置 → 检查更新 → 运行中更新」**）上的 **「构建并热更新」** 按钮即可触发后台增量构建与热切换。
4. **更新过程零打断，正常使用不受影响**：后台构建在隔离的源码快照上进行，几分钟的编译期间你可以继续在 CC GUI 中正常对话、发图或改代码；若当前正有活跃回合或终端任务，系统会自动等其安全结束后再执行秒级切换，正在运行的 `task-worker` 任务、会话现场以及输入框里写了一半的草稿都会无缝保留。

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

详细架构与维护规范参见：
- [定制维护说明](./docs/custom-maintenance.zh-CN.md)
- [运行中热更新说明](./docs/runtime-live-update.zh-CN.md)
- [内置助手提醒与独立旁白](./docs/assistant-notices.zh-CN.md)
- [界面与交互规范](./docs/ui-ux-spec.zh-CN.md)

---

## License

本项目遵循 [MIT License](./LICENSE) 开源协议，保留原作者 `Thomas Ricouard` 与 `zhukunpenglinyutong（朱昆鹏）` 的版权声明。
