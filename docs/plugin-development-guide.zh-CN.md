# CC GUI 插件开发与提交规范

> **版本**：v0.1（规范草案，随插件系统 Phase 1 落地生效）
> **适用对象**：社区插件开发者、AI 生成插件的使用者、市场审核人员
> **关联文档**：[插件化系统总体计划](../.omx/plans/plugin-system-plan.md)

本文档是向 CC GUI 插件市场提交插件的**唯一权威规范**。插件从开发、打包、发版到上架的全部要求都在这里。

---

## 目录

1. [插件是什么](#1-插件是什么)
2. [三层信任模型](#2-三层信任模型)
3. [快速开始](#3-快速开始)
4. [插件仓库结构规范](#4-插件仓库结构规范)
5. [manifest.json 字段规范](#5-manifestjson-字段规范)
6. [插件 SDK API 参考](#6-插件-sdk-api-参考)
7. [权限规范](#7-权限规范)
8. [声明式插件（Tier-0）规范](#8-声明式插件tier-0规范)
9. [构建与发版规范](#9-构建与发版规范)
10. [上架流程（提交到市场）](#10-上架流程提交到市场)
11. [审核标准与禁止事项](#11-审核标准与禁止事项)
12. [版本更新与兼容性策略](#12-版本更新与兼容性策略)
13. [用户数据与安全规范](#13-用户数据与安全规范)
14. [FAQ](#14-faq)

---

## 1. 插件是什么

CC GUI 插件是一个**托管在 GitHub 上的独立仓库**，通过 GitHub Releases 分发，用户可以一键安装、升级、卸载。插件可以：

- 修改界面样式（主题、输入框样式、布局微调）
- 新增设置页、侧边栏面板、状态栏组件、命令面板命令
- 注册 Markdown 渲染组件、Composer 插槽内容
- 读取宿主提供的只读事件（如用量统计 `usage://updated`）
- 在自己的 KV 命名空间里持久化数据

插件**不能**：

- 直接调用 Tauri IPC（`window.__TAURI__` 在插件加载前已被移除）
- 访问文件系统、终端、其他插件的数据
- 未经 `network` 权限声明就发起网络请求
- 新增 AI 引擎或 Rust 命令（编译期固化，不在插件能力面内）

## 2. 三层信任模型

| 层级 | 形态 | 能力 | 上架要求 |
|---|---|---|---|
| **Tier-0 声明式** | 纯 JSON + CSS，**零 JavaScript** | 主题/样式、菜单行、设置项、状态栏文本 | 审核从简（无代码可审） |
| **Tier-1 JS（市场）** | 单文件 ESM bundle + manifest | 完整 SDK 扩展点 API | PR 人工审核；可选 minisign 签名获「已验证」徽章 |
| **Tier-2 JS（个人/AI 生成）** | 同 Tier-1，未签名 | 同 Tier-1 | **不上架**，仅本地安装；安装者核对可信代码与权限清单，当前目录安装器没有独立的权限确认弹窗 |

> 建议：只做样式/主题/菜单的插件**优先做成 Tier-0**——审核最快、用户信任成本最低、AI 也能可靠生成。

## 3. 快速开始

```bash
# 1. 从官方模板创建仓库（GitHub → Use this template）
#    https://github.com/<org>/ccgui-plugin-template

# 2. 克隆并安装
git clone https://github.com/<you>/ccgui-plugin-hello.git
cd ccgui-plugin-hello && pnpm install

# 3. 开发（产物三件套输出到 dist/）
pnpm dev        # 监听构建
pnpm build      # 产出 main.js + manifest.json + styles.css
pnpm validate   # 本地校验 manifest 与产物

# 4. 本地调试：CC GUI → 设置 → 插件 → 从本地目录安装（指向 dist/）

# 5. 发版：打一个与 manifest.json version 一致的 tag
git tag 1.0.0 && git push origin 1.0.0
#    GitHub Action 自动构建并将三件套附加到 Release

# 6. 上架：向索引仓库提 PR（见 §10）
```

> **只想自己用、不想先建仓库？** 插件中心页头「创建插件」会用内置 skill 在一次会话里生成可直接安装的插件目录（`manifest.json` + `main.js`；Tier-0 只需 `manifest.json` + `styles.css`），不依赖模板仓库和构建工具；回到插件中心「从本地目录安装」选该目录即可，改完重新安装会热重载。要上架时再按下文流程把目录整理成仓库。

### 宿主 MCP 维护

用户授权代理安装或维护插件时，支持该能力的 `ccgui` 宿主提供以下正式入口；旧宿主不公开这些工具。

| 工具 | 参数 | 返回证据 |
|---|---|---|
| `list_plugins` | `{}` | 安装记录及主窗口运行状态 |
| `get_plugin_status` | `id`，可选 `sourcePath` | 已安装版本、实际加载版本、候选包与新增权限；查询不激活插件 |
| `install_plugin` | `path`、`expectedId`、`expectedVersion` | 原生提交结果与主窗口新代码激活结果分别报告 |
| `reload_plugin` | `id`、`expectedVersion` | 重载已安装版本，保留启用状态；仅已启用插件重试隔离失败 |

目录必须是绝对本地路径，安装前后核对候选身份；同 ID 覆盖沿用原安装时间和启用状态。维护先通过目标插件的 `registerUpdateCloseHandler` 保存状态，并通过正常归位协议关闭其浮窗；目标存在不支持保存的活动视图时拒绝维护，其他插件不受影响。保存超时或失败不执行安装；原生操作开始后不因等待超时而重放。安装器串行复制，重新校验暂存包；目录交换和状态变更与其他生命周期操作互斥，状态写入失败恢复旧目录。目录与状态文件并非跨文件的崩溃原子事务。

`committed: true` 不代表插件可用；仅 `activation: "active"` 且 `runtime.loadedVersion` 等于目标版本证明主窗口已加载。禁用插件返回 `disabled`，激活失败保留具体错误。结果未知时重新查询原 ID，不自动重复提交。MCP 不提供直接覆盖运行目录或编辑配置的替代通道。

## 4. 插件仓库结构规范

### 4.1 必须满足的仓库布局

```
ccgui-plugin-hello/
├── manifest.json          # 【必须】仓库根目录，见 §5
├── src/
│   └── index.ts           # JS 插件入口（Tier-0 可没有 src/）
├── styles.css             # 【可选】样式源文件
├── README.md              # 【必须】市场详情页直接渲染它
├── LICENSE                # 【必须】开源许可证
├── .github/workflows/release.yml   # 模板自带，勿删改核心步骤
└── dist/                  # 构建产物（.gitignore，不入库）
    ├── main.js
    ├── manifest.json
    └── styles.css
```

### 4.2 硬性要求

1. **`manifest.json` 必须在默认分支的根目录**——市场按「默认分支根目录 manifest 的 version」查找同 tag 的 Release（与 Obsidian 相同约定）。
2. **Release 附件文件名固定**：`main.js`、`manifest.json`、`styles.css`（Tier-0 允许只有后两个）。改名 = 无法安装。
3. **Release tag 必须等于 manifest.json 的 `version`**（如 tag `1.2.0` ↔ `"version": "1.2.0"`），不带 `v` 前缀。
4. **单文件 ESM bundle**：所有第三方依赖在构建期打进 `main.js`；运行时**禁止** `import` 任何外部模块（宿主提供的基座除外，构建模板已将 `react`/`react-dom`/`@ccgui/plugin-sdk` 标记为 external）。
5. **体积**：bundle ≤ 512KB（CI 警告阈值），硬上限 2MB（gzip 前）。超出硬上限 CI 直接拒绝。

## 5. manifest.json 字段规范

完整示例：

```jsonc
{
  // ── 必填 ──────────────────────────────
  "id": "usage-stats",              // 全局唯一，小写字母/数字/连字符，^([a-z0-9]+-)*[a-z0-9]+$，
                                    // 禁止与已有插件重名、禁止以 "ccgui-" 开头（官方保留）
  "name": "用量统计",                // 显示名，≤ 30 字符
  "version": "1.2.0",               // semver，必须与 Release tag 一致
  "minAppVersion": "1.1.0",         // 最低宿主版本，低于此版本的 App 不加载本插件
  "author": "zhangsan",             // GitHub 用户名或组织名
  "description": "统计各引擎 token 用量与花费",  // ≤ 120 字符
  "repo": "zhangsan/ccgui-plugin-usage-stats",  // owner/repo 形式
  "tier": "js",                     // "declarative" | "js"
  "license": "MIT",

  // ── 可选 ──────────────────────────────
  "permissions": [                  // 缺省 = 无权限，见 §7
    "storage",
    "ui:settings-section",
    "events:usage"
  ],
  "contributes": {                  // 声明式贡献点（Tier-0 全靠它；JS 插件也可静态声明）
    "settingsSections": [{ "key": "usage", "titleKey": "usage.title", "icon": "chart" }],
    "panelTabs":        [{ "id": "usage", "titleKey": "usage.tab", "icon": "chart" }],
    "statusBarItems":   [{ "id": "usage", "alignment": "right" }],
    "commands":         [{ "id": "usage.open", "titleKey": "usage.cmd.open" }],
    "themes":           [{ "id": "midnight", "name": "Midnight", "dark": true, "css": "themes/midnight.css" }],
    "i18n":             [{ "lang": "zh-CN", "ns": "usage", "file": "i18n/zh-CN.json" }]
  },
  "configSchema": {                 // JSON Schema（draft 2020-12），市场自动生成设置表单
    "configVersion": 2,             // 配置结构版本，破坏性变更时 +1，见 §12.3
    "type": "object",
    "properties": {
      "currency":  { "type": "string", "enum": ["CNY", "USD"], "default": "CNY", "title": "货币" },
      "apiToken":  { "type": "string", "title": "API Token", "ccgui:role": "secret" }
      //                                                              ^ secret 字段仅写入不回显
    }
  },
  "icon": "docs/icon.png",                  // 可选：市场方形图标，见 §5.1
  "screenshots": ["docs/screenshot-1.png"], // 可选：≤ 5 张，市场详情页展示，见 §5.1；数组顺序 = 展示顺序
  "keywords": ["usage", "token"]               // ≤ 8 个，市场搜索
}
```

**字段校验规则**（索引仓 CI 强制执行）：

| 规则 | 说明 |
|---|---|
| `id` 稳定性 | 一旦上架**永不更改**；更新、卸载、用户数据都按 id 寻址 |
| `version` 单调 | 新版本 semver 必须严格大于索引中已登记版本 |
| `minAppVersion` 真实 | CI 会检查插件用到的 SDK API 在该宿主版本是否已存在 |
| `permissions` 最小化 | CI 对比代码实际行为与声明，多余声明会在 PR 中评论要求删减 |
| `description` 诚实 | 功能描述与实际行为不符 = 拒审 |

### 5.1 市场展示素材（icon / screenshots，均可选）

两个字段是可选的展示素材，**不填也能上架**：

- 缺 `icon`：市场列表/详情页用插件名首字母的确定性渐变瓷砖（同一 id 每台机器配色一致），面板页签回退同理。
- 缺 `screenshots`：详情页不渲染图集，README 直接顶到标题下方。

**图片放哪里**：放在插件仓库里，用相对路径引用；推荐统一放 `docs/`，README 也能直接贴同一张图。也接受绝对 `https://` URL，但仓库内相对路径更稳（不依赖第三方图床）。

```jsonc
// manifest.json
"icon": "docs/icon.png",
"screenshots": [
  "docs/screenshot-1.png",   // 第一张是详情页首屏（hero），放最能说明功能的一张
  "docs/screenshot-2.png"
]
```

**素材要求**：

| 项 | 规则 |
|---|---|
| `icon` | 正方形；PNG / SVG / WebP / JPG；建议 ≥ 128×128（256 更稳）；不要带白边/透明大边距 |
| `screenshots` | ≤ 5 张，数组顺序即展示顺序；PNG / JPG / WebP / GIF / SVG；建议宽度 ≥ 1200，界面截图用 16:9～16:10 |
| 路径 | 相对仓库根、不逃逸（`..`/绝对路径/反斜杠被拒绝）；单条 ≤ 1024 字符 |

**图片在默认分支（HEAD）上按路径读取，不锁 Release tag**：改进或替换同名文件后，用户刷新市场/详情页即可看到新图，无需发版。因此路径要稳定，不要用带哈希的构建产物名。

**`icon` 同时是宿主侧的面板页签回退图**：聊天右侧面板的插件页签在插件没注册 `icon` 时用这张图（宿主 `plugin_read_artwork` 读本地文件）。市场安装只落地 Release 附件（三件套，见 §10.2），不会带 `docs/` 目录，所以宿主在安装/更新时会按 manifest 声明的**相对路径**把索引里的这张图写进插件目录——**发布包里不需要内含图片文件**；用绝对 https URL 则不落地、直接联网加载。想让页签回退显示品牌图，manifest 要声明相对路径的 `icon`。

**如何进入市场**：manifest 是唯一事实源，索引仓机器人登记新版本时会把 `icon` / `screenshots` 镜像进 `plugins/<id>.json`（App 实际读的是索引）。只改进素材、不改版本的场景可以直接向索引仓提一个只改这两个字段的 PR。

## 6. 插件 SDK API 参考

### 6.1 入口约定

`main.js` 的默认导出是唯一入口：

```ts
import type { PluginContext } from '@ccgui/plugin-sdk';

export default function activate(ctx: PluginContext): void | (() => void) {
  // 注册你的贡献。所有 ctx.*.register* 返回 Disposer，
  // 运行时自动记录，卸载时逆序调用——你不需要手动管理。
  ctx.ui.registerSettingsSection({ key: 'hello', titleKey: 'hello.title', component: HelloSection });

  // 也可返回一个总清理函数（可选），在所有注册项 dispose 之后调用
  return () => { /* 停定时器、取消订阅等 */ };
}
```

**生命周期纪律**：

- `activate` 必须是同步返回（异步初始化放函数体内 fire-and-forget，或经 `ctx.events` 等待）。
- 所有副作用必须有对应的 disposer——泄漏副作用（卸载后 UI 残留、定时器存活）是拒审理由。
- 插件抛错不会拖垮宿主：每个插件 UI 挂载点有 ErrorBoundary 隔离；崩溃次数达阈值插件被自动隔离（quarantine），用户可在插件页手动恢复。

### 6.2 PluginContext

```ts
interface PluginContext {
  readonly pluginId: string;
  readonly version: string;

  ui: {
    registerSettingsSection(d: SettingsSectionDef): Disposer;   // 设置页新 section
    registerPanelTab(d: PanelTabDef): Disposer;                 // 右侧面板新 tab（页签条只渲染 icon，label 作 title / 可访问名）
    registerComposerSlot(slot: 'addMenu' | 'cliMenu' | 'permissionMenu', d: SlotDef): Disposer;
    registerStatusBarItem(d: StatusBarItemDef): Disposer;
    registerCommand(d: CommandDef): Disposer;                   // 命令面板（⌘K）
    registerSessionMenuItem(d: SessionMenuItemDef): Disposer;   // 侧栏会话右键菜单追加行
    openSettings(key?): void;                                   // 跳转到本插件设置页（0.3.6 起）
    registerMarkdownRenderer(d: MarkdownRendererDef): Disposer; // 自定义消息渲染组件
    registerPage(d: PageDef): Disposer;                         // 整页路由
  };

  theme: {
    injectCss(css: string): Disposer;          // 注入 <style data-plugin="你的id">
    setTokens(tokens: Record<string, string>): Disposer;  // 覆盖 BoardUI 语义 token
  };

  i18n: {
    addBundle(lang: string, ns: string, resources: object): Disposer;
  };

  storage: {                                   // 每插件隔离 KV（sqlite）
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;   // value 须可 JSON 序列化，单键 ≤ 256KB
  };

  events: {
    on(topic: string, cb: (data: unknown) => void): Disposer;
    emit(topic: string, data: unknown): void;  // 仅能以 "plugin:<你的id>:" 前缀发事件
  };

  host: { readonly appVersion: string; readonly locale: string; readonly theme: 'light' | 'dark' };
}
```

### 6.3 宿主事件（只读数据源）

| 事件 topic | 载荷 | 所需权限 |
|---|---|---|
| `usage://updated` | 完整 EngineEventPayload `{ runId, sessionId, engine, seq, kind: "usage", data, ts?, genMs? }`；`data` 为引擎原始 usage JSON（字段因引擎而异，如 claude 的 `cache_read_input_tokens`、codex 的 `cached_input_tokens`、pi/omp 的 `cacheRead`）；`ts` 为宿主发射时刻 Unix 毫秒（SDK 0.3.8 起）；`genMs` 为宿主实测的生成窗口毫秒（SDK 0.3.15 起，仅 `usage`/`done` 事件携带，工具执行与等待不计入）；Claude 原生运行里每次响应结束（引擎 `turn_complete`，`data.usage`）的用量也经此话题以 `kind: "usage"` 发送（宿主合成，沿用该事件的 `ts`/`genMs`），此时运行可能仍有后台任务或自动续答在进行，不代表整个运行已结束；宿主 UI 只打断当前回复（CC GUI 里后台任务运行期间的 Stop，`turn_complete.data.interrupted: true`，进程与后台任务继续存活）所结束的响应也照常发送其用量，但真实 CLI 对被打断的响应不计用量，该更新的各 token 字段可能全为 0（`usage` 为 null 时不发更新）；该话题的 `data` 只是用量、不带 `interrupted`，同样不是运行终态 | `events` |
| `usage://done`（SDK 0.3.8 起） | 同上形状，`kind: "done"`；`data.usage` 携带该轮最终用量——grok 等不发独立 usage 事件的引擎只经此上报，其它引擎用作轮结束信号；Claude 原生运行（含后台任务 / 自动续答）的各次响应用量已在 `usage://updated` 上报，终态 `done` 的 `data.usage` 可为 `null`，请勿重复累计，只有既不发会话状态事件、响应结束时也没有后台任务的旧版 Claude CLI 仍只经此上报（有后台任务的旧版 CLI 首次响应用量经 `usage://updated`，终态 `done` 另带自己的用量，累计时两者相加）；`done` 才是整个运行（含后台任务与自动续答）的终态；`genMs` 为该轮生成窗口合计 | `events` |
| `session://activated`（SDK 0.3.8 起） | `{ engine, sessionId }`；pending 标签 `sessionId` 为 null，无活动标签两者皆 null | `events` |
| `composer://draft` | `{ text }`；草稿变化/清空/会话切换均发射 | `events` |

> 想消费这里没有的宿主数据？到索引仓开 issue 提议新事件，不要试图绕过 SDK 抓 DOM/store——那是拒审理由。

### 6.4 UI 组件纪律

- 用宿主提供的 React 实例（构建模板已配置 external）；**禁止**自带 React 副本。
- 样式优先用 BoardUI 语义 token（`bg-background-*`、`text-text-*` 等），**禁止**写死 hex 颜色——深色模式靠 token 自动翻转。
- 插件 UI 文本必须走 `ctx.i18n` 注册的资源，至少提供 `en` 与 `zh-CN`。

## 7. 权限规范

SDK 0.3.19 的 `ctx.workspaces.publishProject(sourceKey, definition)` 使用既有
`host:workspace` 权限发布项目视图。`sourceKey` 应复用插件自己的稳定项目 UUID；
重复发布更新同一个宿主投影，不另建记忆、不改会话 cwd。`definition` 包含
`name`、精确匹配某成员的 `defaultPath` 和 `members: [{ id, path, label, role }]`，
`role` 为 `development` 或 `reference`，仅表示用途。成员须位于已登记本机工作区
范围内，最多 32 个，允许祖先与子目录成员；不会因此登记新工作区、扩大读写授权、
加载其他引擎规则或增加 `--add-dir`。远程/WSL 成员暂不纳入此接口。
宿主保留发布插件和来源键，禁止其他插件覆盖；插件卸载不自动删除投影，用户可以
在项目设置中移除关系，源项目数据不受影响。来源项目的成员配置由插件维护，避免
双份清单独立编辑。宿主投影 ID 由调用返回，与源项目 ID 分开使用。

| 权限 | 能力 | 审核强度 |
|---|---|---|
| `storage` | 使用 `ctx.storage` KV | 低 |
| `ui:*`（`ui:settings-section`、`ui:panel-tab`、`ui:composer-slot`、`ui:status-bar`、`ui:page`、`ui:command`、`ui:markdown`、`ui:session-menu`） | 对应 UI 扩展点 | 低 |
| `theme` | 注入 CSS / 覆盖 token | 低（Tier-0 隐含拥有） |
| `i18n` | 注册语言资源 | 低 |
| `events` | 订阅宿主事件（usage://updated、usage://done、session://activated、composer://draft） | 中（涉及用户行为数据，需在 description 说明用途） |
| `network` + `networkDomains: ["api.example.com"]` | `fetch` 访问**声明的域名**（白名单，逐个审核） | 高（必须说明每个域名的用途；通配域名一律拒审） |

**规则**：

1. 未声明的权限调用 = 运行时被门面拒绝并记录；市场上架后新增权限必须在 PR diff 中显著提示用户。
2. `network` 请求由宿主代理发出并校验域名白名单；插件永远拿不到原始 `fetch`。
3. 申请用不到的权限会被 CI 标记，审核员会要求删减。

## 8. 声明式插件（Tier-0）规范

Tier-0 插件 = `manifest.json` + CSS/i18n 资源，**不含任何 JS**。宿主解释 `contributes` 执行。

```jsonc
// manifest.json —— 一个主题插件的完整示例
{
  "id": "theme-midnight",
  "name": "Midnight 主题",
  "version": "1.0.0",
  "minAppVersion": "1.1.0",
  "author": "you", "description": "深蓝午夜主题", "repo": "you/ccgui-plugin-midnight",
  "tier": "declarative",
  "license": "MIT",
  "contributes": {
    "themes": [{ "id": "midnight", "name": "Midnight", "dark": true, "css": "styles.css" }]
  }
}
```

```css
/* styles.css —— 只允许覆盖语义 token 与安全属性 */
.dark {
  --background-primary-default: #0d1117;
  --text-primary: #e6edf3;
}
```

**CSS 约束**（CI 静态解析强制）：

- 禁止 `@import`；禁止 `url()` 引用远程资源（`data:` 内联允许，单文件 ≤ 100KB）。
- 禁止 `position: fixed` 全屏遮罩、禁止 `z-index` > 1000、禁止 `!important`（token 覆盖除外）。
- 禁止隐藏/遮挡宿主核心 UI 的选择器（审核员人工判断，如 `display: none` 作用于发送按钮）。

## 9. 构建与发版规范

### 9.1 构建（模板已配置好，无需手改）

- Vite lib mode 输出单文件 ESM；`react`、`react-dom/jsx-runtime`、`@ccgui/plugin-sdk` 标记 external（运行时由宿主基座注入）。
- `pnpm validate` 本地跑与市场 CI 相同的检查：manifest schema、bundle 体积、权限-代码比对、CSS 静态解析、黑名单扫描（`eval` / `new Function` / `__TAURI__` / `localStorage` / 远程 `import(`）。

### 9.2 发版

1. `manifest.json` 的 `version` +1（semver，见 §12）。
2. `git tag <version> && git push origin <version>`（tag = version，无 `v` 前缀）。
3. 模板自带 GitHub Action 构建三件套并附加到该 tag 的 Release。
4. **已进市场的插件**：另需向索引仓提「版本登记 PR」（见 §10.3），否则用户收不到更新。

### 9.3 可选：minisign 签名（「已验证」徽章）

```bash
minisign -Sm dist/main.js -p your-plugin.pub   # main.js.minisig 一并传到 Release
```

将公钥登记在索引仓的 `plugins/<id>.json`。签名非强制，但带徽章的插件在市场上标识为「已验证」，且**权限升级时用户无需重新确认**。

## 10. 上架流程（提交到市场）

市场 = 中央索引仓库 `ccgui-plugins`（纯 GitHub，无自建服务器）。

### 10.1 首次上架

1. Fork 索引仓库。
2. 在 `community-plugins.json` 追加一条（保持按 id 字典序）：

```json
{ "id": "usage-stats", "repo": "zhangsan/ccgui-plugin-usage-stats", "name": "用量统计", "description": "统计各引擎 token 用量与花费", "author": "zhangsan" }
```

3. 新增 `plugins/usage-stats.json`（`icon` / `screenshots` 由 manifest 镜像而来，机器人登记新版本时自动写入；首次上架照抄 manifest 的值即可，都不填就省略）：

```json
{
  "id": "usage-stats",
  "repo": "zhangsan/ccgui-plugin-usage-stats",
  "tier": "js",
  "version": "1.0.0",
  "minAppVersion": "1.0.2",
  "sdkVersion": "^0.3",
  "permissions": ["storage", "ui:settings-section"],
  "sha256": {
    "main.js": "<64 位小写 hex>",
    "manifest.json": "<64 位小写 hex>",
    "styles.css": "<64 位小写 hex>"
  },
  "icon": "docs/icon.png",
  "screenshots": ["docs/screenshot-1.png"]
}
```

4. 提 PR。CI 自动执行：
   - 仓库结构检查（根 manifest、LICENSE、README、release.yml）
   - manifest schema 校验 + `id` 唯一性 + `version` ↔ 最新 Release tag 一致性
   - 下载 Release 产物：SHA256 登记、bundle 体积、黑名单扫描、权限-代码比对
   - 生成**审核报告**评论在 PR 里（权限清单、网络域名、体积、扫描结果）
5. 人工审核（通常 3 个工作日内）：按 §11 标准过一遍，通过后合并即上架。

### 10.2 上架后用户侧流程（你无需关心，供理解）

App 市场页 → Rust 拉索引 → 用户点安装 → 从 Release 下载三件套 → 校验 SHA256 → 按 manifest 的 `icon` 从默认分支补落品牌图（失败只跳过）→ staging 目录 → 健康检查（冷加载 activate 一次）→ 原子替换生效。任一步失败，已装版本不受影响。

### 10.3 版本更新

1. 按 §9.2 在你的仓库发新 Release。
2. 向索引仓提「版本登记 PR」（只改 `plugins/<id>.json` 无代码变更时，机器人可自动合并）。
3. 权限有新增 → 转人工审核，且老用户升级时会看到权限 diff 确认。
4. App 端每 24h 比对索引版本，向用户提示可更新。

> 「版本登记 PR」里的 `updatedAt` 取该 Release 的发布时间（RFC 3339 UTC，如 `2026-09-20T08:30:00Z`）；机器人开 PR 时自动写入，CI 只校验格式。App 详情页用它显示「最近更新时间」，值缺失只是不显示这一行。
>
> 同一 PR 还会带上 manifest 里的 `icon` / `screenshots`（见 §5.1）：改了素材路径就随下一次发版自动进索引；只换图内容（路径不变）则连发版都不需要。

### 10.4 下架

- 作者主动下架：PR 删除索引条目（用户已装副本不受影响）。
- 违规下架：维护者可标记 `plugins/<id>.json` 为 `"delisted": true`，市场隐藏且已装用户收到安全提示。

## 11. 审核标准与禁止事项

### 11.1 一律拒审的行为

| 禁止事项 | 原因 |
|---|---|
| `eval`、`new Function`、远程 `import()`、`<script>` 注入 | 远程代码执行面 |
| 访问 `window.__TAURI__` / `__TAURI_INTERNALS__` / 宿主内部 store | 绕过权限模型 |
| 读写 `localStorage` | 跨插件污染，须用 `ctx.storage` |
| 混淆/压缩到不可读的代码（合理 minify 除外，需附 sourcemap 或源码对应关系） | 可审核性 |
| 收集用户对话内容、API key、文件路径并外发 | 隐私红线，永久拉黑作者 |
| 未声明的 `network` 行为、域名白名单外的请求 | 权限模型 |
| `description` 与实际功能不符、伪装成官方插件 | 信任 |

### 11.2 审核员 checklist（公开版）

1. manifest 与实际行为一致（功能、权限、域名）。
2. 全部副作用有 disposer，卸载后 UI/DOM/事件无残留。
3. UI 用 BoardUI token，深浅色模式均可用；i18n 至少 en + zh-CN。
4. 崩溃不拖垮宿主（ErrorBoundary 内渲染，无全局异常吞噬）。
5. README 说清楚：干什么、要什么权限、数据去哪。
6. 无 §11.1 禁止事项。

### 11.3 质量标准（不强制但影响推荐位）

- bundle 小、激活快（activate < 50ms）、无控制台噪音。
- 提供截图、关键词准确、configSchema 有合理的默认值与 `title`（市场自动生成表单直接可读）。

## 12. 版本更新与兼容性策略

### 12.1 semver 纪律

- **patch**：bug 修复，不变 SDK 用法。
- **minor**：新增能力/权限（权限 diff 会提示用户）。
- **major**：破坏性变更（配置结构、贡献点 id 变更）。

### 12.2 宿主兼容性

- `minAppVersion` 决定哪些 App 版本能装。宿主 SDK 按 semver 演进，废弃 API 至少保留一个大版本并提前在索引仓公告。
- 宿主升级后若插件 `minAppVersion` 不再满足，插件被**自动禁用**并在市场页提示「等待插件更新」——用户数据保留。

### 12.3 配置迁移（`configVersion`）

`configSchema` 破坏性变更时 `configVersion` +1。宿主升级插件后：已知键保留、被删键丢弃、新键补默认值。需要自定义迁移的，在 `activate` 里读旧值自行处理后再写回。

### 12.4 用户数据

- 用户卸载插件时可选择「保留数据」（默认保留 30 天后自动清理）或「立即删除」。插件**不得**在卸载路径上做阻止、隐藏数据等对抗行为。

## 13. 用户数据与安全规范

1. **最小采集**：只拿实现功能必需的数据；`events:usage`/`events:session` 数据**禁止外发**，只能本地展示/聚合。
2. **secret 字段**（`ccgui:role: "secret"`）仅写入不回显，存于每插件隔离 KV；禁止把 secret 打到日志。
3. **网络请求**：仅限声明域名；禁止把用户对话内容、文件路径、API key 作为请求参数发出。
4. **依赖供应链**：构建期依赖锁定（lockfile 入库）；Release 产物必须由模板 Action 从源码构建——**禁止手工上传本地构建的产物**（CI 会比对）。
5. 发现安全漏洞：向索引仓 Security Advisory 私密报告，48h 内响应；确认后下架受影响版本。

## 14. FAQ

**Q：我的插件需要一个 SDK 没有的能力（新事件、新扩展点）？**
A：到索引仓开 issue 描述场景。宿主每版本评估扩展 SDK；SDK 走 semver，废弃 API 提前一个大版本公告。

**Q：插件能用 npm 依赖吗？**
A：能，但全部在构建期打进单文件 bundle（注意 2MB 硬上限）。运行时禁止加载任何外部模块。

**Q：为什么插件不能直接用 `fetch`？**
A：CSP 与信任模型要求所有网络 IO 走宿主代理并校验域名白名单。声明 `network` + `networkDomains` 即可获得受控 `fetch`。

**Q：AI 生成的插件能上架吗？**
A：可以，与人工插件同标准审核；上架前请在 PR 里注明「含 AI 生成代码」。未上架的 AI 生成插件按 Tier-2 个人插件在本地使用（生成时会向你展示代码 diff 与权限清单，确认后生效）。

**Q：插件之间能互相依赖/通信吗？**
A：没有插件间依赖机制（刻意决策，避免依赖地狱）。事件总线允许 `plugin:<id>:` 前缀的事件，跨插件协作属高级用法，文档不承诺兼容。

**Q：我的插件违规被下架了，申诉渠道？**
A：索引仓开 issue 并 @maintainers，说明整改内容；隐私红线类违规不接受申诉。

---

*本规范随插件系统版本演进，变更历史见索引仓库 `SPEC-CHANGELOG.md`。*
