<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui 图标" src="./public/app-icon.png" />

[English](./README.md) · **简体中文**

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

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
   - 普通本地 Claude / Codex 会话运行在独立于 GUI 宿主的 `task-worker` 进程中，具备耐久事件日志（`events.jsonl`）与幂等命令回执，GUI 重启不中断正在运行的任务。
   - 内置 `ccgui-self-update` 协调器与 `self-update-build.mjs`：支持源码快照隔离构建、前端资源外置独立打包、UI/游标检查点保存、Supervisor 宿主热切换，以及新候选健康检查超时自动回退上一版本。
   - **自开发工程目录（`ccgui-custom [自开发]`）自动生成与一键「构建并热更新」**：本地 `git clone` 构建后首次启动自动识别并绑定自开发工程目录（侧栏显示紫色「自开发」标识与移除确认保护）；在「设置 → 工作区」或「设置 → 检查更新 → 运行中更新」提供一键 **「构建并热更新」** 按钮，无论 AI 改码还是手动 `git pull`，无需命令行即可后台增量构建并无感热切换。

7. **代理隧道与启动保护门闩（三态自适应）**
   - 外网 Relay 中继连接支持通过应用配置的 HTTP CONNECT 代理隧道建立连接，代理未就绪时拒绝直连泄露。
   - Windows 正式版与自更新版本目录（`~/.ccgui-next/runtime-updates/releases/<hash>`）内置单实例互斥锁与可选的启动前代理/防火墙校验：全新安装默认关闭强制代理门禁（安装即用），老版本热自更新且已启用本地代理时自动识别并固化保护。

---

### 二、删除与停用的内容（Removed & Disabled）

1. **移除第三方统计与遥测代码**
   - 删除了原版中的百度统计模块（`src/lib/analytics.ts`、`src-tauri/src/baidu_tongji.rs`）及相关 IPC 命令。
   - 收紧打包应用的 CSP（Content Security Policy）策略，仅允许加载打包与本地资源，禁止远程脚本与外部图片信标（由 `tests/privacy-boundary.test.ts` 回归守护）；插件 HTTP 请求默认禁止自动跟随重定向。

2. **停用原版 GitHub Releases 在线自动更新**
   - 显式启用 `IS_CUSTOM_DISTRIBUTION = true` 并关闭 `createUpdaterArtifacts`，移除设置页向原版仓库拉取在线安装包更新的入口，防止上游通用安装包覆盖定制版；应用更新统一收敛至本地 `runtime-updates` 自更新通道。

3. **退役外部 Spellcast 工作台与旧桥接插件**
   - 移除了早期实验性的外部 Spellcast 工作台界面、连接配置与旧 IPC/Web 路由；自动停用并禁止重新安装旧 `spellcast-canvas-bridge` 插件，相关完成提醒与旁白能力全部由 CCGUI 原生模块接管。

4. **清理冗余入口与旧工具别名**
   - 移除了聊天输入框底栏的快捷代理切换按钮（统一在「设置 → 网络代理」中管理）。
   - 移除了旧版 `leader_*` 公共 MCP 工具别名，统一为 `task_*` 工具集。

---

## 从 GitHub 安装与自开发热更新（`ccgui-custom`）

### 1. 首次从 GitHub 克隆与安装
环境要求：**Node.js 24 LTS**（已测试；最低 **22.13**）、固定版本 **pnpm 11.19.0**、**Git** 和 **Rust stable 1.95+**（已测试 1.99）。Windows 按 [Tauri 官方环境要求](https://v2.tauri.app/start/prerequisites/) 安装 MSVC C++ 构建工具、Windows SDK 和 WebView2，**不需要 Perl**。其他平台仍需各自的 Tauri 系统依赖；下面的 Windows 流程不代表 macOS/Linux 安装包已验证。

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

检查与打包之间须保持源码干净且处于同一提交。检查失败时修复原因后重新运行；`maint:build` 必须有对应的成功检查记录。正式安装版已内嵌前端，无需运行开发服务器。打包会检查本机路径提示文件及可执行文件中的构建路径；对外分享安装包，不要直接上传本地报告、日志或用户数据目录。

Windows 发布路径脱敏已覆盖空格与中文。源码、用户目录和 Cargo 缓存路径不能包含 `=`：MSVC 对此只会裁剪部分路径，因此打包会在编译前拒绝该情况。

需要开发调试时，可在安装依赖后单独运行：

```bash
pnpm dev
```

构建和打开应用无需安装可选 AI CLI；使用某个引擎时再配置。构建工具继承用户进程环境与 Git 代理设置，不要求本地代理或固定端点，也不读取 Claude 配置。`maint:integrate`、`maint:install` 是维护者的旧式工作流，不是普通 GitHub 用户的安装前置步骤；上述 NSIS 安装不需要私有备份远程或保护启动器。

### 2. `ccgui-custom` 自开发工程目录会自动生成吗？后续需要手动构建吗？
**本地源码目录可自动登记，之后可在 CC GUI 内发起更新：**

1. **构建后自动识别生成**：执行 `pnpm maint:build` 或 `pnpm dev` 时，脚本将本地源码路径写入用户应用数据目录中的 `default-source-root.txt`。它是仓库外的本机路径提示，同一系统账号下首次启动可自动填充侧栏和「设置 → 工作区 → CC GUI 自开发工程目录」。不要提交或分发这个文件。安装包复制到另一台机器后不会自动知道源码位置，应在设置中选择那台机器上的检出目录。
2. **让 AI 自动改码并热更新**：在该工作区新建会话，直接让 AI 修改 CC GUI 功能。AI 验证通过后会自动登记「待更新」，你只需对 AI 说一句 **「更新」**，宿主就会自动在后台增量构建并热切换。
3. **手动 `git pull` 或自己改代码后一键构建**：如果你从 GitHub 拉取了最新代码（`git pull`）或手动修改了源码，无需打开终端敲命令——直接点击 **「设置 → 工作区 → CC GUI 自开发工程目录」**（或 **「设置 → 检查更新 → 运行中更新」**）卡片上的 **「构建并热更新」** 按钮，CC GUI 会自动基于该源码目录后台增量构建并完成无感热切换（纯前端改动秒级复用原生二进制）。

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
