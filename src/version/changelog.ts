/**
 * Release notes shown in the release-notes center tab (ReleaseNotesPane).
 * Newest first; add an entry at release time. Content is bilingual —
 * the tab shows both when available, ordered by the active UI language.
 */

/** Repo the release-notes tab links to for the Star banner / about page. */
export const GITHUB_REPO_URL = "https://github.com/zhukunpenglinyutong/desktop-cc-gui";

export interface ChangelogEntry {
  version: string;
  date: string;
  content: {
    en: string;
    zh: string;
  };
}

/** 版本号比较：两边都去掉可选前缀 v，忽略大小写。 */
export function sameVersion(a: string, b: string): boolean {
  return a.trim().replace(/^v/i, "").toLowerCase() === b.trim().replace(/^v/i, "").toLowerCase();
}

/** 本地版本记录里与 `version` 同名的条目；没有就是没有——不回落相邻版本，
 *  否则会把 v1.0.7 的说明挂在 v1.0.8 的标题下。 */
export function changelogEntryFor(version: string): ChangelogEntry | undefined {
  return CHANGELOG_DATA.find((entry) => sameVersion(entry.version, version));
}

export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    version: "1.1.1+protected.35",
    date: "2026-10-21",
    content: {
      zh: `源码同步（2026-10-26）
- 通用插件 SDK 更新至 0.3.28：项目视图、独立窗口、原生任务与讨论会话、图片附件、固定指令、受限记忆提炼及更新前服务关闭协议。
- 改善跨工作区任务与会话归属、通信队列、上下文/额度展示、终端进程回收和更新检查点恢复。
- 本次仅同步宿主与通用 SDK 源码，不包含游戏工作台插件、素材或专属验收脚本，也不创建新的安装包或 tag。已有安装包以各自构建记录和校验值为准，不能作为本次全部源码的二进制证明。详见 docs/releases/main-2026-10-26.md。

V3 构建与升级提示
当前工作树的跨工作区父子任务使用 V3 数据契约，从 V1/V2 升级须结束任务、退出全部实例并安装新构建的完整包。下方记录对应原始公开 protected.35/V2 安装包；原安装包不能完成本地 V3 升级。请以实际构建记录、安装包校验值和协议探针区分相同显示版本号的构建。

原始公开版本记录（Windows x64，V2）
- **必须完整重启升级**：本版使用 V2 持久化契约，与 protected.34 的 V1 不兼容。请先结束任务、退出全部 CC GUI 实例及相关 worker/supervisor，再运行完整 NSIS 安装包。保留原数据；首次新版启动会受保护地归档旧更新元数据。不能从 V1 无重启热升，也不要绕过 schema hash 校验或直接降回 V1。
- **交接与子任务上下文**：交接草稿可选择目标工作区，保留人工编辑、引擎与模型选择；受管子任务的状态、结果摘录与待处理事项可进入交接摘要，不转移原有父子管理权限。
- **发送与任务成本确认**：已有会话咨询和受管任务可进入真实的待成本批准状态，由界面人工批准或取消。普通发送与自动队列派发对达到 50k tokens 的上下文应用相应冷缓存确认规则，普通发送也检查模型变更；小上下文直接放行，未知用量不虚构费用。
- **图片工具与通信面板**：会话图库支持切换、缩放、旋转、复制和保存；通信面板增加状态/类型筛选与紧凑/详细视图，保留图片批注与失败反馈。
- **会话可靠性与模型范围**：完善草稿交接、队列控制、Claude/AGY 用量恢复和缓存证据；Cursor 请求遵守已保存的允许模型名单。子任务按实际启动时的模型策略校验。
- **发行对应关系**：原始安装包对应 GitHub 提交 28dfbbda1，SHA-256 为 ae912a6b180c82627b691d56f2307712a97587b16e082f43417a7105c46d4fc8。本条版本记录为构建后的补记，原始安装包内未包含本条；详见仓库 docs/releases/1.1.1+protected.35.md。`,
      en: `Source synchronization (2026-10-26)
- Update the general plugin SDK to 0.3.28: project views, detached windows, native tasks and discussion conversations, image attachments, fixed instructions, bounded memory extraction and service shutdown before updates.
- Improve cross-workspace task and session ownership, communication queues, context/quota presentation, terminal process cleanup and update checkpoint recovery.
- This synchronization contains host and general SDK source only. It excludes the game workbench plugin, assets and dedicated acceptance scripts, and creates no new installer or tag. Existing installers retain their own build records and checksums and do not prove that they contain every change in this source update. See docs/releases/main-2026-10-26.md.

V3 build and upgrade notice
Cross-workspace parent/child tasks in this working tree use the V3 data contract. Upgrading from V1/V2 requires finishing tasks, exiting every instance and installing a newly built complete package. The notes below describe the original public protected.35/V2 installer, which cannot perform this local V3 upgrade. Distinguish builds sharing the display version by their build records, installer checksums and protocol probes.

Original public release notes (Windows x64, V2)
- **Full restart required**: this release uses the V2 persistence contract, incompatible with protected.34/V1. Finish tasks, exit every CC GUI instance and related worker/supervisor, then run the complete NSIS installer. Existing data is retained; the first V2 startup safely archives old update metadata. Do not hot-upgrade from V1, bypass schema-hash checks, or directly downgrade to V1.
- **Handoff and child-task context**: choose a destination workspace while preserving edited drafts and engine/model selections. Managed child-task status, result excerpts and outstanding work can be included in handoff summaries without transferring parent/child management rights.
- **Send and task cost review**: saved-chat consultations and managed tasks can enter a real pending-cost-approval state for a human to approve or cancel. Ordinary sends and automatic queue dispatch apply their cold-cache checks to contexts of at least 50k tokens; ordinary sends also check model changes. Smaller contexts pass through, and missing usage never becomes an invented cost.
- **Image tools and communications**: browse chat galleries, zoom, rotate, copy and save images. Filter communications by status/type and switch between compact and detailed views, while preserving annotation and error feedback.
- **Conversation reliability and model scope**: improve draft handoffs, queue controls, Claude/AGY usage recovery and cache evidence. Cursor requests respect the saved allowed-model list; subtask model policy is checked when work actually starts.
- **Release provenance**: the original installer corresponds to GitHub commit 28dfbbda1, with SHA-256 ae912a6b180c82627b691d56f2307712a97587b16e082f43417a7105c46d4fc8. This changelog entry was added after that build and is not embedded in the original installer; see docs/releases/1.1.1+protected.35.md.`,
    },
  },
  {
    version: "1.1.1+protected.34",
    date: "2026-10-19",
    content: {
      zh: `定制维护版
- **精简交互式功能引导**：顶栏新增「功能引导」气泡（可随时隐藏并在外观设置中重开），采用「单主题单步一句话 + 3 阶段自动轮播交互微缩卡」展示网络代理、自更新与安装、Handoff、Sidechat、/btw、图片批注、助手与旁白、Intelligence UI，无需手动点击填入命令。
- **自开发工程目录与一键「构建并热更新」**：侧栏为 \`ccgui-custom\` 显示专属紫色「自开发」徽章，移除时弹出显眼勾选确认（不删本地文件）；在「设置 → 工作区」与「设置 → 检查更新 → 运行中更新」新增 **「构建并热更新」** 按钮，手动 \`git pull\` 或改码后可一键后台增量构建并热切换。
- **图片预览圈选批注**：点击会话或草稿中的图片打开大图预览，支持拖拽绘制最多 9 处编号红框并填写修改说明，点击「加入草稿」自动附上原图与归一化坐标说明。
- **旁聊权限切换与截图**：Sidechat 支持「只读 / 可执行」模式实时切换，并支持截图粘贴、预览、移除及纯图片发送；带图的 /btw、/sidechat 正确路由，发送失败保留附件。
- **代理启动保护三态自适应**：全新安装默认关闭强制代理门禁（安装即用）；老版本热自更新且已启用本地代理时自动识别并固化保护。
- **Spellcast 桌面直连、固定 Vertex 旁白与 Intelligence UI 参数持久化**：支持独立宿主开关、持久化完成通知、Gemini 4 Argon / medium / Vertex 观察旁白，以及 Intelligence UI 参数跨重启恢复与追加草稿。`,
      en: `Maintained custom build
- **Streamlined interactive feature guide**: add a top-bar "Feature Guide" spotlight tour (hideable anytime and re-enableable in Appearance settings) using a single concise sentence + 3-stage auto-cycling interactive preview card across Proxy, Self-Update & Install, Handoff, Sidechat, /btw, Image Annotation, Asides & Notices, and Intelligence UI.
- **Self-Dev workspace & one-click "Build & Live Update"**: badge \`ccgui-custom\` with a purple "Self-Dev" tag in the sidebar, guard removal with an explicit consent notice (keeping disk files intact), and add a **"Build & Live Update"** button in Settings → Workspaces and Live Update for one-click incremental background builds after \`git pull\` or manual edits.
- **Image preview annotation**: open any chat or draft image in the lightbox, draw up to 9 numbered red boxes with notes, and click "Add to draft" to attach both the image and normalized coordinates.
- **Sidechat permission toggle & screenshots**: toggle Sidechat between Read-only and Execute modes at any time, and support image paste, preview, removal and image-only messages.
- **Tri-state adaptive proxy launch protection**: default launch proxy protection to off on fresh installs while automatically preserving and persisting protection on live self-updates when a local proxy is active.
- **Spellcast desktop connection, fixed Vertex observer & Intelligence UI persistence**: support durable completion delivery, Gemini 4 Argon / medium / Vertex observer bubbles, and persistent Intelligence UI parameters with one-click draft insertion.`,
    },
  },
  {
    version: "1.1.1+protected.33",
    date: "2026-10-16",
    content: {
      zh: `定制维护版
- **自更新构建**：按实际输入与工具配置校验并复用本机构建产物；增加独立的增量构建配置，正式发行配置保持不变。
- **前端独立打包**：支持从完整校验的版本目录加载前端资源。原生代码与兼容契约未变时，后续界面更新可复用原生程序；资源与程序一同切换和回退。
- **AGY 额度**：跳过 CLI 已禁用的额度窗口，避免其缺少重置时间导致有效额度全部丢失。`,
      en: `Maintained custom build
- **Self-update builds**: verify and reuse local artifacts against actual inputs and tool configuration. Add a separate incremental build profile while preserving the distribution profile.
- **Separate frontend packaging**: load frontend assets from a fully verified release directory. Later UI updates can reuse the native executable when native inputs and compatibility remain unchanged. Assets and executable switch and roll back together.
- **AGY quotas**: skip quota windows disabled by the CLI so missing reset times in those windows do not discard valid quotas.`,
    },
  },
  {
    version: "1.1.1+protected.32",
    date: "2026-10-16",
    content: {
      zh: `定制维护版
- **轻量旁聊**：Claude、Codex、Antigravity、Cursor 支持 /btw 临时提问与 /sidechat 连续旁聊，主任务可继续运行。旁聊独立归属，支持复制、插回主输入框和转为独立对话；缓存读数以引擎实际报告为准。
- **底栏与上下文**：隐藏无有效读数的 TPS，整理额度和上下文布局；AGY 可展示已知模型容量，未知实时占用不显示假百分比。
- **Vertex 通道**：通过本机桥接发送真实 Vertex 请求，接入独立会话历史和恢复，拒绝跨计费通道续聊与错误模型替换；请求失败不回退订阅。赠金余额未接入时提供官方账单入口，不再显示固定金额。
- **每轮小结**：回答结束后展示可得的耗时、token、缓存、思考量、工具次数与整轮均速；缺失数据隐藏，原生历史不完整用量明确标注。`,
      en: `Maintained custom build
- **Sidechat**: Claude, Codex, Antigravity and Cursor support temporary /btw questions and ongoing /sidechat conversations while the main task continues. Side sessions have separate ownership, with copy, insert into the main draft and promote-to-chat actions. Cache counts use actual engine reports.
- **Footer and context**: hide TPS without valid measurements and tidy quota/context controls. AGY can show known model capacity without inventing current occupancy.
- **Vertex routing**: send Vertex requests through a local bridge, discover and restore its separate history, and reject cross-billing resumes or model substitutions. Failures never fall back to subscription billing. Link to official billing instead of showing fixed credit balances.
- **Turn summaries**: show available elapsed time, tokens, cache, reasoning, tool counts and whole-turn average speed after replies. Omit missing data and label incomplete native history usage.`,
    },
  },
  {
    version: "1.1.1+protected.31.quotatpsagy",
    date: "2026-10-14",
    content: {
      zh: `定制维护版
- **订阅额度与 TPS**：保留同账户的有效订阅额度，避免会话结束后被空通知清空；周额度显示剩余比例。恢复 Codex 会话时使用原生恢复的 Token 基线，修复本轮 TPS 缺失；重连后刷新统计。
- **Codex 上下文配置**：支持设置上下文窗口和自动压缩阈值，下一次 CLI 进程启动时生效；占用条仍使用 CLI 实际报告的容量。
- **AGY Leader 接入**：支持本地草稿及已保存会话的父子任务管理、独立模型策略和 30 分钟默认 TTL；每轮通过临时插件注入宿主工具与规则，结束后清理。上下文占用只显示原生当前上下文数据。
- **代理入口**：移除聊天底栏的代理按钮，通过设置控制，新配置默认使用本机代理。`,
      en: `Maintained custom build
- **Subscription quotas and TPS**: preserve valid quotas for the same account instead of clearing them on empty end-of-turn notifications; show weekly remaining percentages. Use native restored token baselines for resumed Codex turns and refresh statistics after reconnection.
- **Codex context configuration**: configure the context window and automatic compaction threshold for the next CLI process. The usage gauge continues to use capacity reported by the CLI.
- **AGY Leader integration**: support parent/child management for local drafts and saved sessions, independent model policies and a 30-minute default TTL. Inject host tools and rules through a temporary per-turn plugin and clean it up afterward. Context occupancy uses native current-context data only.
- **Proxy controls**: remove the chat-footer proxy button; control the proxy in Settings, with the local proxy enabled for new configurations.`,
    },
  },
  {
    version: "1.1.1+protected.31",
    date: "2026-10-13",
    content: {
      zh: `定制维护版
- **Antigravity CLI 适配与模型同步**：按本机 CLI 实时读取模型与推理档位，离线保留最近有效目录和选择；发布快照已同步到 AGY 1.3.4。修复计划模式参数冲突、会话恢复、流式空白和工具错误/拒绝反馈。
- **AGY 统计与额度**：本轮平均 TPS 使用主机会话耗时与去重后的原生 Token 数，累计账单不重复计入；原生命令 /usage 展示 Gemini、Claude/GPT 的五小时与每周剩余额度和重置时间。
- **上下文与权限说明**：最近一次模型请求的 Token 数单独标注；CLI 未报告真实容量或当前占用时显示未知，不显示假 0% 或估算容量。权限保留默认、原生计划与 Turbo；逐条审批暂不可用时明确禁用并说明原因。`,
      en: `Maintained custom build
- **Antigravity compatibility and model synchronization**: read live model/effort choices from the installed CLI; retain the last valid catalog and selection offline. The bundled snapshot matches AGY 1.3.4. Fix planning flags, session recovery, streamed whitespace, and tool error/denial feedback.
- **AGY statistics and quotas**: average turn TPS uses host elapsed time and deduplicated native token counts, without recounting cumulative billing. Native /usage reports Gemini and Claude/GPT five-hour and weekly remaining quotas with reset times.
- **Context and permission semantics**: label the latest model request's token counts separately. Missing capacity or current occupancy remains unknown without a fabricated percentage. Default, native Plan and Turbo remain available; unsupported interactive approval is explicitly disabled and explained.`,
    },
  },
  {
    version: "1.1.1+protected.29",
    date: "2026-10-06",
    content: {
      zh: `定制维护版
- **兼容真实 legacy Canvas 版本**：Spellcast 旧节点/回复可能从第 0 版开始；读取仅在关联对象存在且同为第 0 版时接受，保留全部对象和真实版本，不补造项目 ID 或把版本改为 1。原生对象仍要求正数版本，其他 schema、设备/关闭与项目检查保持。
- **保留写入边界**：第 0 版旧内容可读；当前批注写入仍要求正数版本，界面明确说明并禁用该批注操作。Canvas 8 MiB、其他读取/写回执 2 MiB、投影与 unknown 不重发保持不变。`,
      en: `Maintained custom build
- **Accept valid legacy Canvas revisions**: old Spellcast nodes/replies can start at revision 0. Reads accept zero only when the exact referenced node/reply exists at revision 0. All objects and their real versions remain intact, without invented project IDs or rebasing to 1. Native objects still require positive revisions; other schema, device/close and project checks remain.
- **Preserve write boundaries**: legacy revision-0 content is readable. Annotation writes still require a positive revision, and the UI explains and disables that unavailable operation. Canvas 8 MiB, other reads/write receipts 2 MiB, projections and unknown-outcome no-replay behavior are unchanged.`,
    },
  },
  {
    version: "1.1.1+protected.28",
    date: "2026-10-06",
    content: {
      zh: `定制维护版
- **Canvas 独立读取预算**：整板读取使用固定 8 MiB 上限，保留长度预检、流式累计硬限、5 秒超时及关闭/设备撤销检查。项目、记录、法阵读取和全部写响应/回执仍为 2 MiB；字段投影与图片限制保持不变。
- **准确的超限反馈**：Canvas 超限明确显示 8 MiB（8,388,608 字节），停止读取且不显示部分内容；记录/法阵窗口写权保持原状态。`,
      en: `Maintained custom build
- **Separate Canvas read budget**: full-board reads have a fixed 8 MiB limit, retaining Content-Length checks, streamed byte accounting, the 5-second timeout and close/device-revocation checks. Project, record and sigil reads plus all write responses/receipts keep the 2 MiB limit. Field projections and image limits are unchanged.
- **Accurate oversize feedback**: Canvas errors state the 8 MiB (8,388,608-byte) limit. Reading stops without showing partial content. Record/sigil window-write authorization is unchanged.`,
    },
  },
  {
    version: "1.1.1+protected.27",
    date: "2026-10-06",
    content: {
      zh: `定制维护版
- **默认连接本机 Spellcast**：启动和打开设置 → 工作区 → Spellcast 时探测已运行的 127.0.0.1:47194 服务，提供持久连接开关、连接状态与重新连接；不启动服务、模型、Observer 或法阵。
- **保留关闭与设备权限**：已保存选择优先于旧环境变量，旧显式关闭迁移后继续关闭。现有及以后批准的网页设备可访问全部项目与画板；匿名 LAN token 无权读写或更改连接设置。关闭和撤销在发送及返回内容前再次检查，已发写入保留回执或未知结果，不自动重发。
- **明确写入边界**：保留版本/CAS 与紧凑回执；缺少安全窗口 key 时记录和法阵保存仍不可用，不创建或借用凭据。`,
      en: `Maintained custom build
- **Connect to local Spellcast by default**: startup and Settings → Workspace → Spellcast probe the already-running service at 127.0.0.1:47194. A persistent switch, connection status and reconnect action are available. Connection management never starts the service, a model, Observer or sigil.
- **Preserve close choices and device permissions**: saved choices override the legacy environment variable; an explicit legacy close is migrated and retained. Current and future approved web devices can access all projects and boards. Anonymous LAN tokens cannot read, write or change the connection. Close and revocation are rechecked before sending and releasing results; sent writes keep durable receipts or unknown outcomes and are never automatically resent.
- **Honest write limits**: revision/CAS checks and compact receipts remain. Record and sigil saves stay unavailable without the safe window key; no credentials are created or borrowed.`,
    },
  },
  {
    version: "1.1.1+protected.24",
    date: "2026-10-05",
    content: {
      zh: `定制维护版
- **Leader 模型策略更清晰**：将不明显的小开关替换为「不限制 / 仅允许所选模型 / 禁用此引擎」三个文字按钮；当前选择高亮显示，可分别禁用 Claude 或 Codex 新子任务。
- **避免空选误禁用**：指定模型时至少选一个才可保存，禁用使用独立选项；目录加载或失败不再锁住策略选择，已有子任务不受影响。
- **中继连接遵守应用代理**：远程中继通过设置中的 HTTP 代理建立连接，由代理处理中继域名，修复系统代理未覆盖 WebSocket 导致的连接失败。
- **代理失败不直连**：代理未启用、地址不支持或连接失败时明确报错并重试；保留正常 TLS 证书校验和既有防直连保护。`,
      en: `Maintained custom build
- **Clearer Leader model policies**: replace the faint switch with visible Unrestricted, Only selected models, and Disable this engine buttons. The current selection is highlighted, and new Claude or Codex child tasks can be disabled independently.
- **No accidental disable from an empty selection**: selecting models requires at least one choice before saving; disabling has its own option. Catalog loading or failure no longer blocks policy changes. Existing child tasks are unaffected.
- **Relay connections use the app proxy**: the remote relay connects through the HTTP proxy selected in settings, with the proxy handling the relay hostname. This fixes WebSocket failures when the system proxy did not cover the relay transport.
- **No direct fallback**: disabled, unsupported or failing proxy settings produce an error and retry. Normal TLS certificate verification and existing direct-connection protection remain in place.`,
    },
  },
  {
    version: "1.1.1+protected.23",
    date: "2026-10-05",
    content: {
      zh: `定制维护版
- **Leader 可用模型设置**：新增设置 → Leader，可分别限定 Claude/Codex 新子对话能使用的模型；默认不限制，空选可禁止该引擎新建子对话，已有子对话保持原设置。
- **派发遵守选择范围**：Leader 可查询可用模型与默认值，原生派发拒绝范围外的模型；未指定时优先使用范围内的默认模型，否则使用首个已选模型。effort 仍可自主选择。
- **可靠保存与反馈**：目录读取失败保留已有选择，保存失败保留草稿；离开页面后晚到的刷新结果不再创建反馈定时器。`,
      en: `Maintained custom build
- **Allowed models for Leader**: a new Settings → Leader page limits the models available to new Claude/Codex child chats independently. The default is unrestricted; an empty selection disables new children for that engine. Existing children keep their settings.
- **Enforced dispatch choices**: Leader can inspect the allowed models and effective defaults, and native dispatch rejects models outside the selection. An omitted model uses the allowed app default or the first selected model. Reasoning effort remains independently selectable.
- **Reliable saving and feedback**: catalog failures retain saved selections and save failures preserve drafts. Refresh results arriving after navigation no longer create feedback timers.`,
    },
  },
  {
    version: "1.1.1+protected.22",
    date: "2026-10-05",
    content: {
      zh: `定制维护版
- **Claude 模式与努力等级分开**：努力等级为 low、medium、high、xhigh、max 五档，Ultracode 作为独立开关按会话保存，默认关闭；旧 ultra 兼容为 max，不自动打开 Ultracode。
- **单独停止后台任务**：任务详情可调用 Claude 原生接口停止选中任务，失败可重试；只有确认原生终态才更新结果，并修复命令已停止后仍一直等待的收尾问题。
- **对话 TPS 监测**：输入区状态栏显示整轮平均输出 TPS，包含等待、工具执行与思考；详情区分可测的生成 TPS 和整轮平均，不从字符数估算 token。
- **可靠计量与低开销更新**：复用 Claude/Codex 已有用量事件，匹配回合与计时、去除重复报告；缺少完整数据时显示无数据。统计独立于消息、计费和运行状态，限频更新，不新增模型调用或后台轮询。`,
      en: `Maintained custom build
- **Separate Claude mode and effort**: effort has five levels—low, medium, high, xhigh and max. Ultracode is a separate, per-session switch, off by default; legacy ultra maps to max without enabling Ultracode.
- **Stop individual background tasks**: task details use Claude's native control to stop the selected task, with retry on failure. Results update only after a confirmed native terminal state; stopped commands no longer leave the run waiting indefinitely.
- **Conversation TPS monitor**: the composer status bar shows average output tokens per second for the turn, including waiting, tools and reasoning. Details distinguish measurable streaming generation TPS from the turn average without estimating tokens from characters.
- **Reliable, low-overhead accounting**: reuses existing Claude/Codex usage events with matched turn timing and duplicate filtering; incomplete data remains unavailable. Telemetry stays separate from messages, billing and run state, is rate-limited, and adds no model calls or background polling.`,
    },
  },
  {
    version: "1.1.1+protected.21",
    date: "2026-10-05",
    content: {
      zh: `定制维护版
- **重复启动不再误报失败**：已有窗口恢复后，若 Windows 拒绝切换焦点，只闪烁任务栏提醒并正常结束重复进程，不再显示「启动受阻」。单实例锁、退出与重启交接保护保持有效；真实锁检查或窗口恢复失败仍明确报错。`,
      en: `Maintained custom build
- **No false launch failure on repeated starts**: after restoring the existing window, a Windows foreground denial now flashes its taskbar button and ends the duplicate process normally. Ownership, exit and restart handoff remain protected; actual lock or restoration failures still show an error.`,
    },
  },
  {
    version: "1.1.1+protected.20",
    date: "2026-10-05",
    content: {
      zh: `定制维护版
- **Windows 单实例保护**：同一应用数据目录仅允许一个桌面实例；重复打开会等待已有窗口准备好，再恢复并聚焦它。检查先于清理、扫描和后台初始化，锁由系统管理，退出或崩溃后可重新启动。
- **完整启动边界**：内部聊天与电脑操控 MCP 服务仍可独立运行；应用重启会先撤下旧窗口标记，防止新进程被误当成重复启动。系统拒绝激活或启动检查失败时显示明确错误，并阻止第二个窗口初始化。
- **重启失败反馈**：设置页重启请求期间禁用重复点击，请求失败时保留设置并允许重试。`,
      en: `Maintained custom build
- **Windows single-instance protection**: only one desktop instance may own the same application data directory. Repeated launches wait for the existing window, then restore and focus it. Ownership is checked before cleanup, scanning and background initialization; OS-managed locking permits relaunch after exit or a crash.
- **Startup boundaries**: chat and computer-use MCP services remain independent. Restart retires the old window marker so the replacement is not mistaken for a duplicate. Failed activation or ownership checks show a clear error and block a second GUI from initializing.
- **Restart failure feedback**: settings disable repeated restart clicks while pending, retain settings when the request fails and allow retry.`,
    },
  },
  {
    version: "1.1.1+protected.19",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **任务组删除入口**：Leader 根会话右键补上红色「删除整个任务组」，进入现有管理面板后明确确认。保留整组空闲检查，子会话不能单独删除或拆散任务树。
- **包含上一版改动**：包含 protected.18 的自动命名、标题生成建议及 Leader 调度说明；自动命名默认关闭。`,
      en: `Maintained custom build
- **Task group deletion entry**: the Leader root context menu now includes a red “Delete entire task group” entry, opening existing management for explicit confirmation. Whole-group idle checks remain; child conversations cannot delete or split the task tree.
- **Previous changes included**: includes protected.18 automatic naming, title suggestions and Leader coordination guidance; automatic naming remains off by default.`,
    },
  },
  {
    version: "1.1.1+protected.18",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **会话自动命名**：设置 → 通用 → 行为可开启，默认关闭。普通本地聊天及 Leader 子聊天回复结束后，隔离调用 Claude Sonnet 生成「emoji 对象｜目标」标题，也可选择 Haiku；会消耗 Claude 额度。
- **标题保护与生成建议**：手动标题优先并锁定自动命名；会话归档、内容变化、中断或并发重名时丢弃不适用的结果。重命名弹窗可生成建议，确认后才保存；请求期间继续编辑会保留你的草稿，留空可清除手动标题。
- **隔离与输入反馈**：命名调用不保存会话，关闭 hooks、MCP、技能和工具；取消时清理临时文件，输出有界。通用输入弹窗恢复初始聚焦与全选。
- **Leader 调度说明**：复杂任务先说明分工，独立可追踪工作优先派到 Leader 子聊天，主级保留关键判断、必要实现、集成与验收。`,
      en: `Maintained custom build
- **Automatic conversation titles**: enable under Settings → General → Behavior; off by default. After local chat and Leader child replies, an isolated Claude Sonnet call generates an “emoji object｜goal” title; Haiku is also available. Naming consumes Claude usage.
- **Title protection and suggestions**: manual titles take precedence and lock automatic naming. Results are discarded when archival, content changes, interruption or concurrent duplicates invalidate them. Generate a suggestion in the rename dialog and confirm to save; edits made during generation are retained, and clearing the field removes a manual title.
- **Isolation and input feedback**: naming does not save a conversation and disables hooks, MCP, skills and tools. Cancellation cleans temporary files, and output is bounded. Generic input dialogs regain initial focus and selection.
- **Leader coordination guidance**: explain substantial task division, prefer tracked Leader children for independent work, and retain core judgment, necessary implementation, integration and acceptance in the parent.`,
    },
  },
  {
    version: "1.1.1+protected.17",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **Leader 围绕单项任务协调**：角色说明明确当前任务的目标与授权范围，继续由模型判断分工和模型选择。
- **子聊天 TTL 按引擎默认**：Claude Code 为 60 分钟，Codex 为 30 分钟；显式时长优先，既有到期时间保留。
- **到期时间与压缩建议**：子聊天的到期信息可查看；TTL 已到期且可靠上下文占用达到 50% 时建议考虑压缩，由用户决定。未知用量不猜测，提醒不自动压缩或回收。`,
      en: `Maintained custom build
- **Leader coordinates one task**: role guidance keeps delegation within the current task and its authorization, while the model chooses responsibilities and model settings.
- **Engine-specific child TTL defaults**: 60 minutes for Claude Code and 30 minutes for Codex. Explicit durations take precedence; existing deadlines are retained.
- **Visible deadlines and compaction advice**: child deadlines remain available. An expired TTL with reliable context occupancy of at least 50% suggests considering compaction, leaving the decision to the user. Unknown usage is not guessed, and reminders do not compact or reclaim chats.`,
    },
  },
  {
    version: "1.1.1+protected.16",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **新对话可先开启 Leader**：本机 Claude / Codex 的空白新对话右键可启用或停用 Leader，侧栏显示标记；第一条正式任务即可派发，无需先发占位消息。
- **首轮授权绑定真实会话**：发送前提供角色说明，校验实际会话身份并保存授权后再开放 Leader 工具；权限和身份失败会明确报错，不改成普通聊天执行。
- **草稿与取消保持隔离**：选择只属于当前草稿，关闭、新建或切换引擎时清除；准备发送可以停止，失败保留未提交的内容供重试。整组归档与用户确认删除沿用上一版。`,
      en: `Maintained custom build
- **Enable Leader before a new chat starts**: local Claude and Codex drafts offer Enable/Disable Leader in their context menu and show a sidebar badge. The first real task can delegate without a placeholder message.
- **Bind first-turn authorization to the real chat**: role guidance is supplied before execution, and Leader tools become available only after native identity validation and authorization persistence. Permission or identity failures remain explicit instead of falling back to ordinary execution.
- **Isolate drafts and cancellation**: the selection belongs only to the current draft and clears on close, a fresh chat or an engine change. Preparation can be stopped, and unsubmitted content remains available for retry. Whole-group archival and user-confirmed deletion remain as in the previous release.`,
    },
  },
  {
    version: "1.1.1+protected.15",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **Leader 完成后保留任务树**：子聊天的任务、结果与对话默认保留；模型不再拥有删除分支的工具。进程结束不等于删除记录。
- **由你整组归档或删除**：根会话与全部后代可以整体归档，在归档管理中查看分支与结果、恢复整组；永久删除是独立的明确操作。仍有执行、人工等待或启动中的任务时，归档与删除会拒绝，不静默停止工作。
- **Codex 工具挂载修复**：统一 app-server 配置参数的位置，防止模型、服务等级等配置让聊天工具或电脑操控挂载失效。
- **Leader 等待与说明完善**：等待只由新完成或新需处理的分支提前返回，避免旧结果让多任务等待空转；说明子聊天上下文、共享文件、默认模型及结果汇报的实际机制。长标题旁的 Leader 标记保持可见。`,
      en: `Maintained custom build
- **Keep completed Leader task trees**: child tasks, results and conversations remain by default; models no longer have a tool for deleting branches. Process retirement does not delete records.
- **Archive or delete whole groups yourself**: archive a root and all descendants together, inspect the preserved branches and results in archive management, and restore the whole group. Permanent deletion is a separate explicit action. Execution, user-action waits and pending launches block archive and deletion without silently stopping work.
- **Fix Codex tool configuration**: place all app-server configuration arguments consistently so model or service-tier settings cannot discard chat-tool or computer-use configuration.
- **Improve Leader waits and guidance**: only newly completed or newly attention-requiring branches wake a wait, avoiding loops over old results. Guidance explains child context, shared files, default models and result reporting. The Leader badge stays visible beside long titles.`,
    },
  },
  {
    version: "1.1.1+protected.14",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **Claude 停止遵循原生打断**：停止、电脑操控 Esc 和排队行「发送」只打断回复，不杀进程；覆盖启动中、无后台任务、等待后台任务和等待用户操作。启动前的停止会在进程登记后补发，不再因强杀留下无法继续的空会话。
- **未确认停止时明确等待并允许重试**：保持「正在停止」提示，5 秒后再次点击重发原生打断；管道失败或超时显示原因，不自动升级终止。排队消息在合适的空闲边界或最终运行结束后发送。
- **CLI 错误保留原文**：失败消息缺少 result 时显示 errors 中的具体原因。此次不自动恢复已有空会话，也不新增强制结束入口。`,
      en: `Maintained custom build
- **Claude Stop uses native interruption**: Stop, computer-use Esc, and queued Send interrupt the reply without killing the process, including startup, replies without background tasks, background waiting, and user-action prompts. A Stop before registration is resent once the child is registered, preventing forced termination from leaving an empty, unresumable session.
- **Pending stops remain visible and retryable**: keep showing Stopping until confirmed; click again after five seconds to resend native interruption. Pipe failures and timeouts show their cause without escalating to process termination. Queued messages wait for an eligible idle boundary or final run completion.
- **Keep the CLI's error details**: when a failed result omits result text, show its errors list. Existing empty sessions are not automatically recovered, and no force-end control is added.`,
    },
  },
  {
    version: "1.1.1+protected.13",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **后台调查期间也能继续对话**：后台子代理仍在做模型调用时，CLI 自身会一直报「运行中」、直到全部结束才报空闲；现在主回复一结束就按「等待后台任务」处理，追问直接发给运行中的会话，子代理的权限提示和状态翻转不再把界面拉回「响应中」。`,
      en: `Maintained custom build
- **Keep chatting during a background investigation**: while a background subagent is busy with model calls the CLI itself reports "running" until everything ends and only then idle; the run now counts as waiting for background tasks as soon as the main reply ends, a follow-up goes straight to the running session, and a subagent's permission prompts and state flips no longer pull the UI back to "responding".`,
    },
  },
  {
    version: "1.1.1+protected.12",
    date: "2026-10-04",
    content: {
      zh: `定制维护版
- **Claude 后台任务不再随回复结束而丢失**：原生 CLI 的后台命令、子代理和通知触发的自动续答在回复结束后继续运行；输入框上方「任务」胶囊列出任务名称、类型与真实状态（运行中 / 已完成 / 失败 / 已停止 / 未知）。
- **后台任务运行时可继续对话**：CLI 空闲而任务仍在时，新消息直接发给运行中的会话，与原生 CLI 一致；回复生成中发送的消息仍排队，到下一个空闲边界发出。
- **停止只打断当前回复**：回复生成中且有后台任务在运行时，停止不再结束整个运行，后台任务继续；其他状态的停止仍终止运行及其后台任务。
- **Codex 线程被 Codex Desktop 占用时交给 Desktop 续写**：聊天标签发送不再因「已有活动写入方」失败。
- 限制：启动后更换模型 / 权限 / 渠道 / effort 或批准新目录授权后，消息仍排队到本次运行结束；被打断的回复不统计用量。`,
      en: `Maintained custom build
- **Claude background tasks survive the end of a reply**: the native CLI's background commands, subagents and notification-driven follow-up replies keep running after the reply ends; the Tasks pill above the composer lists each task's name, kind and real status (running / completed / failed / stopped / unknown).
- **Keep chatting while background tasks run**: with the CLI idle and tasks still alive, a new message goes straight to the running session like the native CLI; messages typed during a reply still queue and are sent at the next idle boundary.
- **Stop interrupts only the current reply**: while a reply is generating and background tasks are running, Stop no longer ends the whole run and the tasks keep going; Stop in every other state still ends the run and its tasks.
- **Codex threads held by Codex Desktop continue there**: sending from a chat tab no longer fails with "already has an active writer".
- Limits: after changing model / permission / provider / effort or approving a new directory grant, messages still queue until the run ends; an interrupted reply reports no usage.`,
    },
  },
  {
    version: "1.1.1+protected.11",
    date: "2026-10-03",
    content: {
      zh: `定制维护版
- **子聊天完成提示归父级汇报**：Leader 管理的 Claude / Codex 子聊天进程携带子级标记，本机 Spellcast 据此跳过子聊天的完成气泡；包括父级派出的运行、子聊天页签发送和批准计划后的续跑。
- 根会话与普通聊天清除继承的子级标记，保留原有完成提示。包含 protected.10 的订阅信息恢复修复。`,
      en: `Maintained custom build
- **Parent-reported child completion**: managed Claude / Codex child processes carry a child marker so local Spellcast skips their completion bubbles, including parent-dispatched runs, turns sent from child tabs and approved-plan resumes.
- Root and ordinary chats clear inherited child markers and retain their completion notices. Includes the subscription restoration fix from protected.10.`,
    },
  },
  {
    version: "1.1.1+protected.10",
    date: "2026-10-03",
    content: {
      zh: `定制维护版
- **重开保留订阅信息**：本机保存经过校验的账号、套餐和额度快照，下次启动恢复同账号资料，无需每次重新手动查询。
- **保留真实更新时间**：恢复不刷新采集时间；旧额度继续标旧，超过一小时或窗口重置后显示未知，账号与套餐可继续显示。认证配置变化时隐藏旧账号信息。
- 缓存不保存凭据，启动恢复不增加 CLI/API 查询；写入失败不影响当前显示。`,
      en: `Maintained custom build
- **Retain subscription information across restarts**: store validated account, plan and quota snapshots locally, restoring the same account without another manual query on every launch.
- **Keep the original collection time**: restored usage remains stale when appropriate; usage older than one hour or past its reset becomes unknown, while account and plan may remain. Authentication configuration changes hide the previous account.
- The cache contains no credentials, restoration adds no CLI/API queries, and write failures leave current live information intact.`,
    },
  },
  {
    version: "1.1.1+protected.9",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **回收同步清理正文**：删除 Leader 子树时，同时清理宿主保存的任务、结果与旧回执副本；只保留防止重复执行所需的身份和请求摘要，迟到事件不能恢复正文。
- **发送链路验证**：Windows IPC、发送、停止及模型设置回归在隔离临时目录使用假引擎执行，避免读取真实账户配置或调用已安装的模型。
- **发布一致性**：检查前后必须是同一干净提交，并在安装前核验构建来源与程序哈希。包含上一版的隐私加固与 Leader 会话树。`,
      en: `Maintained custom build
- **Erase reclaimed branch content**: reclaiming a Leader subtree also clears host-owned task, result and cached receipt copies. Retain only identity and request fingerprints needed to prevent duplicate execution; late events cannot restore content.
- **Send-path verification**: exercise Windows IPC, sending, interruption and model settings with fake engines in isolated temporary directories, without reading real account configuration or invoking installed models.
- **Release consistency**: verification must begin and end on the same clean commit, with build provenance and executable hashes checked before installation. Includes the preceding privacy hardening and Leader conversation trees.`,
    },
  },
  {
    version: "1.1.1+protected.8",
    date: "2026-10-02",
    content: {
      zh: `隐私加固版
- **移除后台统计**：删除百度统计的启动代码、远程脚本入口和原生命令。
- **阻止外部图片自动加载**：收紧页面资源策略，保留本地附件和内嵌图片，禁止远程图片请求携带页面信息。
- **插件网络权限生效于目标地址**：不再自动跟随 HTTP 重定向，避免把请求正文转发到未授权主机或端口；插件收到原始 3xx 响应。
- 保留正常模型聊天、本机桥接和订阅额度功能。`,
      en: `Privacy hardening
- **Remove background analytics**: delete Baidu analytics startup code, remote script loading and native commands.
- **Block automatic remote images**: restrict page resources while retaining local attachments and embedded images.
- **Keep plugin requests within granted destinations**: return HTTP redirects without following them, preventing request bodies from being forwarded to unapproved hosts or ports.
- Retain normal model conversations, local integrations and subscription usage.`,
    },
  },
  {
    version: "1.1.1+protected.7",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **Leader 会话树**：本地已有 Claude / Codex 会话可启用 Leader，创建混合引擎子会话、读取结果，并在侧栏展开父子分支。
- **父会话管理**：由直属父会话续期、停止或回收子分支；回收前确认后代范围，子会话不能自行销毁。完成后的分支保留至回收。
- **期限检查**：区分运行、等待审批、完成与需要检查；到期不会自动删除或重派，失败后保留状态供检查与重试。
- **保留自主判断**：角色指引说明职责与权限，模型可根据任务选择协作方式，并保留用户原有配置指令。首版支持本地会话。`,
      en: `Maintained custom build
- **Leader conversation trees**: enable Leader on an existing local Claude or Codex chat, delegate to mixed-engine child chats, read their results, and expand the parent/child tree in the sidebar.
- **Parent-owned controls**: only a direct parent can renew, stop or reclaim its child branch. Reclamation confirms the descendant scope; children cannot destroy themselves. Completed branches remain until reclaimed.
- **Deadline checks**: distinguish running, waiting for approval, completed and attention states. Expiry never automatically deletes or replays work; failures remain available for inspection and retry.
- **Room for judgment**: role guidance describes responsibilities and permissions while leaving collaboration strategy to the model and preserving configured user instructions. This first version supports local chats.`,
    },
  },
  {
    version: "1.1.1+protected.6",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **常驻重置时间**：在订阅额度百分比左侧显示五小时重置时间与七天重置日期、时间；五小时跨日补日期，跨年补年份，悬停可看完整时间。
- 窄状态栏自然换行；缺失、过期或身份校验失败时隐藏无效时间。复用已有额度数据，不新增查询。
- 包含「更新信息」按钮及同步的加载提示。`,
      en: `Maintained custom build
- **Reset times beside usage**: show the five-hour reset time and weekly reset date/time to the left of subscription percentages. Include the date across midnight and the year across New Year, with the full timestamp on hover.
- Wrap narrow footers and hide missing, expired or invalidated timestamps. Reuse existing quota data without extra queries.
- Include the Update info button and matching loading label.`,
    },
  },
  {
    version: "1.1.1+protected.5",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **更新信息**：订阅详情按钮由「更新用量」改为「更新信息」，同步加载提示，说明它会更新账号、计划和额度。`,
      en: `Maintained custom build
- **Update info**: rename the subscription details action and its loading label to reflect that it updates the account, plan and usage.`,
    },
  },
  {
    version: "1.1.1+protected.4",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **额度面板显示账号与计划**：详情顶部显示当前 Claude Code 登录邮箱和官方返回的订阅计划名称；缺失信息显示「未提供」，不猜测个人昵称或套餐档位。
- 复用「更新用量」的受保护初始化回复，不增加账号查询请求；正常对话更新额度时保留同账号信息，切换身份或渠道后隐藏原信息。
- 保留 750K 自动压缩设置、代理保护和原有五小时／七天额度。`,
      en: `Maintained custom build
- **Account and plan in usage details**: show the current Claude Code login email and CLI-reported subscription label above usage. Missing fields remain unavailable; do not infer a nickname or plan tier.
- Reuse the protected initialization reply from Refresh usage without an extra identity request. Conversation reports retain same-account labels; account or channel changes hide prior identity.
- Preserve the 750K auto-compaction setting, proxy protection and five-hour/seven-day usage.`,
    },
  },
  {
    version: "1.1.1+protected.3",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **修复额度查询空值**：独立额度进程允许显式查询，继续关闭遥测、错误上报及自动更新，并用安全模式停用自定义脚本与插件；全局隐私配置、原账户和代理/防火墙保护保留。
- 旧额度超过两分钟标注「旧数据」，最长保留一小时；重置、账号或渠道变化时仍立即清空。
- 按钮改为「更新用量」，时间明确表示最近收到额度的时间。保留 750K 自动压缩设置。`,
      en: `Maintained custom build
- **Fix empty usage queries**: allow explicit reads in an isolated quota worker while disabling telemetry, error reporting and updates, with safe mode disabling custom scripts and plugins. Preserve global privacy settings, native authentication and proxy/firewall protection.
- Mark usage stale after two minutes and retain it for at most one hour. Reset windows and account/provider changes still clear it immediately.
- Clarify that the timestamp is when usage was last received. Preserve the 750K auto-compaction setting.`,
    },
  },
  {
    version: "1.1.1+protected.2",
    date: "2026-10-02",
    content: {
      zh: `定制维护版
- **输入框附近额度**：Claude 五小时、七天订阅额度移到输入框下方，点击查看重置时间、倒计时及最近更新时间。
- 正常对话收到额度后自动更新；挂载、获焦及定时检查仅读取缓存，主动查询由「刷新额度」触发，继续经过代理与防火墙保护。
- 缺失额度显示「—」，真实 0% 保留；旧数据标注状态，过期数据清空。账号、渠道、项目认证及远程工作区变化后重新校验；手动读取不会覆盖期间收到的新对话数据。
- 保留 750K 自动压缩窗口编辑和同步功能。`,
      en: `Maintained custom build
- **Quota beside the composer**: move five-hour and seven-day Claude subscription usage below the composer. Click for reset times, countdowns and the last update.
- Normal conversation quota reports update the display automatically. Mount, focus and periodic checks read only the cache; explicit Refresh requests retain proxy and firewall protection.
- Missing windows show an em dash while real zero usage is retained. Older data is marked and expired values are cleared. Revalidate account, provider, workspace authentication and remote boundaries; manual reads cannot overwrite newer conversation reports.
- Preserve the 750K auto-compaction editor and synchronization.`,
    },
  },
  {
    version: "1.1.1+protected.1",
    date: "2026-10-01",
    content: {
      zh: `定制维护版
- **自定义自动压缩窗口**：可修改 100–1000K，与 Claude Code 配置同步；容量未知的历史会话采用配置窗口，已知模型容量仍保留。
- Claude 订阅额度卡片显示 5 小时、7 天的已用百分比及重置时间；复用 CLI 登录与额度数据，读取失败和缺失数据如实显示。
- 额度主动请求沿用本机代理、TLS 与防直连检查；检查未通过时停止请求。
- 定制源码建立独立提交、完整上游历史、本地 Git 备份及合并、回归、构建流程。官方安装器自动更新停用，避免覆盖定制功能。`,
      en: `Maintained custom build
- **Custom auto-compaction window**: edit 100–1000K and synchronize it with Claude Code. Restored sessions without a known capacity use the configured window; known model capacity is retained.
- Show five-hour and seven-day subscription usage and reset times using the CLI's login and quota data. Missing data and read failures are reported accurately.
- Active quota requests require the local proxy, TLS and direct-egress checks. Failed protection checks stop the request.
- Preserve customization as separate commits with full upstream history, a local Git backup and merge, regression and build commands. Official installer updates are disabled to preserve the custom patch set.`,
    },
  },
  {
    version: "1.1.0",
    date: "2026-09-28",
    content: {
      zh: `✨ 新功能
- **对话区分屏（Trellis 式）**：中心区支持递归分屏，侧栏会话行或页签条里的会话页签拖到中心区即可分屏（**边带 = 在该方向切分**、**中心 = 放入 / 替换**；页签向下拖出页签条约 24px 交接给分屏层，横向拖动仍是排序）；格子标题栏提供「向右 / 向下分屏 / 关闭这一格」，侧栏会话右键「向右 / 向下分屏」，页签条右键「退出分屏」；拖动格子标题栏到另一格可实现整格搬家或内容互换。聚焦格 = 页签条高亮的那条对话所在的格子：点格子任意处即聚焦并激活其会话，点侧栏里已分屏的会话只是聚焦对应格；每个格子有自己的输入框、队列与运行状态（发送 / 排队 / 中断 / 加载更早 / 队列操作都按格子会话定向，授权、问答、计划审批卡从本格会话取数，@path 插入解析到聚焦格），/mcp 面板全局只挂一次；拖动分隔条改比例（两侧各留最小 220px、纵向 140px）；布局持久化在 localStorage 并在恢复时校验结构与会话，页签关掉的会话其格子一并消失，回到单栏时清掉持久化
- **计划预览与人工审批**：「计划」权限模式在 OMP（ACP elicitation.form + set_mode plan，计划文件全文校验）、Codex（app-server next_turn 的 collaborationMode plan，原子执行 turn）、dsh（host plan-review intent）三个引擎接通；grok / qoder 协议证据不足保持不可用，显式 plan 请求在发送前受控拒绝，不降级 auto / bypass。规划期间时间线显示计划卡（标题 / 引擎 / 版本 / 状态 / 摘要），草稿只可流式预览、不能批准，完整计划到达后进入「等待审批」；「查看完整计划」打开预览层（宽屏侧面板、窄屏全宽，复用消息 Markdown 渲染与安全处理，Esc / 点背景只收起界面、不发任何审批 IPC），复制按钮复制原文；审批在输入区 dock：「批准并执行」（旁注将沿用的执行权限，批准不改变权限）／「提出修改」（要求非空反馈，Enter 只换行、Cmd/Ctrl+Enter 提交）／「暂不执行」（计划保留未批准，卡片显示「继续审批」可随时重开 dock）；默认焦点不在批准按钮，提交中防重入，后端按 planId + revision CAS 仲裁，双击 / 双窗口只生效一次；冲突给出通知并保持只读快照，错误保持待审可重试；九个状态各有不依赖颜色的可访问文本徽标，已批准 / 已失效 / 已被取代只可查看与复制；与插件会话模式双向互斥；重开会话经 listPlanReviews 恢复历史计划与决策
- **设置搜索可搜页面内部的行**：左导航搜索从只匹配页标题扩展为两条 lane——「命中行」按目标页分组（组标题 = 页面名，行内显示「行标签 + 所在卡片」），点选或回车打开该页、滚动到该行并画 1.2s 内侧 focus ring；「命中页面」保留页标题子串过滤，两条都空才显示空状态。行索引是声明式的（settings-search.ts 注册表 + 内置页清单 builtin-search.ts），不预渲染页面扫 DOM；覆盖通用、网络代理、快捷键、检查更新、内测功能、性能诊断、Web 访问（含「公网访问」面板里的四行）、11 个 CLI 引擎页、智能体与提示词 / Skills（页签本身可搜）、工作区分组 / 项目 / 已授权目录；藏在页签或折叠卡里的目标由 activatorAnchor 先打开再定位（已打开不会点回去），品牌名用 labelText 保持不翻译；归档管理 / 用量 / 关于只提供页名入口
- **外观字体支持上传字体文件，界面缩放抽出共享存储**：设置 → 通用 → 外观的界面字体 / 代码字体改为「系统默认 / 自定义」；自定义经原生对话框选择 TTF / OTF / TTC / WOFF / WOFF2，Rust read_font_file 校验字体魔数与 64 MB 上限后回传，前端用 FontFace 注册为固定家族名并覆盖根变量 --font-inter / --font-mono-source，读取失败给本地化错误并保留原选择、不落半成品设置；路径持久化，切回自定义无需重选，旧 system 值与已安装字体名归一到系统默认；bootstrap 首帧前从 localStorage 镜像预应用，内置终端经 ccgui:font-change 热更代码字体并重新 fit。修复自带 Tailwind 的插件改写并成环 --font-sans / --default-font-family 导致字体设置静默失效（宿主在 :root 无层重推字体栈，插件 @layer 无法覆盖，回归守卫进 plugin-ui-tokens.test.ts）。界面缩放抽出 src/lib/zoom.ts：设置页缩放行、状态栏 ± 与缩放快捷键读写同一份 localStorage 并经 ccgui:zoom-change 事件同步，重启由状态栏重放。桌面宠物从通用页拆为「其他 → 桌面宠物」独立页，设置搜索的行索引随页面注册迁移。其它：⌘K / ⌘L / ⌘P 搜索面板输入框统一 palette-search-field，抑制 Windows WebView2 与后置插件样式画出的焦点框；输入框占位文案补充 @引用、#智能体；收起的 worktree 子行聚合显示会话运行状态点（退避重试降为静态点），展开后让位给各线程行
- **排队消息支持上下调序**：排队卡片每行在发送 / 移除之外新增「上移 / 下移」箭头；方向按用户看到的列表（卡片最新在上、队首在下）：上移 = 更晚发送，下移 = 更早发送；首尾行禁用对应方向（cursor + 降透明，不隐藏），仅队列多于一行时渲染，行首编号随重排实时重算；越界与未知 id 为 no-op，方向语义收在 QueueMoveDirection
- **CLI 选择器顺序跟随设置页拖拽排序**：设置页 CLI 管理栏的拖拽顺序此前只存在设置页，输入框的 CLI 选择器仍按注册顺序排列；现在两处共用 src/lib/cli-nav-order.ts（useSyncExternalStore，同标签页写派发事件），选择器按 cli:<id> 对齐设置页顺序，存储列表外的新引擎保持注册顺序排在末尾，设置页拖动时选择器同步重排
- **⌘L 会话搜索新增检索统计行**：内容 lane 存活时（查询 ≥2 字且「内容」筛选开启）在输入框下方显示一行状态：防抖与请求期间「正在检索…」，完成显示「耗时 {{time}} · 共检索 {{total}} 条消息」，失败显示「检索失败」且不留下上一查询的数字；后端 search_messages 新增 elapsedUs（只计 FTS / LIKE 查询与片段构建，pending / 语料计数在计时外）与 totalMessages；时长统一由 formatSearchDuration 格式化（<10ms 保一位小数、秒内整毫秒、跨秒两位小数秒）
- **新增 Requesty 供应商预设**：与 OpenRouter 预设对齐——Claude 的 ANTHROPIC_BASE_URL 为 https://router.requesty.ai，各档位默认模型使用 anthropic/claude-* 系列；Codex 为 https://router.requesty.ai/v1、wire_api = chat、模型留空由用户填写或拉取；README 中英文预设列表同步补充
- **文件 Markdown 预览支持表格与图表**：编辑模式预览改用 Vercel Streamdown 渲染——GFM 表格有表头与边框、代码块按语言高亮并带复制 / 下载按钮、支持 KaTeX 数学公式与 Mermaid 流程图（滚入视口才渲染），按钮文案随界面语言；暗色主题跟随现有语义色；相对路径图片仍解析到 Markdown 文件所在目录；外部链接继续交给系统浏览器打开

🐛 修复
- **进入页面即崩溃（unlisten 注册竞态）**：Tauri 2.11 的 listen() 在 Rust 应答后即 resolve，而 webview 侧监听条目由另一次 eval 写入，此刻调用 unlisten 会让注入的 unregisterListener 读取不存在的条目抛 TypeError（tauri#15799）；抛错发生在 _unlisten 发送 plugin:event|unlisten 之前，既产生未处理拒绝触发崩溃页，又泄漏 Rust 侧监听、重挂载后事件重复投递，StrictMode 开发态双挂载与晚到的 unlisten 都会命中；新增 installTauriUnlistenGuard() 按上游修复（PR #15800）语义吞掉缺失条目的抛错，让 _unlisten 继续发送 backend unlisten，tauri 依赖包含该修复后可删除该 shim
- **断网等环境性网络失败不再弹全屏崩溃页**：后台网络请求失败（更新检查的 reqwest error sending request、fetch 的 Load failed / Failed to fetch / NetworkError）是环境条件而非应用损坏；unhandledrejection 与 error 全局捕获统一分类，这类失败只记入诊断环，不再弹崩溃页、不写 localStorage（避免下次启动 watchdog 误报），真实未捕获错误照旧上屏；更新检查链路所有路径均有 catch
- **非安全 HTTP（局域网桥）环境下 crypto.randomUUID 缺失导致崩溃**：通过非安全 HTTP 访问（如局域网桥）时，浏览器 / WebView 的 crypto.randomUUID 因规范要求 SecureContext 而为 undefined，新会话渲染及 worktree / mission 等处抛 TypeError；新增 safeRandomUUID()（优先原生，缺失时用 getRandomValues 生成 RFC 4122 v4 UUID，极少数环境兜底 Math.random）并在入口尽早安装 polyfill，会话身份、worktree 创建 id 与 mission id 均改走该实现
- **选择模型下拉建议时整个界面崩溃**：Chromium 接受 datalist / autofill 建议时会先往输入框派发一个裸 Event("keydown")（没有 key、没有任何修饰键），全局快捷键分发器把它当击键处理，normalizeKey(undefined) 抛 TypeError；它在 window 事件监听里抛出，React 错误边界看不到，被全局处理器当成崩溃整页替换；现在分发器入口拦住没有击键的 keydown 直接返回，模型映射四个输入框与共用同一 datalist 的「模型」输入框一并修复
- **opencode 服务被内核提前清理**：ensure_server 返回的 kill-on-close 守卫绑定在局部变量上，函数返回即被释放，kernel 在健康检查刚通过时就把新起的 opencode serve 进程树清掉，随后的会话 POST 总是打到死端口报 error sending request；守卫改存入 OpencodeServerState（在 kill_spawned 释放），并修正 cfg(windows) 属性挂在赋值表达式上导致全平台编译失败（E0658，改为块语句）的问题
- **Codex 切换渠道后模型面板跳到 Claude Code**：渠道下拉收起前把焦点归还触发按钮，模型面板不再因焦点漂移跳回 Claude Code

🧹 内部优化
- ui-ux-spec 更新至 v0.61（检索统计行、设置搜索行索引、字体上传与缩放、计划审批、排队调序、对话区分屏等规则，§3、§7 同步）
- 新增浏览器夹具 tests/browser/split-layout.html（分屏、空格子、格子重排与内容互换、分隔条比例与最小宽度、持久化与回收、页签下拖分屏）与 plan-review.html、cli-channel-dropdown.tsx、markdown-preview.html（Streamdown 表格 / 代码块 / 数学 / Mermaid 懒渲染）；settings-search / builtin-search 测试逐页双向比对声明与渲染的锚点，并断言 activator 必须是同页可见锚点
- 计划审批后端新增 plan_reviews 表与 plan_review 模块（planId / revision CAS）、engine 侧 reader / omp_acp / dsh_session / codex_app 扩展与 listPlanReviews 命令；Cargo.lock 包版本同步到 1.1.0`,
      en: `✨ Features
- **Split view in the conversation area (Trellis-style)**: the center area now supports recursive splitting — drag a session row from the sidebar or a session tab from the tab strip into it to split (an edge band splits in that direction, the center drops in or replaces; dragging a tab about 24px past the bottom of the tab strip hands it to the split layer while horizontal dragging still reorders); a pane title bar offers Split right / Split down / Close this pane, a sidebar session's context menu offers Split right / Split down, and the tab strip's context menu offers Exit split view; dragging a pane title bar onto another pane moves the whole pane, and dropping on the center swaps the two panes' contents. The focused pane is the one whose conversation the tab strip highlights: clicking anywhere in a pane focuses it and activates its session, and clicking a session that is already split only focuses that pane. Each pane has its own composer, queue, and run state (send / queue / interrupt / load earlier / queue operations are routed to the pane's session, approval, question, and plan-review cards read the pane's session from SessionScope, and @path insertion resolves to the focused pane), while the /mcp panel is mounted only once. Dragging a separator changes the ratio (a 220px minimum on each side, 140px vertically); the layout persists in localStorage and is validated against structure and sessions on restore, panes disappear together with their closed tab, and returning to a single column clears the persisted layout
- **Plan preview and manual approval**: the plan permission mode is wired up for OMP (ACP elicitation.form + set_mode plan, with full-text validation of the plan file), Codex (collaborationMode plan over app-server next_turn, executing the turn atomically), and dsh (host plan-review intent); grok / qoder remain unavailable because the protocol evidence is insufficient, and an explicit plan request is refused before sending rather than silently downgraded to auto / bypass. While planning, the timeline shows a plan card (title / engine / revision / status / summary); a draft can only be previewed as a stream and cannot be approved, and once the full plan arrives the card becomes "Awaiting approval". "View full plan" opens a preview layer (a side panel on wide screens, full width on narrow ones, reusing the message Markdown rendering and sanitisation) where Esc / clicking the backdrop only dismisses it and sends no approval IPC, and Copy copies the source. Approval lives in the composer dock: "Approve and run" (annotated with the execution permission it will use — approving never changes permissions) / "Request changes" (requires non-empty feedback; Enter inserts a newline and Cmd/Ctrl+Enter submits) / "Not now" (ends this approval round — the dock collapses as the visible effect, the plan stays unapproved, the native wait stays put, and the timeline card shows a deferred note with a "Continue approval" button that reopens the dock at any time). Focus does not default to the approve button, submission is re-entrancy guarded, and the backend arbitrates with planId + revision CAS so a double-click or two windows yield exactly one approval; a conflict (superseded by another window or a newer revision) shows a notification and leaves a read-only snapshot, and errors stay pending and retryable instead of faking success. All nine states (Draft / Awaiting approval / Submitting / Approved / Changes requested / Deferred / Cancelled / Invalidated / Superseded) have accessible text badges that do not rely on colour, and approved / invalidated / superseded revisions offer only view and copy. Plan review and the plugin conversation mode are mutually exclusive in both directions, and reopening a session restores the plan history and decisions via listPlanReviews (localStorage is not the approval authority)
- **Settings search now finds rows inside pages**: the left-nav search goes from matching page titles only to two lanes — "Matching rows" (grouped by target page, the page name as the group heading, each row showing the row label plus its card), where clicking or pressing Enter opens the page, scrolls to the row, and draws a 1.2s inset focus ring; and "Matching pages", the original page-title substring filter — and the empty state only appears when both are empty. The row index is declarative (the settings-search.ts registry plus a per-page manifest in builtin-search.ts) instead of prerendering pages and scanning the DOM. Coverage spans General, Network proxy, Shortcuts, Check for updates, Beta features, Performance diagnostics, Web access (including the four rows behind the Public access panel), all 11 CLI engine pages, Agents & prompts / Skills (the tabs themselves are searchable), and Workspace (Groups / Projects / Authorized directories); a target hidden behind a tab or a collapsed card is opened first by an activatorAnchor and located afterwards (an already-open one is never clicked back shut), brand names use labelText so they stay untranslated, and Archive / Usage / About keep page-name-only entries
- **Interface and code fonts can now be uploaded, and zoom gets shared storage**: Settings → General → Appearance turns the interface font / code font pickers into "System default / Custom"; a custom font is picked in a native dialog (TTF / OTF / TTC / WOFF / WOFF2), validated by Rust read_font_file for the font magic number and a 64 MB cap, returned as base64, registered through FontFace under a fixed family name, and applied by overriding the root --font-inter / --font-mono-source variables — a read failure gives a localised error and keeps the previous choice rather than persisting a half-applied setting. The paths are stored (fontFamily / fontFile / codeFontFamily / codeFontFile), so switching back to Custom needs no re-picking, and old system values and installed font names normalise to System default; bootstrap pre-applies the localStorage mirror before the first frame, and the built-in terminal hot-swaps the code font via ccgui:font-change and re-fits. Also fixed: plugins that ship their own Tailwind rewrote --font-sans / --default-font-family into a cycle and silently defeated the font setting — the host now re-emits the font stack at :root outside any layer so plugin @layer rules cannot override it, with a guard in plugin-ui-tokens.test.ts. Interface zoom moved into src/lib/zoom.ts: the settings row, the status bar ±, and the zoom shortcuts read and write one localStorage entry and stay in sync through ccgui:zoom-change, with the status bar replaying it on restart. The desktop pet moved out of General onto its own "Other → Desktop pet" page, and the settings-search row index follows the page registration. Other tweaks: the ⌘K / ⌘L / ⌘P search fields share palette-search-field to suppress focus rings drawn by Windows WebView2 and by later plugins; the composer placeholder now mentions @ references and # agents; collapsed worktree sub-rows aggregate their sessions' run-status dots (a retrying backoff becomes a static dot) and yield to the per-thread rows once expanded
- **Queued messages can be reordered**: every queue card row gains up / down arrows next to send / remove; the direction follows the list as the user sees it (newest card on top, queue head at the bottom) — up means send later and down means send earlier; the first and last rows disable the corresponding direction (cursor plus reduced opacity rather than hiding it), the arrows only render with more than one queued item, and the row numbers are recomputed live after a reorder; moving out of range or an unknown id is a no-op, with the semantics kept in one place (QueueMoveDirection)
- **The CLI picker follows the settings-page drag order**: the CLI management order dragged in Settings persisted in localStorage, but the composer's CLI picker still used registration order, so the two disagreed; both now share src/lib/cli-nav-order.ts (a useSyncExternalStore store that dispatches an event on same-tab writes), the picker is aligned to the settings order by cli:<id> keys, engines not in the stored list keep registration order at the end, and dragging in Settings reorders the picker live
- **⌘L session search gains a stats row**: while the content lane is alive (a query of 2+ characters with the Content filter on) a status line appears under the input: "Searching…" during debounce and request, "Took {{time}} · {{total}} messages searched" on completion, and "Search failed" on failure without leaving the previous query's numbers behind; the backend search_messages returns elapsedUs (timing only the FTS / LIKE query and snippet building, with pending / corpus counting outside it) plus totalMessages; formatSearchDuration formats everything consistently (one decimal below 10 ms, whole milliseconds within a second, two decimal seconds across seconds)
- **New Requesty provider preset**: aligned with the OpenRouter preset — Claude gets ANTHROPIC_BASE_URL https://router.requesty.ai with anthropic/claude-* tier defaults, and Codex gets https://router.requesty.ai/v1 with wire_api = chat and a blank model for the user to fill in or fetch; the English and Chinese README preset lists both mention Requesty
- **Richer Markdown preview for files**: the editor preview now renders through Vercel Streamdown — GFM tables get a styled header and borders, code blocks are highlighted by language with copy / download controls, and KaTeX math plus Mermaid diagrams (rendered lazily when scrolled into view) are supported, with control labels following the UI language; the preview follows the app theme in dark mode, local-relative images still resolve next to the markdown file, and external links keep opening in the system browser

🐛 Fixes
- **Entering a page could crash the app (unlisten registration race)**: in Tauri 2.11 listen() resolves as soon as Rust replies, but the webview-side listener entry is written by a separate eval, so calling unlisten inside that window makes the injected unregisterListener read a missing entry and throw a TypeError (tauri#15799); because the throw happens before _unlisten sends plugin:event|unlisten, it both produces an unhandled rejection that triggers the crash page and leaks the Rust-side listener, so events are delivered twice after a remount — StrictMode's double mount in development and any late unlisten can hit it. installTauriUnlistenGuard() now swallows the missing-entry throw with the semantics of the upstream fix (PR #15800) so _unlisten still sends the backend unlisten; the shim can be deleted once the tauri dependency includes #15800
- **Environmental network failures no longer open the full-screen crash page**: background request failures (the updater's reqwest "error sending request", fetch's Load failed / Failed to fetch / NetworkError) are environmental conditions rather than app corruption; the global unhandledrejection and error capture now classify them and only log them to the diagnostics ring — no crash page and no localStorage write (avoiding a false watchdog report on the next start) — while genuinely uncaught errors still surface; every path in the update-check chain has a catch
- **crypto.randomUUID was missing on insecure HTTP (LAN bridge) and crashed the app**: over an insecure HTTP origin (such as a LAN bridge) crypto.randomUUID is undefined because the spec requires a secure context, so new-session rendering and the worktree / mission paths threw a TypeError. A safeRandomUUID() helper uses the native API when present, falls back to crypto.getRandomValues for a spec-compliant RFC 4122 v4 UUID, and in rare environments falls back to Math.random; a polyfill is installed early at the entry point, and the conversation identity, worktree creation id, and mission id all go through it
- **Picking a datalist suggestion for a model could crash the whole UI**: when Chromium accepts a datalist / autofill suggestion it first dispatches a bare Event("keydown") to the input (no key, no modifiers). The global shortcut dispatcher treated it as a real keystroke and normalizeKey(undefined) threw a TypeError; thrown inside a window listener, it is invisible to React error boundaries and the global handler replaced the whole page with the crash screen. The dispatcher now returns early on any keydown without a keystroke, fixing the four model-mapping inputs and the "model" inputs of engines that share the same datalist
- **The opencode server was swept by the kernel right after starting**: the kill-on-close guard returned by assign_kill_on_close() was bound to a local in ensure_server, so dropping it on return let the kernel tear down the freshly spawned opencode serve tree the instant the health check passed, and the session POST that followed always hit a dead port and failed with "error sending request". The guard now lives in OpencodeServerState (released in kill_spawned); the fix also moves the cfg(windows) attributes onto block statements, since attributes on assignment expressions are experimental (E0658) and made the crate fail to compile on every platform
- **Switching the Codex channel made the model panel jump to Claude Code**: the channel dropdown now returns focus to its trigger button before it collapses, so the panel no longer drifts back to Claude Code

🧹 Internal
- ui-ux-spec updated to v0.61 (the search stats row, settings row search, font uploads and zoom, plan review, queue reordering, split view, and related rules, with §3 and §7 kept in sync)
- New browser fixtures tests/browser/split-layout.html (splitting, empty panes, pane rearrangement and content swap, separator ratio and minimum widths, persistence and collection, and drag-out splitting from the tab strip) plus plan-review.html, cli-channel-dropdown.tsx, and markdown-preview.html (Streamdown tables / code / math / lazy Mermaid); the settings-search / builtin-search tests compare declared and rendered anchors in both directions per page and assert that every activator is a visible anchor on the same page
- The plan-review backend adds the plan_reviews table and the plan_review module (planId / revision CAS), engine-side reader / omp_acp / dsh_session / codex_app extensions, and the listPlanReviews command; Cargo.lock is synced to package version 1.1.0`,
    },
  },
  {
    version: "1.0.9",
    date: "2026-09-24",
    content: {
      zh: `✨ 新功能
- **Worktree 子工作区**：侧栏父仓库行下新增「Worktrees · n」分组，worktree 作为子工作区挂在里面（子行主名是分支名，可展开各自的会话线程，也可直接在子目录里开新会话）；创建对话框按「新分支（默认）/ 已有分支 / 从 PR 创建」三种来源，PR 支持编号或链接，即交即走并在分组顶部显示可取消、可重试的三态进度行（校验 / fetch / 创建 / 注册逐段替换，失败按原因给重试或改名 / 修复指引）；「新分支」的 base 默认取父工作区当前检出分支（main / master 改用远程同名分支），用户手选后不再被晚到的状态改写；删除走分级确认（未提交文件、未推送提交、是否已合入 base 三项预检，默认保留本地分支，有进行中的会话或终端任务会额外提示）；父工作区移除 / 归档时先列出受影响的 worktree 再确认（只移除侧栏登记，磁盘目录不动）；目录已从磁盘消失或已被 git 锁定的 worktree 在侧栏明示，锁定项禁用删除并给出原因
- **崩溃不再白屏**：三层兜底——启动占位 + 8 秒 watchdog（bundle 加载失败或 React 挂载前崩溃时显示原因与重新加载）、全局 error / unhandledrejection 捕获、顶层 React 错误边界；崩溃页给出具体错误原因、可展开的技术详情，以及重新加载 / 复制错误信息 / 退出应用；崩溃报告只在本地留存（内存环形 + localStorage 最近一条），不自动上传。ResizeObserver loop、Script error 这类浏览器自身噪音只在诊断环里每条记一次，不再每隔几分钟弹一次全屏崩溃页，也不会被下次启动当成启动失败原因
- **桌面宠物（Codex v2 宠物包）**：独立透明置顶小窗，只有宠物图像本身接收点击（左键拖动、右键在 50% / 75% / 100% / 125% / 150% 五档间循环缩放并立即持久化，键盘 Enter / Space 与右键同效，其余区域鼠标穿透不挡桌面操作）；状态气泡玻璃拟态，有活动会话时每 1.8 秒在会话间轮播（失败 / 等待确认优先于运行中，刚完成的会话短暂显示「已完成」，两行截断显示会话名 + 状态）；位置与大小持久化，恢复前校验仍落在已连接的显示器内；设置「常规」里可导入 / 移除 Codex 宠物包（pet.json 与 spritesheet.webp 同目录）、切换角色与大小，导入先读头尺寸并限制清单 / 图集大小，移除走危险确认
- **升级后首启自动宣布新版本**：应用版本比上次运行真的前进、且本地版本记录里有该版本时，首启自动把「版本更新」开成中心页签并标记未读（页签强调色圆点 + 页头「新版本」胶囊，关掉页签即视为已读）；首次安装只写基线不弹，版本没变、降级、版本号认不出、本地没有该版本条目都不弹，每个版本只宣布一次；待更新版本不写未读标记，那条路径已有浮层与「立即更新」
- **任务详情下钻**：运行状态条的任务模块可点进单条任务查看详情与执行情况（任务内容、所属阶段、执行状态、阻塞原因与长说明），面板内返回，打开详情时焦点落在返回按钮
- **AskUserQuestion 多题逐题确认**：单选选项改用圆形标记、多选改用方形复选标记；单选答完自动跳到下一道未答题；非末题的多选题显示「确认本题并继续」保存本题选择，仅最后一道多选题给「提交」，全部答完再统一提交
- **Git 分支选择器列出远程跟踪分支**：变更面板与状态栏共用同一份分支列表，在本地分支之后列出 origin/x 并标中性「远程分支」徽标（跳过 origin/HEAD 符号引用），刚 fetch 到的分支可搜可切；检出远程分支时物化为同名本地跟踪分支——已存在就切过去，绝不用远程 tip 覆盖本地提交
- **设置支持筛选与单项编辑 OMP 自定义供应商**：供应商列表新增搜索框；单项编辑只替换该供应商的配置块，其余供应商、注释与顺序保持原样，定位不到配置块时拒绝保存并提示改用完整编辑器；删除自定义供应商加危险确认并写清后果
- **OMP 订阅授权新增 Google Antigravity 登录**：可发起 google-antigravity 登录并显示凭证授权状态，保留 google-gemini-cli 以兼容旧的 Google Code Assist 登录
- **OpenCode 权限模式支持 bypass**：serve 驱动下 bypass 对 permission.asked 回「always」（该会话内记住批准，等价于 run --auto；配置里显式 deny 的规则照旧生效），权限选择器不再把 bypass 置灰
- **电脑操控（入口暂未开放）**：Codex 引擎用 -c mcp_servers.… 在进程级挂载电脑操控驱动，不写用户 config，崩溃也不会把驱动留在配置里；不支持的引擎在发送前明确拒绝而不是静默当普通对话，远程（WSL 发行版）工作区同样拒绝；虚拟光标运行期全程显示、模型无法关闭，全局 Esc 急停只在该回合武装。设置页与斜杠菜单入口暂时隐藏，输入框仍可手动输入 /ccgui-cua 任务

🐛 修复
- **模型刷新改为全局生效**：模型目录此前按工作区各自缓存，刷新只更新当前工作区；现按「上下文」分桶——本机共用一份目录（任一工作区刷新即对所有本地工作区生效），远端（WSL 发行版）工作区各留自己的桶，不会把本机目录串成远端模型
- **重试退避期间不再和滚动抢合成器**：侧栏与页签的状态点、思考指示器在 provider 退避重试期间保持可见但停止动画（新增引用稳定的 retrying 映射，只在真正进出退避时改引用），中断与删除会话补齐 retry / streaming / retrying 清理，避免删除后 key 永久残留
- **会话解析缓存把工具输出计入内存预算**：旧口径只算正文与图片，工具结果多的会话被低估数倍，128 MB 预算名存实亡；现递归计入 args / result / usage、todo、消息路径 / 模型 / 精力等字段，让预算真正封顶
- **对话结束后子任务跨页丢失、子代理状态收敛与呼吸灯异常**：子任务与子代理行在回合结束后统一收敛为「已完成」，不再跨页后消失、卡在运行中或呼吸灯常亮
- **元信息里的模型名不再带渠道与插件前缀**：统一只展示最后一段的纯净模型名
- **输入框粘贴后一次撤销不再连坐**：粘贴走 insertHTML 单独占一个撤销步，不再把此前的输入一起删掉
- **稀疏检出（sparse-checkout）不再误报删除**：文件树与变更列表按 index 的 skip-worktree 位过滤未物化文件，不再出现「几百个未提交变更 / −10 万行」；规则排除了全部文件导致空检出时，worktree 创建返回明确错误并清理半成品，不登记空工作区
- **打包版插件样式不再被 CSP nonce 拦掉**：启动占位样式从 index.html 内联 style 移入 public/boot.css 外部文件——内联标签会让 Tauri 往 style-src 里加 nonce，使 'unsafe-inline' 失效，运行时注入的插件 CSS 全被拒（表现为插件照常激活、样式全丢）；并加守卫测试禁止 index.html 再出现内联 style / script
- **插件 exec 子进程找不到解释器**：plugin_exec_run / spawn 按 CLI 搜索目录注入子进程 PATH（插件自己传的 PATH 保持优先、按顺序去重），修掉 #!/usr/bin/env node 这类 shim 在 launchd 式 PATH 下报 env: node not found、工具静默无输出的问题；引擎 spawn 路径同样补齐
- **插件引导不再中断**：Tauri 2.11 的 __TAURI_INTERNALS__.invoke 是只读属性，硬赋值会抛错并让插件加载停在第 0 次重试；现按属性描述符安全替换，替换不了只告警不中断，缺失 Promise.withResolvers 的老 WebView2 也不再中断重试
- **OMP Google 通道不再被拒**：Google API（google-generative-ai / google-gemini-cli / google-vertex）不再携带 Cloud Code Assist 不接受的通用推理字段，原生 thinkingConfig 保留
- **聊天侧栏与 Git 变更列表的滚动和分页**：变更列表容器补 min-h-0 + overscroll-contain，吸顶摘要栏与分组头给出正确层级（不再被行盖住），行内按钮改 Tooltip；侧栏线程分页在重新展开时回到第一页，收起动画期间不再中途改页高
- **Worktree 分组展开 / 收起补齐高度动画**：分组从条件渲染改为 grid-template-rows 1fr ⇄ 0fr 的 300ms 过渡（收起动画结束才卸载，期间区域 aria-hidden + inert），与子行动画一致，不再一帧内闪现

🧹 内部优化
- Rust 后端新增 git_worktree（列表 / 创建 / 取消 / 删除、已合并判定、PR 解析与 pull ref 检出）、pets（宠物包导入与解码限额）、pet_overlay（透明宠物窗口与命中测试）三个模块；workspaces 表加性迁移 kind / parent_id，旧版 workspaces.json 的 worktree 子项在父项落库后按 db id 挂回，目录已删的子项跳过
- Windows 统一嵌入 manifest 并补 Win32_UI_WindowsAndMessaging 依赖；Windows CI 因 computer-use 依赖让 lib-test 可执行文件加载失败（0xc0000139）改为只做测试编译；git discard 测试固定 core.autocrlf=false
- 移除拖拽授权链路（computer_use_drag_source 命令、tauri-plugin-drag 依赖与 drag:default 权限），macOS 授权只保留「打开系统设置」深链；宠物窗口加入 capabilities
- 插件 SDK 文档补充 exec 子进程 PATH 注入契约并再生成 sdk-api.md；新增 tests/browser/sidebar-collapse.html 逐帧采样回归（分组与子行展开 / 收起各需 ≥3 个中间帧）；ui-ux-spec 更新至 v0.52（展开 / 收起动效 §2.4、桌面宠物 §4.3、AskUserQuestion 多题、Worktree 全链路、崩溃兜底、远程分支、电脑操控规则）
- 文档：新增 worktree 交互设计稿与实现说明；重构抽离 GeneralSection / QuestionCard / RunStatusStrip / WorktreeCreateDialog / DeleteWorktreeDialog / PetOverlayApp / repo-tree / workspace-context-menu 的 hook 与子组件（行为不变）`,
      en: `✨ Features
- **Worktree sub-workspaces**: a "Worktrees · n" group under each repo row holds its worktrees as child workspaces (the child row is named after the branch, expands to its own session threads, and can start a new session right in that directory); the create dialog offers three sources — New branch (default) / Existing branch / From PR — with the PR form accepting a number or a URL, dispatched immediately with a cancellable, retryable three-state progress row at the top of the group (validate / fetch / create / register replace each other, and failures give a retry or rename/fix hint by reason); the New branch base defaults to the parent workspace's currently checked-out branch (falling back to the remote same-name branch for main/master) and is never rewritten by a late status update once the user picks one; deletion goes through a graded confirmation (uncommitted files, unpushed commits, and whether the branch is merged into its base are pre-checked; the local branch is kept by default, with live sessions or terminals called out); removing or archiving a parent workspace lists the affected worktrees first (sidebar registration only — disk contents are never touched), and a worktree whose directory is gone or that git has locked says so, with locked ones not deletable
- **No more blank window on a crash**: three layers — a boot placeholder plus an 8-second watchdog (shows the reason and a reload when the bundle fails to load or React dies before mounting), global error / unhandledrejection capture, and a top-level React error boundary; the crash screen gives the concrete reason, expandable technical details, and Reload / Copy error / Quit, with reports kept locally only (in-memory ring plus the latest entry in localStorage) and never uploaded; browser noise such as ResizeObserver loop or Script error is logged once per message in the diagnostics ring, so it no longer pops the full-screen crash page every few minutes or gets mistaken for a failed start on the next launch
- **Desktop pet (Codex v2 pet packages)**: a separate transparent, always-on-top window where only the pet image itself takes clicks (drag with the left button; right-click cycles 50% / 75% / 100% / 125% / 150% and persists immediately, Enter/Space does the same, and the rest stays click-through so the desktop stays usable); a glassy status bubble rotates between active sessions every 1.8s (failed / waiting-for-approval before running, a just-finished session briefly shows "Completed", session name + status truncated to two lines); position and scale persist and are validated against connected displays before being restored; Settings → General imports or removes Codex pet packages (pet.json and spritesheet.webp in one folder), switches character and size, reads the header before decoding and caps manifest/atlas size on import, and confirms removal
- **First launch after an upgrade announces the new version**: when the app version really moved forward and the local changelog has an entry for it, the release-notes center tab opens automatically with an unread marker (accent dot on the tab plus a "New version" pill in the header, cleared by closing the tab); a first install only writes the baseline, and an unchanged version, a downgrade, an unparsable version, or a missing local entry never triggers it — each version is announced exactly once; a pending update found by the updater writes no marker, since that path already has its toast and "Update now"
- **Task drill-down**: the run-status strip's task module opens a per-task detail view with the assignment, its phase, execution state, blocker reason, and long payloads, with an in-panel back button that takes focus
- **AskUserQuestion multi-question flow**: single-choice options use round markers and multi-choice uses square checkboxes; a single-choice answer advances to the next unanswered question; a non-final multi-choice question shows "Confirm and continue" to save just that answer, only the final multi-choice question shows Submit, and the whole set is submitted together once complete
- **Git branch picker lists remote-tracking branches**: the branch list shared by the changes panel and the status bar lists origin/x after the local branches with a neutral "Remote branch" badge (skipping symbolic refs such as origin/HEAD), so a freshly fetched branch is searchable and selectable; checking out a remote branch materializes a same-named local tracking branch — switching to it when it exists, never overwriting local commits with the remote tip
- **OMP custom providers can be filtered and edited one at a time**: the provider list gains a search field, and per-provider editing replaces only that provider's block while every other provider, comment, and ordering stays as written; when the block cannot be located the save is refused and the full editor is suggested, and deleting a custom provider now asks for confirmation with the consequences spelled out
- **OMP subscriptions add Google Antigravity login**: google-antigravity can be logged in and its credential status shown, with google-gemini-cli kept for the legacy Google Code Assist login
- **OpenCode supports the bypass permission mode**: on the serve driver, bypass answers permission.asked with "always" (the server remembers approvals for the session — the equivalent of run --auto, while explicit deny rules in config still hold), and the permission picker no longer greys it out
- **Computer use (entry not exposed yet)**: the Codex engine mounts the computer-use driver at process level via -c mcp_servers.… — nothing is written to the user's config, so a crash leaves no driver behind; engines that cannot receive the driver refuse the send up front instead of silently running a plain chat, and remote (WSL distro) workspaces are refused too; the virtual cursor is drawn for the whole run and cannot be disabled by the model, and the global Esc stop is armed only during that turn. The Settings page and slash-menu rows are hidden for now; /ccgui-cua task still works when typed

🐛 Fixes
- **Model refresh is global again**: the model catalog used to be cached per workspace, so refreshing only updated the one in view; it is now bucketed by context — all local workspaces share one catalog (a refresh in any of them updates them all), and each remote (WSL distro) workspace keeps its own bucket so local entries never leak into remote ones
- **Retry backoff no longer fights the compositor**: the sidebar and tab status dots and the thinking indicators stay visible but stop animating during a provider retry backoff (via a reference-stable retrying map that only changes when the backoff really starts or ends), and interrupt/delete now clears retry / streaming / retrying flags so keys do not linger after a session is deleted
- **The session-parse cache counts tool output in its memory budget**: the old accounting only measured text and images, underestimating tool-result-heavy sessions several times over and making the 128 MB budget meaningless; args, results, usage, todos, and message path/model/effort fields are now counted recursively so the cap actually holds
- **Subtasks no longer vanish across pages after a turn ends**: subtask and subagent rows settle to "Completed" once the conversation ends instead of disappearing across pages, sticking at running, or leaving the breathing dot animating forever
- **Model names in message metadata drop provider and plugin prefixes**: only the final path segment is shown
- **One paste no longer takes the previous input with it on undo**: pasting goes through insertHTML and occupies its own undo step
- **Sparse checkouts no longer report deletions**: the file tree and changes list filter non-materialized entries by the index skip-worktree bit, so a sparse checkout no longer shows "hundreds of uncommitted changes / −100,000 lines"; when the rules exclude everything and the checkout is empty, worktree creation returns an explicit error, cleans up the half-made directory, and does not register an empty workspace
- **Packaged plugin styles are no longer blocked by the CSP nonce**: the boot placeholder moved from an inline style in index.html to the external public/boot.css — an inline tag makes Tauri add a nonce to style-src, which disables 'unsafe-inline' and rejects every runtime-injected stylesheet (plugins kept activating with all styling gone); a guard test now forbids inline style/script in index.html
- **Plugin exec children could not find their interpreter**: plugin_exec_run / spawn inject the CLI search directories into the child PATH (appended after — and order-deduped with — any PATH the plugin supplied), fixing #!/usr/bin/env node shims that failed with "env: node: No such file or directory" under a launchd-style PATH and silently produced no output; the engine spawn path gets the same treatment
- **Plugin bootstrap no longer aborts**: Tauri 2.11 defines __TAURI_INTERNALS__.invoke as a read-only property, and assigning to it threw and stopped plugin loading at the first retry; the wrapper is now installed through the property descriptor when possible and only warns when it cannot be, and a WebView2 without Promise.withResolvers no longer aborts the retry loop
- **OMP's Google channel is no longer rejected**: Google APIs (google-generative-ai / google-gemini-cli / google-vertex) no longer carry the generic reasoning fields Cloud Code Assist rejects, while the native thinkingConfig is preserved
- **Chat sidebar and Git changes list scroll and pagination**: the changes list container gains min-h-0 + overscroll-contain, the sticky summary bar and group headers get proper stacking (no longer hidden behind rows), row buttons use Tooltips, and sidebar thread pagination resets to page 0 on re-expand instead of changing page height mid-collapse
- **The Worktree group animates like its children**: the group switched from conditional rendering to a 300ms grid-template-rows 1fr ⇄ 0fr transition (unmounting only after the collapse animation, with the region aria-hidden + inert), so it no longer pops in and out in a single frame

🧹 Internal
- Three new Rust modules: git_worktree (list / create / cancel / remove, merge checks, PR resolution and pull-ref checkout), pets (package import with decode caps), and pet_overlay (transparent window and hit testing); the workspaces table gains an additive kind / parent_id migration, and legacy workspaces.json worktree children are reattached to their parent's db id after it is inserted, skipping children whose directory is gone
- Windows: a unified embedded manifest plus the Win32_UI_WindowsAndMessaging feature; Windows CI now only compiles the Rust tests because the computer-use dependencies make the lib-test executable fail to load on the runner (0xc0000139), and the git discard tests pin core.autocrlf=false
- Removed the drag-to-authorize path (computer_use_drag_source, the tauri-plugin-drag dependency, and drag:default), leaving macOS authorization with only the "Open System Settings" deep link; the pet overlay window joins the capability set
- Plugin SDK docs spell out the exec PATH injection contract and sdk-api.md is regenerated; a new tests/browser/sidebar-collapse.html samples frames of the group and child expand/collapse (≥3 intermediate frames each way); ui-ux-spec is up to v0.52 (expand/collapse motion §2.4, desktop pet §4.3, multi-question cards, the worktree chain, crash fallbacks, remote branches, and computer-use rules)
- Docs: a new worktree interaction mockup and implementation notes; a refactor extracts hooks and subcomponents out of GeneralSection / QuestionCard / RunStatusStrip / WorktreeCreateDialog / DeleteWorktreeDialog / PetOverlayApp / repo-tree / workspace-context-menu without behavior changes`,
    },
  },
  {
    version: "1.0.8",
    date: "2026-09-23",
    content: {
      zh: `✨ 新功能
- **设置新增「能力扩展」分组**：Skills（我的 Skills / 发现 / 使用情况）与 MCP（配置 / 运行时）两个管理页，放在 CLI 管理之后；页面懒加载，普通设置页不扫描技能、不读 MCP 配置、不联网，支持 ?page=skills / ?page=mcp 深链；远程 Web 端只显示桌面端提示，不渲染无效界面
- **Skills 覆盖全部已接入 CLI**：同步目标从 Claude / Codex 扩到 Kimi / Grok / PI / OMP / DeepSeek / Antigravity / Gemini / OpenCode / Qoder / Qoder CN / Hermes 与跨 agent 的 ~/.agents，各自尊重本 CLI 的 home 环境变量与设置页覆盖，home 不存在时隐去；「纳管」记录并保护用户本地来源目录，不再用受管副本覆盖它，更新前比对托管副本哈希，本地有修改时拒绝覆盖并要求显式确认；移除用户自己目录里的副本时如实返回「已保留」，不谎报已移除
- **技能行与详情面板**：行内同步态改为可点的引擎图标（彩色 = 已同步、红点 = 副本丢失，且只渲染真有副本的引擎），点击即移除该引擎副本或重同步丢失的副本，未纳管技能自己目录里的副本禁用取消；详情页新增「活动情况」与带图标的「同步到」列表，「从所有 Agent 移除 / 更新 / 关闭」固定在面板底部，多引擎列表自带限高滚动
- **技能发现页可看详情**：行主体点开对话框，按需回仓库读取 SKILL.md（描述 + 正文 + 安装），列表不预取以免撞限流；读不到时给出说明、仓库入口与重试；skills.sh 的 id 与仓库目录名按「同名 / 去仓库前缀 / 冒号转横线」对齐，修掉 vercel-labs 这类条目的 SKILL.md not found
- **MCP 页覆盖全部引擎**：声明式来源表从 Claude / Codex 扩到 Kimi / Grok / OMP / OpenCode / Antigravity / Qoder / Qoder CN / dsh，PI 显式标注不内置 MCP；读取只解析文件、不启动 CLI；写入只对在本机真实 CLI 上验证过语义的来源开放（Grok 的 enabled + disabled_mcp_servers 双向同步、OpenCode 的 enabled），JSONC 因写入会丢注释降级为只读，其余来源返回可本地化的原因码；引擎行改用与 Skills 同形的 Chip + 品牌图标 + 配置条数，范围筛选（全部 / 配置 / 运行时），页签支持 ?page=mcp&engine=<id> 深链
- **输入框 /mcp 面板**：斜杠选择器新增内置行，提交 /mcp 也直接弹出面板，按当前会话引擎列出配置与运行时清单，与设置页共用同一份 mcp_inventory 数据，可刷新、可启停可写来源，并可深链到设置页对应引擎
- **MCP 连接状态检测**：后端按配置里的真实命令 / 地址启动或连接一次，完成 initialize + tools/list 握手后整组回收进程（stdio 25s / HTTP 12s 超时，命令与 env 一律从配置文件重新解析）；行内显示「已连接 · N 工具 / 需要登录 / 连接失败」徽标，支持单条检测与「检测全部」，详情弹窗给出原因、服务名、协议、工具名、耗时与检测时间；打开页面即自动检测，结果按「条目 id + 配置哈希」缓存 3 分钟、最多 4 个并行，配置改了只补变化的条目，停用条目不检测，标题行显示「状态更新于 HH:MM」
- **Claude 用户级 / local MCP 就地启停**：写 ~/.claude.json 的 projects[工作区].disabledMcpServers，与 Claude Code TUI 的「停用（本项目）」同一把开关，不改服务定义；无活动工作区时降级只读并说明原因
- **版本更新说明改为原生中心页签**：发现新版本自动打开该页签（排在页签条最尾，不抢已在视的插件中心 / 任务工作台），状态栏版本号与命令面板「查看版本更新说明」打开同一页签；正文优先渲染更新清单 notes，缺失时回落本地同版本条目，都没有时明说未附带说明；页头新增「检查更新」（转圈 → 对号，失败不出对号），结果行与设置页共用同一份文案，按版本翻页的旧版本记录弹窗随之下线
- **大任务卡顿修复**：连续同 run 的工具事件按原顺序归并后再写 store（128 start + 128 args + 128 result 由 384 次写入降为 1 次），混合事件、终态与切换会话前先提交，文本与工具结果不丢；过程组有界展示（每页 40 项、默认最新页、读历史不被新增抢页，搜索命中可展开跳页）；未跟踪文件行统计限定 1 MiB / 100k 行，NUL 二进制、符号链接、FIFO 与超限文件返回 unknown，不再伪造截断后的精确值
- **本地性能诊断**（默认开启，无自动上传）：原生独立线程低频采样系统 CPU / 内存 / swap、主进程与后代进程，并明确标注归属不明的 WebKit 候选；前端按 5 秒窗口聚合事件数、批处理与提交耗时、前台事件循环延迟与会话 / 消息规模，不逐 token 写日志；状态栏「性能」与设置入口打开同一只读弹窗，可复制摘要（12 KB 上限）或导出完整 JSON，偏好原子持久化并跨窗口广播，关闭即停止采样并清空记录；另引入 react-scan 作为可选渲染高亮面板（默认关闭，入口前先完成 hook）
- **终端路径链接改为修饰键点击**：普通单击不再唤起文件管理器，macOS 用 ⌥+点击、Windows / Linux 用 Ctrl+点击（对齐 Windows Terminal / GNOME Terminal 的开链习惯），避免选中文本或点回终端时误触；右键菜单的「在访达中显示」保持不变
- **插件会话模式（SDK 0.3.14）**：新增 ui:conversation-mode 扩展点与 ConversationModeHost 挂载点，插件可在会话内替换聊天内容区与输入框，并能报告忙碌以锁定宿主退出，活动标签关闭与替换草稿的引擎切换同样受阻断；只读规划与接力 MVP 的双节点状态机、交接协议放在独立 ESM 插件内，不侵入普通 chat store
- **只读与请求身份（SDK 0.3.14）**：ctx.agent.catalog 返回清洗后的 Agent 目录（只含可用性、只读能力与渠道 / 模型 ID，不返回配置与凭据）；agent.start 支持 readOnly 与 requestId（调用前即可持久化预期 runId），interrupt 返回是否命中活动 run；只读能力以原生实现为准（fail-closed），目前仅 Pi 支持隔离只读调用，Codex 明确不宣称
- **生成速度计量（SDK 0.3.15）**：usage / done 事件新增 genMs（宿主实测生成窗口毫秒数），只统计响应流打开到关闭，工具执行、用户等待与轮间空闲全部排除；插件按 output token ÷ genMs 即得不含工具等待的生成速度，字段缺失时回退旧的相邻报告口径，插件无需版本门槛

🐛 修复
- skills_hub_mutate 之前把整个参数包平铺传递，所有 mutation 都报 missing required key payload；现按 { action, payload } 拆分
- Skills 详情面板：使用统计读取失败时显示「使用统计暂不可用」并把调用次数 / 上次使用显示为 —，不再误报「从未使用 / 尚未调用」
- MCP 检测健壮性：一次 read 带回多行（日志 + 响应）时改用带缓冲的行读取，不再丢后续数据；本机回环地址绕开环境代理，不再因 HTTP_PROXY 变成 502；环境变量占位符（含 :- 默认值）按 CLI 习惯展开；缺 status 字段的响应不当作已连接，坏响应不再把列表画崩
- 行内同步态只画真有副本的引擎：一份技能在 13 个引擎里通常只剩 1~2 个图标，不再每行铺淡图标

🧹 内部优化
- Rust 后端新增 mcp 模块（config / probe / runtime / 声明式 sources）与 skills_hub 模块（core / discover / fsutil / http / lifecycle），配套 34 项 mcp 与 29 项 skills_hub 单测；引擎 reader 统一收口生成窗口统计
- 文档：新增能力扩展迁移（Skills / MCP）、性能修复与诊断、macOS 大任务 CPU 排查、计划-执行接力四份实施计划；plan-execute SOP V1 / V2 可交互原型与 jsdom 回归；ui-ux-spec 更新至 v0.42
- SDK 契约变更同步再生成 sdk-api.md 与 SDK CHANGELOG，一致性测试随源码校验`,
      en: `✨ Features
- **New "Capabilities" group in Settings**: Skills (My Skills / Discover / Usage) and MCP (Config / Runtime) management pages, placed after CLI management; pages load lazily so ordinary settings pages never scan skills, read MCP configs, or go online, with ?page=skills / ?page=mcp deep links; a remote WebUI shows a desktop-only notice instead of dead controls
- **Skills cover every integrated CLI**: sync targets grow from Claude / Codex to Kimi / Grok / PI / OMP / DeepSeek / Antigravity / Gemini / OpenCode / Qoder / Qoder CN / Hermes plus the cross-agent ~/.agents, each respecting its CLI's home env and Settings override and hidden when that home is missing; "adopt" records and protects the user's own source directory instead of overwriting it with a managed copy, updates compare the managed copy's hash and refuse to overwrite local edits without explicit confirmation, and removing a copy from the user's own directory reports "kept" instead of claiming it was deleted
- **Skill rows and detail panel**: the inline sync state becomes clickable engine icons (colored = synced, red dot = orphaned, and only engines that actually have a copy render), where clicking removes that engine's copy or re-syncs a lost one, while a copy in the user's own directory cannot be cancelled; the detail page gains an activity summary and an icon list for "sync to", with "Remove from all agents / Update / Close" pinned at the bottom and the engine list scrolling on its own
- **Discover page shows skill details**: clicking a row opens a dialog that fetches SKILL.md from the repo on demand (description + body + install) — the list never prefetches, which would hit rate limits — with an explanation, repo link, and retry when it cannot be read; skills.sh ids and repo directory names align by "same name / strip repo prefix / colon to dash", fixing SKILL.md not found for vercel-labs-style entries
- **MCP page covers every engine**: the declarative source table grows from Claude / Codex to Kimi / Grok / OMP / OpenCode / Antigravity / Qoder / Qoder CN / dsh, with PI explicitly marked as not built-in; reading only parses files without launching CLIs; only sources whose semantics were verified against the real CLI are writable (Grok's enabled + disabled_mcp_servers two-way sync and OpenCode's enabled), JSONC files degrade to read-only because writing would drop comments, and every other source returns a localizable reason code; engine rows use the same Chip + brand icon + config count as Skills, with an all / config / runtime scope filter and ?page=mcp&engine=<id> deep links
- **Composer /mcp panel**: the slash picker gains a built-in row and submitting /mcp opens the same panel, listing config and runtime entries for the current session's engine from the same mcp_inventory the Settings page uses, with refresh, enable/disable for writable sources, and a deep link back to Settings
- **MCP connection probing**: the backend starts or connects once with the command/address from the config, performs an initialize + tools/list handshake, then kills the whole process group (25s stdio / 12s HTTP timeouts; command and env are always re-resolved from config files); rows show Connected · N tools / Login required / Connection failed badges with per-row and "check all" actions, and the detail dialog reports reason, service name, protocol, tool names, duration, and timestamp; opening a page probes automatically with results cached by entry id + config hash for 3 minutes and at most 4 probes in flight, re-probing only entries whose config changed, skipping disabled ones, and showing "status updated at HH:MM"
- **Claude user/local MCP can be toggled in place**: enable/disable writes projects[workspace].disabledMcpServers in ~/.claude.json — the same switch as Claude Code TUI's "Disable (this project)" — leaving the server definitions untouched, and degrades to read-only with a reason when no workspace is active
- **Release notes become a native center tab**: a new version opens the tab automatically (last in the tab strip, never stealing the plugin hub or task workbench already in view), and the status-bar version button and the command palette open the same tab; the body renders the update manifest's notes first, falls back to the matching local CHANGELOG_DATA entry, and says so explicitly when neither exists; the header gains an in-place Check for updates (spinner → check, no check on failure) sharing the Settings result line, and the old paged release-notes dialog retires
- **Large-task jank fixes**: consecutive tool events of the same run are coalesced in order before hitting the store (128 start + 128 args + 128 result drop from 384 writes to 1), with mixed events, terminal states, and session switches flushing first so no text or tool result is lost; process groups render in bounded pages of 40 (newest first, reading history is never yanked back by new arrivals, and search hits can expand and jump); untracked-file line stats are capped at 1 MiB / 100k lines, with NUL binaries, symlinks, FIFOs, and over-limit files returning "unknown" instead of a fabricated exact count
- **Local performance diagnostics** (on by default, never auto-uploaded): a dedicated native thread samples system CPU / memory / swap, the main process and its descendants, and clearly-labelled WebKit candidates at a low rate; the front end aggregates 5-second windows of event counts, batching and commit time, foreground event-loop delay, and session/message scale without logging per-token; the status bar's Performance entry and Settings open the same read-only dialog, which can copy a summary (12 KB cap) or export the full JSON — the preference persists atomically and broadcasts across windows, and turning it off stops sampling and clears records; react-scan is available as an optional render-highlight panel (off by default, hooked before first import)
- **Terminal path links require a modifier**: a plain click no longer reveals in the file manager — macOS uses ⌥+click and Windows/Linux Ctrl+click (matching Windows Terminal / GNOME Terminal), avoiding accidental reveals while selecting text or clicking back into the terminal; the context-menu "Reveal in Finder" is unchanged
- **Plugin conversation modes (SDK 0.3.14)**: a new ui:conversation-mode extension point and ConversationModeHost mount let a plugin replace the chat body and composer inside a session and report busy state to lock the host's exit, with active-tab close and draft engine switches blocked too; read-only planning and the relay MVP's two-node state machine and handoff protocol live in a separate ESM plugin and never touch the normal chat store
- **Read-only and request identity (SDK 0.3.14)**: ctx.agent.catalog returns a sanitized agent directory (availability, read-only capability, and provider/model ids only — never config or credentials); agent.start accepts readOnly and requestId (so plugins can persist the expected run id before launching) and interrupt returns whether it hit an active run; read-only capability is native-backed and fail-closed, currently Pi only, and Codex explicitly does not claim it
- **Generation-speed measurement (SDK 0.3.15)**: usage / done events now carry genMs, the host-measured generation window in milliseconds from stream open to close with tool execution, user waits, and inter-turn idle excluded; plugins compute output tokens ÷ genMs for a real generation speed and fall back to the old adjacent-report timing when the field is absent, so no plugin needs a version gate

🐛 Fixes
- skills_hub_mutate passed the whole argument bag flat, so every mutation failed with "missing required key payload"; it now splits into { action, payload }
- The Skills detail panel shows "usage stats unavailable" and renders call count / last used as — on read failure instead of falsely reporting "never used / not yet called"
- MCP probing robustness: a single read carrying multiple lines (log + response) now uses buffered line reads instead of dropping the remainder; loopback addresses bypass the environment proxy so HTTP_PROXY can no longer turn 127.0.0.1 into a 502; environment-variable placeholders (including :- defaults) expand the way CLIs do; a response missing status is no longer treated as connected, so a bad response cannot break the list
- Inline sync state only draws engines that actually have a copy — a skill usually has 1–2 icons across 13 engines, not a row of dim placeholders

🧹 Internal
- Backend: new mcp module (config / probe / runtime / declarative sources) and skills_hub module (core / discover / fsutil / http / lifecycle) with 34 mcp and 29 skills_hub unit tests; the engine reader consolidates generation-window accounting
- Docs: new plans for the skills/MCP migration, performance fixes and diagnostics, the macOS large-task CPU investigation, and the plan-execute relay; an interactive plan-execute SOP V1/V2 prototype with jsdom regression tests; ui-ux-spec updated to v0.42
- SDK contract changes regenerate sdk-api.md and the SDK CHANGELOG, with a consistency test verifying them against the source`,
    },
  },
  {
    version: "1.0.7",
    date: "2026-09-23",
    content: {
      zh: `✨ 新功能
- **插件中心升级为原生页签**：插件管理与市场从设置页迁入中央页签（市场 / 已安装 / 详情 / 开发指南），侧栏新增「插件」入口；已安装列表可就地重新加载，插件更新后原地热重载，无需关开插件或重启应用
- **插件市场重做**：分类 chips（带计数）与排序 / 搜索 / 刷新工具条，列表改表格（名称 / 开发者 / 安装量 / 版本 / 操作），整行可点进详情；支持官方与社区插件的标识和筛选，开发者头像改用 GitHub 真实头像
- **插件详情整页化**：左正文 + 右 sticky 信息栏；截图轮播支持灯箱、方向键与加载失败占位，README 以与文件预览相同的安全姿态渲染（相对图片 / 链接补全为仓库地址）；权限默认展示前 4 项、可展开全部，「最近更新时间」读索引登记值
- **插件图标与效果图**：索引与本地 manifest 均支持 icon / screenshots（索引优先、安装清单兜底），市场安装时把品牌图写入插件目录，插件页签与插件设置页导航离线也能取到图标；新增路径受限的 plugin_read_artwork 读取插件自有素材（符号链接逃逸与越界路径拒绝）
- **「创建插件」与内置开发 skill**：插件中心页头一键开新会话并预填 /ccgui-plugin-creator（光标落到输入框末尾），AI 按内置指南生成可直接安装的插件目录；skill 随应用打包并同步进 Claude / Codex / ~/.agents，SDK 参考文档由源码生成并加一致性测试
- **内测功能开关**（设置 → 其他 → 内测功能，默认关闭）：新增 betaFeatures 设置与开关页，「新建浏览器」入口按开关显隐
- **设置页**：检查更新独立为模块并置于社区与反馈之前；有更新时提示浮在设置页之上，行内显示「发现新版本 vX」与「立即更新」，下载 / 安装阶段同步进度；导航改为 Codex 风格静态分组（侧栏 300px），CLI 管理 / 未安装 / 未启用三组标题可折叠（未安装 / 未启用默认收起，搜索与深链自动展开）
- **聊天流式体验**：正文与思考面板按到达节奏逐帧揭示，不再整批闪现；思考区保留完整已揭示文本，去掉 2000 字尾窗导致的整行消失
- **「已编辑」行数恢复逐位滚动**：新增 RollingStat odometer（纯 CSS transition，无 mask / blend-mode），从 0 起滚、位数增长时向左扩张，系统开启「减少动态效果」时直接跳变
- **浮动滚动控件**：按滚轮方向显示「回到顶部 / 回到底部」，点击平滑滚动；流式长高不打断过渡，用户向上接管后不再回钉
- **文件树刷新**移入工作区根行，悬停或键盘聚焦时出现，反馈仍是转圈 → 对号
- **Git 树状态聚合**：新增 git_tree_status 一次扫描多级目录并缓存仓库状态，替代逐目录往返；变更面板接入并按可见性刷新
- **会话搜索**：排序改为「标题 / 内容」通道过滤，后端固定 bm25 相关性 + 更新时间排序

🐛 修复
- 有会话运行时 ⌘Q / 系统退出被拦住：macOS applicationShouldTerminate 返回取消并复用既有二次确认，不再整端静默退出；退出时销毁 Computer Use 覆盖层窗口，避免无窗口悬挂
- output_config.effort 只注入 anthropic-messages 请求，OpenAI / OpenRouter 不再收到 Anthropic 推理强度字段
- 插件市场与详情页：已安装页也会拉取索引（图标 / 效果图不再只靠市场页）；右栏限高并可滚动到「链接」行；README 长代码行留在正文列内横向滚动；截图大图补关闭叉号并修好点空白关闭；官方徽标可点击跳转主页、不再被右栏拉成整行；「链接」三项各带目标图标；权限行改称「权限（CCGUI权限）」
- 中心面切换统一清场：新建会话 / 点击会话 / 打开文件 / 新建浏览器 / 插件页签之间互斥，页签高亮与画面保持一致
- 远程 Web 端：桥接 answer_question / git_discard / plugin_read_artwork，目录授权卡不再渲染无法生效的「允许访问」，改为原因说明与拒绝

🧹 内部优化
- 后端：任务工作台（流程编排 / 流程列表 / 收件箱与运行前执行环境选择）已落地，入口内测暂未放开、本版对所有用户隐藏；quit_guard 拦截退出；npm prefix 探测增加超时、输出上限与子进程回收（含 Windows 任务对象）；list_engines 移出 IPC 处理线程
- 前端：新增 center-surfaces 中心面互斥与 action-feedback（运行 → 对勾）公共反馈；mission 调度 / 设置导航 / 插件详情与已安装行 / 变更面板等处把重复线性查找改为 Map 索引，大组件拆分子组件，清理 render 期 ref 写入与首挂 setState；已编辑行统计改为增量缓存
- 文档与工程：新增 docs/ui-ux-spec.zh-CN.md（刷新 / 复制反馈、动效降级、刷新入口清单），插件开发指南补图标与效果图规范；pnpm plugin-skill:docs 由 TS AST 生成 SDK 参考并加一致性测试；Cargo.lock 与 package.json / Cargo.toml / tauri.conf.json 版本同步`,
      en: `✨ Features
- **Plugin hub becomes a native center tab**: plugin management and the marketplace move out of Settings into center tabs (Market / Installed / Detail / Guide) with a new Plugins entry in the sidebar; the installed list can be reloaded in place, and updated plugins hot-reload without toggling them off or restarting the app
- **Marketplace rework**: category chips with counts plus a sort / search / refresh toolbar, and a table list (name / developer / installs / version / actions) where the whole row opens the detail page; official and community plugins are labelled and filterable, and developer avatars come from GitHub
- **Full-page plugin detail**: README and screenshot carousel on the left, a sticky info rail on the right; the carousel supports a lightbox, arrow keys, and a failed-load placeholder, the README renders with the same safety posture as file preview (relative images/links resolve against the repo), permissions show the first four items with expand-all, and "last updated" reads the index timestamp
- **Plugin icons and screenshots**: both the index and a local manifest accept icon / screenshots (index wins, install manifest is the fallback); marketplace installs write the brand image into the plugin directory so panel tabs and plugin settings nav show an icon offline, and the path-restricted plugin_read_artwork reads plugin-owned artwork (symlink escapes and out-of-tree paths rejected)
- **"Create plugin" and a bundled dev skill**: the hub header opens a new session prefilled with /ccgui-plugin-creator (cursor lands at the end of the composer), where AI follows the bundled guide to generate an installable plugin directory; the skill ships with the app and syncs into Claude / Codex / ~/.agents, and the SDK reference is generated from source with a consistency test
- **Beta features toggle** (Settings → Other → Beta features, off by default): a new betaFeatures setting page gates the new-browser entry
- **Settings**: Check for updates becomes its own module ahead of Community & feedback; when an update exists the toast floats above Settings with an inline "vX available" and "Update now", showing download/install progress; the nav uses Codex-style static groups (300px rail) with collapsible CLI management / not-installed / disabled headers (the latter two start collapsed; search and deep links expand them)
- **Streaming chat**: assistant text and the thinking panel reveal at the arrival rhythm instead of dumping whole batches, and the thinking panel keeps all revealed text (the 2000-character tail window that made lines vanish is gone)
- **Edited-line stats roll digit by digit again**: a new RollingStat odometer (pure CSS transitions, no mask/blend-mode) starts from 0, grows leftward as digits are added, and snaps under reduced motion
- **Scroll control**: the floating button follows the wheel direction between "back to top" and "back to bottom" and scrolls smoothly, without breaking while streaming content keeps growing or when the user takes over
- **File-tree refresh** moves onto the workspace root row, appearing on hover or keyboard focus with the same spinner → check feedback
- **Git tree status aggregation**: a new git_tree_status scans nested directories once and caches repo status, replacing per-directory round trips; the changes panel consumes it and refreshes on visibility
- **Session search**: sorting becomes a Title / Content channel filter, with bm25 relevance plus updated_at order fixed on the backend

🐛 Fixes
- ⌘Q / system quit is now intercepted while runs are active: macOS applicationShouldTerminate is cancelled and reuses the existing confirmation instead of silently taking the whole app down, and the Computer Use overlay window is destroyed on quit so the process no longer hangs with no windows
- output_config.effort is injected only into anthropic-messages requests, so OpenAI / OpenRouter no longer receive Anthropic's reasoning-effort field
- Marketplace and detail page: the Installed tab now fetches the market index (icons/screenshots no longer depend on visiting the market); the info rail is height-capped and scrolls to the links row; long README code lines scroll inside the content column; the screenshot lightbox gains a close button and backdrop-click dismissal works; the official badge links to the profile and no longer stretches across the rail; the three link rows carry destination icons; the permissions row is renamed "Permissions (CCGUI)"
- Center surfaces clear each other consistently: new session / session click / open file / new browser / plugin tabs are mutually exclusive, keeping tab highlight and visible content in sync
- Remote WebUI: the bridge gains answer_question / git_discard / plugin_read_artwork, and the directory-grant card no longer offers an "Allow access" that cannot take effect — it explains why and refuses

🧹 Internal
- Backend: the task workbench (flow studio / flow list / inbox and pre-run execution environment) has landed, but its entry stays hidden for everyone in this release while in beta; quit_guard blocks quit; npm prefix probing gains a timeout, output cap, and subprocess reaping (including Windows job objects); list_engines moves off the IPC handler thread
- Frontend: new center-surfaces mutual exclusion and the shared action-feedback (running → check) component; repeated linear lookups become Map indexes across mission scheduling, Settings nav, plugin detail/installed rows, and the changes panel; large components split; render-phase ref writes and first-mount setState removed; edited-line stats cache incrementally
- Docs & tooling: new docs/ui-ux-spec.zh-CN.md (refresh/copy feedback, motion fallbacks, refresh-entry inventory) and icon/screenshot guidance in the plugin development guide; pnpm plugin-skill:docs generates the SDK reference from the TS AST with a consistency test; Cargo.lock and all three version files synced to 1.0.7`,
    },
  },
  {
    version: "1.0.6",
    date: "2026-09-22",
    content: {
      zh: `✨ 新功能
- **会话内容全文搜索**：⌘L 搜索弹窗在标题匹配之外新增消息正文匹配（FTS5 trigram 索引 + 后台增量索引），支持相关性 / 最近排序与索引进度提示，短词回退 LIKE 精确匹配
- **会话内搜索**：⌘F 在当前会话中查找消息并逐条跳转高亮，快捷键可在设置中改绑
- **内置斜杠命令**：/new、/clear、/compact 由前端直接处理，斜杠选择器新增「内置」分组；同名 catalog 命令仍优先，压缩期间状态条显示 Compacting context…
- **提问卡片打通更多引擎**：Codex / Grok 走 CLI 自有传输（app-server / ACP），Kimi 走 ACP elicitation 表单，pi 由内置 ask-bridge 扩展提供 ask_user 工具，omp 切 rpc-ui 模式，DSH 与 OpenCode 分别经 $events/result 与托管 server 应答
- **多选题轮次体验重做**：选项可再次点击取消，单选答完自动跳到下一道未答题，未答完时 Enter 跳题并提示剩余题数；多选在本地收集后一次提交（失败可回退重答）；协议只接受预置选项时不渲染自由输入
- **推理强度全引擎贯通**：所有 CLI 统一注入请求级 effort，并原样下发（xhigh / ultra 不再被改写成 max / high）；新建会话默认 medium，修复切换推理强度实际不生效
- **幕布显示真实模型与档位**：读取 run 实际上报的 model / effort，不再沿用虚假的初始请求参数
- **设置页改为全屏**：覆盖层弹窗换成全屏 SettingsShell，侧栏支持搜索过滤与分组折叠（折叠状态持久化），重新分组为系统 / 插件 / CLI 管理 / 工作区与数据 / 其他，未安装与未启用独立成组
- **变更面板撤销更改**：未暂存与未跟踪文件支持单个撤销与「全部撤销」，均经危险确认；索引内文件等价 git restore --worktree，未跟踪文件等价 git clean，已暂存组不提供撤销
- **变更面板跟随嵌套仓库**：跟随文件树选中进入子仓库时，头部显示仓库名徽标，避免在不知情下对非根仓库 stage / commit
- **终端增强**：输出中的绝对路径可点击在文件管理器中显示；选中文本支持右键复制
- **用量统计新增本年 / 总和**：总和读取全部台账（不再被 365 天窗口截断），图表横轴随之切换——本年按月、总和按 CLI 分柱
- **渠道选择器改进**：供应商改为限定高度下拉框并支持输入筛选，切换渠道立即刷新该渠道映射的模型，无渠道引擎不再显示空筛选框，引擎面板改为点击切换以免误换面板
- **DSH 图片附件**：支持粘贴 / 选择 / 拖入图片；自定义 llm-pi-ai 路由由 ccgui 在发送前自动声明图片输入能力
- **Linux 新增 .rpm 安装包**（zstd 压缩，需 rpm ≥ 4.14），README 增补十引擎功能兼容矩阵
- **插件 SDK 0.3.12 / 0.3.13**：新增侧栏导航项（ui:sidebar-entry）、中心页签（ui:center-tab）与插件 agent 轮次（agent 权限，事件走独立 plugin-agent://event 流，不被聊天 Stop 误杀）；新增 @ccgui/plugin-ui 共享组件库
- 打开 .md 文件默认进入预览模式；CSP 放开 https: 图片，远程图片可直接显示

🐛 修复
- 选中文字后拖动导致页面锁死：显式释放 pointer capture，拖拽结束时清理 window 事件监听器
- 并发槽位泄漏：任务 panic 或被丢弃时经 Drop 兜底清理 run 条目与虚拟运行守卫，不再钉住槽位直到应用退出（too many concurrent runs）
- 插件启动期拿不到当前会话：会话激活事件支持粘性回放，引擎选择器切换待发会话时也会广播
- pi stdin 缺终止换行导致解析失败的警告横幅
- 上游 400 错误横幅显示原始 JSON：改为可读文案
- 变更面板未跟踪文件预览为空；diff 移出 IPC 主线程并加 2 MiB 上限，大文件不再阻塞界面
- git 远程认证失败返回误导性的 libgit2 报错：改为可操作错误，并正确解析 macOS osxkeychain 凭据助手
- 分支下拉菜单在外部 checkout 后点击无效：改用实时分支名判断当前分支
- 拉取 / 推送按钮补齐与刷新一致的成功对号反馈
- 远程 WebUI 窄屏下右侧文件面板被裁掉一半：改为整行宽浮层展开
- 变更面板行布局简化：状态 | 路径 | 自适应 stats，去掉空置尾列
- Windows CI 换行与路径转义相关测试修复；内置智能体提示词固定 LF，发布流程补哈希门禁
- react-doctor 体检问题全量修复（评分 76 → 100）

🧹 内部优化
- 后端：引擎新增 Transport / host_command 抽象与 set_stdin，codex / grok / kimi / opencode 拆出独立会话适配模块；历史新增 FTS5 检索
- 前端：设置壳层重写，时间线搜索抽为 useTimelineSearch，中心页签抽为 center-tabs，render 期 ref 写入全部移入 effect
- 仓库清理：移除入库的 CI 验证产物（约 52 MB）并加入 .gitignore；渠道家族模型映射改按 ANTHROPIC_DEFAULT_*_MODEL 的 key 模式派生
- CI：新增 PR 目标分支守卫（非发布分支禁止直提 main）与 PR 模板，Windows 发布打包前先跑 cargo test --lib
- Computer Use 后端能力落地（OMP 的 MCP 注入、macOS AX 无障碍树交互、虚拟光标覆盖层），前端入口因尚未打磨好暂先下线`,
      en: `✨ Features
- **Full-text search across messages**: the ⌘L palette now matches message bodies on top of titles (FTS5 trigram index with background incremental indexing), with relevance/recency sorting and an indexing-progress hint; short tokens fall back to a LIKE exact match
- **Search within a session**: ⌘F finds messages in the open session and steps through matches with highlighting; the shortcut is remappable in Settings
- **Built-in slash commands**: /new, /clear, and /compact are handled by the front end, with a new "Built-in" group in the slash picker; same-named catalog commands still win, and compaction shows "Compacting context…" in the status bar
- **Question cards reach more engines**: Codex and Grok answer through their own transports (app-server / ACP), Kimi through ACP elicitation forms, pi via the bundled ask-bridge extension exposing an ask_user tool, omp in rpc-ui mode, and DSH / OpenCode through $events/result and managed-server replies
- **Multi-select rounds reworked**: options can be deselected, a single-select answer advances to the next unanswered question, Enter jumps ahead when questions remain (with a remaining-count hint), multi-select answers are collected locally and submitted as one batch with rollback on failure, and cards omit free-text input when the protocol accepts declared options only
- **Reasoning effort across every engine**: request-level effort injection for all CLIs, passed through verbatim (xhigh / ultra are no longer rewritten to max / high); new sessions default to medium, fixing switching that silently did nothing
- **Curtain shows the real model and effort**: it reads the run's reported model/effort instead of the original request parameters
- **Fullscreen Settings**: the overlay modal becomes a fullscreen shell with rail search, collapsible groups whose state persists, and regrouping into System / Plugins / CLI management / Workspace & data / Other, with not-installed and disabled CLIs as their own groups
- **Discard changes**: unstaged and untracked files can be discarded one by one or via a group-level "Discard all", both behind a danger confirmation (tracked files restore the worktree, untracked files are deleted, the staged group offers no discard)
- **Changes panel follows nested repos**: when the panel follows the file tree into a submodule it shows a repository badge, so a stage/commit never silently targets a non-root repo
- **Terminal improvements**: absolute paths in output are clickable and reveal in the file manager; selected text has a right-click copy menu
- **Usage: this year / all time**: the all-time range reads the whole ledger (no longer truncated at 365 days) and the chart re-bases its axis — per month for the year, per CLI for all time
- **Channel picker improvements**: providers move into a height-capped, filterable dropdown, switching a channel refreshes that channel's mapped models immediately, engines without channels no longer render an empty filter box, and the engine panel switches on click instead of hover
- **DSH image attachments**: paste, pick, or drop images; for custom llm-pi-ai routes ccgui declares image input before sending
- **Linux .rpm package** (zstd-compressed, requires rpm ≥ 4.14), plus a ten-engine feature compatibility matrix in the README
- **Plugin SDK 0.3.12 / 0.3.13**: sidebar nav entries (ui:sidebar-entry), center tabs (ui:center-tab), and plugin agent runs (agent permission; events on a separate plugin-agent://event stream that chat's Stop cannot kill); new shared @ccgui/plugin-ui component package
- .md files open in preview mode by default; the CSP allows https: images so remote images render

🐛 Fixes
- Dragging selected text could lock the page: pointer capture is released explicitly and window listeners are cleaned up when a drag ends
- Concurrent-slot leak: panicking or dropped runs now clean up through Drop (plus a virtual-run guard), so a stale slot no longer blocks new sessions with "too many concurrent runs"
- Plugins couldn't read the active session during startup: session activation events now support sticky replay and are broadcast when the engine picker switches a pending session
- pi's stdin lacked its terminating newline, producing parse-failure warning banners
- Upstream 400 errors showed raw JSON in the banner; they now render a readable message
- Untracked files previewed as empty; diff generation moved off the IPC thread and is capped at 2 MiB, so large files no longer block the UI
- git remote authentication failures surfaced a misleading libgit2 error; they now return an actionable message and parse the macOS osxkeychain credential helper
- The branch dropdown no-op'd after an external checkout because it compared a stale branch name
- Pull/push buttons now show the same success check feedback as refresh
- A narrow remote WebUI clipped the right-side file panel; it now expands as a full-width overlay
- The changes panel row layout is simplified to status | path | self-sizing stats, dropping the empty trailing column
- Windows CI line-ending and path-escaping tests fixed; bundled agent prompts are pinned to LF with a hash gate in the release workflow
- react-doctor findings fixed across the board (score 76 → 100)

🧹 Internal
- Backend: engines gain a Transport / host_command abstraction with set_stdin; codex, grok, kimi, and opencode move to dedicated session adapters; history gains FTS5 search
- Frontend: settings shell rewritten, timeline search extracted into useTimelineSearch, center tabs extracted, and all render-phase ref writes moved into effects
- Repo hygiene: removed ~52 MB of committed CI verification artifacts and gitignored them; channel family-model mapping now derives from the ANTHROPIC_DEFAULT_*_MODEL key pattern
- CI: PR target-branch guard (non-release branches cannot open PRs against main) with a PR template; Windows releases now run cargo test --lib before packaging
- Computer Use backend landed (OMP MCP injection, macOS AX-tree interaction, virtual-cursor overlay) while the front-end entry is withdrawn for now pending polish`,
    },
  },
  {
    version: "1.0.5",
    date: "2026-09-19",
    content: {
      zh: `✨ 新功能
- **内置浏览器标签页**：应用内打开网页，原生子 webview 渲染；地址栏与页签标题跟随真实导航，target=_blank 链接改为当前页签内打开，页签关闭即销毁 webview
- **会话归档**：侧栏右键菜单归档会话，设置页新增「归档会话」管理面板，可查看与恢复
- **会话搜索弹窗**：侧栏顶栏搜索框退役，改用搜索图标或 ⌘L 打开会话标题搜索弹窗
- **启动脚本**：按工作区配置启动脚本，可从会话工具区快速运行
- **图片预览增强**：图片灯箱查看器，支持消息与附件图片放大浏览
- **工作区右键新建**：文件树与工作区支持右键新建文件 / 文件夹
- **Markdown GitHub 风格 alert**：支持 > [!NOTE] / [!WARNING] 等提示框，极简左边线样式
- **输入框拖拽文件回归**：图片拖入转为附件，其他文件插入 @引用
- **删除确认气泡**：删除会话等危险操作改为就地气泡确认
- **检查更新反馈**：已是最新时明确展示版本号与发布日期，结果不再 2 秒消失
- 侧栏新增置灰的「自动化」入口，悬停 / 点击提示「即将开放」
- 插件 SDK 0.3.11：修复 registerComposerSlot 权限漂移——自 0.3.9 改名后仍校验旧字符串 ui:composer 导致任何声明都被拒绝，改为校验 ui:composer-status

🐛 修复
- 折叠长消息改为裁剪高度，不再残留淡出残影
- 失败会话的历史索引与删除：失败会话可被正确索引并彻底删除
- 长用户消息气泡不再向左溢出
- 上下文用量表盘分子卡在整轮累加值，恢复实时按 token 更新
- 引擎进程注册表泄漏：中断 / 退出路径正确注销进程句柄
- 移动端网页模式移除「添加工作区」入口
- 「关于」页移除重复的版本记录入口

🧹 内部优化
- 后端模块化拆分：引擎拆出 reader / registry / events，历史发现与扫描分离，Web 后端拆出 dispatch 层
- 聊天 store 拆分为 composer / sessions / tabs / workspaces / messaging 等模块
- 插件市场页面精简`,
      en: `✨ Features
- **Built-in browser tabs**: open web pages inside the app via native child webviews; the address bar and tab title follow real navigations, target=_blank links navigate the current tab, and closing a tab destroys its webview
- **Session archive**: archive sessions from the sidebar context menu, with a new "Archived sessions" pane in Settings to browse and restore them
- **Session search palette**: the sidebar top-bar search field is retired — open session title search via the search icon or ⌘L
- **Launch scripts**: per-workspace startup scripts, runnable from the session toolbar area
- **Image preview upgrade**: lightbox viewer for message and attachment images
- **Workspace right-click create**: create files/folders from the file tree and workspace context menus
- **GitHub-style Markdown alerts**: > [!NOTE] / [!WARNING] and friends, rendered with a minimal left-border style
- **Composer file drag-and-drop returns**: dropped images become attachments, other files insert @ references
- **Delete confirmation popover**: destructive actions like session deletion now confirm in place
- **Update check feedback**: "already up to date" now shows the version and release date and no longer vanishes after 2 seconds
- Sidebar gains a greyed-out "Automation" entry with a "coming soon" hint
- Plugin SDK 0.3.11: fixes registerComposerSlot permission drift — it still validated the old ui:composer string after the 0.3.9 rename, rejecting every manifest; it now checks ui:composer-status

🐛 Fixes
- Collapsed long messages clip their height instead of leaving a fading ghost
- Failed sessions are correctly indexed in history and can be fully deleted
- Long user message bubbles no longer overflow to the left
- Context-usage gauge numerator no longer sticks at the whole-turn cumulative value; it updates per token again
- Engine process registry leak: interrupt/exit paths now deregister process handles
- Mobile web mode no longer shows the "add workspace" entry
- Removed the duplicate version-history entry on the About page

🧹 Internal
- Backend modularization: engine split into reader / registry / events, history discovery separated from scanning, Web backend gains a dispatch layer
- Chat store split into composer / sessions / tabs / workspaces / messaging modules
- Plugin marketplace page simplified`,
    },
  },
  {
    version: "1.0.4",
    date: "2026-09-18",
    content: {
      zh: `✨ 新功能
- **claude 弹窗提问（AskUserQuestion）**：支持控制协议双向应答；未决提问以悬浮层覆盖输入框，支持单选 / 多选、多问题翻页、自由输入作答与「忽略」，答完转为只读历史行
- **内置 Agents 目录**：打包 agency-agents 资源，设置页新增内置 Agents 面板；composer 支持 @ 选择 agent、/ 选择 prompt 的触发菜单
- **状态栏分支跟随嵌套仓库**：文件树选中子仓库内的文件 / 文件夹时，分支胶囊、分支列表与检出跟随该仓库（显示「仓库名·分支」）
- 插件 SDK 0.3.7 / 0.3.9 / 0.3.10：新增 ctx.sessions.refresh（插件直写后即时刷新侧栏）、ctx.ui.registerComposerStatusItem（composer 状态项）、ctx.sessions.setEffort（插件修改会话推理强度）

🐛 修复
- 推理强度切换对已有会话无效：多余调用污染 tab 字段导致回退到引擎默认值
- 新建空会话（「新对话」页签）不在侧栏显示；折叠文件夹后恢复短列表
- 消息文件链接在嵌套工程下解析失败：新增索引回退（含 gitignore 产物）；@ 提及路径统一规范形，Windows 路径可渲染为 chip 并往返
- Windows「在资源管理器中显示」含空格路径静默跳到「文档」：改用 raw_arg 原样传递 /select 参数
- 快速回合先于 send 返回即完成时的路由丢失：桌面与 web IPC 预分配 run ID
- Claude / Kimi 渠道路由与原生别名互相污染：settings 白名单透传、渠道注入字段剥离、保留 CLI provider 配置
- 引擎进程 run_id 原子预留消除中断 TOCTOU 窗口；启动时清扫 claude-staging / grok-staging 残留目录

🧹 内部优化
- 行为保持型重构清零 react-doctor 13 条警告：composer / 侧栏 / 会话页签条等组件拆分与状态模式修正`,
      en: `✨ Features
- **claude AskUserQuestion popups**: control-protocol two-way answering; pending questions overlay the composer with single/multi-select, multi-question paging, free-text answers, and "Ignore"; answered questions become read-only history rows
- **Built-in Agents catalog**: agency-agents bundled as a resource with a new Settings pane; composer trigger menus for @ agent and / prompt selection
- **Status-bar branch follows nested repos**: selecting a file/folder inside a nested git repo switches the branch pill, branch list, and checkout to that repo (shown as "repo·branch")
- Plugin SDK 0.3.7 / 0.3.9 / 0.3.10: new ctx.sessions.refresh (instant sidebar refresh after direct writes), ctx.ui.registerComposerStatusItem (composer status items), ctx.sessions.setEffort (change session reasoning effort)

🐛 Fixes
- Effort switching had no effect on existing sessions: a stray call polluted the tab field and fell back to the engine default
- Empty new chats ("New chat" tabs) didn't appear in the sidebar; collapsing a folder restores the short recent list
- Message file links failed to resolve in nested projects: new index-based fallback (including gitignored build artifacts); @ mention paths normalized so Windows paths render as chips round-trip
- Windows "Show in Explorer" silently jumped to Documents for paths with spaces: pass the /select argument verbatim via raw_arg
- Fast turns completing before send returns lost routing: run IDs are preassigned across desktop and web IPC
- Claude/Kimi channel routing no longer pollutes native aliases: settings passed via allowlist, channel-injected fields stripped, CLI provider configs preserved
- Engine run_id reservation is now atomic, closing the interrupt TOCTOU window; stale claude-staging / grok-staging directories cleaned at startup

🧹 Internal
- Behavior-preserving refactor clearing 13 react-doctor warnings: composer / sidebar / session tab strip component splits and state-pattern fixes`,
    },
  },
  {
    version: "1.0.3",
    date: "2026-09-16",
    content: {
      zh: `✨ 新功能
- Windows 可切换**仿 macOS 自绘标题栏**
- 侧栏工作区行可**拖拽**到分组 / 未分组 / 已归档完成移动
- 插件 SDK 0.3.5 / 0.3.6：新增会话右键菜单扩展点 ui:session-menu；ctx.ui.openSettings 让插件深链自身设置页

🐛 修复
- Windows 对话孙进程（pwsh/conhost）孤儿泄漏：改用 Job Object 内核级清扫，dsh host、登录 shell 探针、插件子进程一并封堵；Unix 侧同步清扫进程组
- 上下文窗口显示：/compact 后分母不再回落 200k；新会话记住引擎上报的窗口；claude 回合结束自动重读真实占用，无需手动「刷新用量」
- claude auto 模式联网被拦截：预批准 WebSearch / WebFetch
- 模型目录探测死循环风暴；DSH 客户端本机 origin 恒直连
- codex 旧 CLI 预检并给出可操作升级提示；stderr 为空时错误横幅兜底
- dsh / 远程会话删除修复：新增 delete_remote_session IPC，dsh 删除不再失败复活`,
      en: `✨ Features
- Windows can switch to a **macOS-style custom title bar**
- Sidebar workspace rows can be **dragged** into groups / ungrouped / archived containers
- Plugin SDK 0.3.5 / 0.3.6: new session context-menu extension point ui:session-menu; ctx.ui.openSettings deep-links a plugin to its own settings page

🐛 Fixes
- Windows grandchild process (pwsh/conhost) orphan leaks: Job Object kernel-level cleanup now covers conversations, the dsh host, login-shell probes, and plugin child processes; Unix sides sweep the process group as well
- Context window display: the denominator no longer falls back to 200k after /compact; new sessions remember the engine-reported window; claude turns auto-reread real usage on completion — no manual "refresh usage" needed
- claude auto mode network access blocked: pre-approves WebSearch / WebFetch
- Model catalog probe infinite loop storm; DSH client always connects directly for local origins
- codex legacy CLI preflight with an actionable upgrade hint; error banner falls back when stderr is empty
- dsh / remote session deletion fixed: new delete_remote_session IPC, dsh deletions no longer resurrect`,
    },
  },
  {
    version: "1.0.2",
    date: "2026-09-15",
    content: {
      zh: `✨ 新功能
- 接入 **OpenCode** 与 **Qoder** 两个一等引擎；Qoder 区分国际版与国内版（qoder-cn 兄弟引擎）
- **WSL 插件**全链接入：会话源 / 文件源 / UI 桥 / 远程历史回放 / 远程模型目录
- **快捷键系统迁移**：可配置键位、设置页录制编辑、快捷键指南
- 会话行**右键菜单**：重命名 / 复制 ID / 删除

🐛 修复
- 新会话不再被刷新冲掉：侧栏即时显示，无需手动同步
- Windows 检测不到新装 / 非 npm 渠道安装的 codex 与 claude
- claude 上下文窗口改读 CLI 上报值
- 放行 asset 协议在 Windows 上的可用 URL 形式，移除 CSP 冗余项
- 移动端设置导航分组溢出重叠
- WSL 接入安全审查修复：meta.wsl 全字段白名单、权限模型收紧、远程调用 30s 全局超时
- 发版增加版本输入校验门禁，修复 latest.json 资产名空格 404`,
      en: `✨ Features
- Two new first-class engines: **OpenCode** and **Qoder**, with Qoder split into Global and CN distributions (qoder-cn sibling engine)
- **WSL plugins** wired end to end: session source, file source, UI bridge, remote history replay, remote model catalog
- **Shortcut system migration**: configurable keybindings, recording editor in Settings, and a shortcut guide
- Session-row **context menu**: rename / copy ID / delete

🐛 Fixes
- New sessions no longer get wiped by refreshes — the sidebar shows them immediately, no manual sync
- Windows now detects freshly installed or non-npm codex and claude builds
- claude context window reads the value reported by the CLI
- Allow the Windows-usable asset-protocol URL forms in CSP and drop a redundant entry
- Mobile settings navigation groups no longer overflow and overlap
- WSL integration security review fixes: full meta.wsl field allowlist, tightened permission model, 30s global timeout for remote calls
- Release pipeline validates version input and fixes the latest.json asset-name space 404`,
    },
  },
  {
    version: "1.0.1",
    date: "2026-09-14",
    content: {
      zh: `✨ 新功能
- 右键文件夹**搜索工作区文件**
- OMP 引擎补 plan / bypass 权限档

🐛 修复
- 「已编辑」行数改从会话编辑调用统计
- 窄窗下侧边栏开关常显、幕布区留白修正、子代理行归并`,
      en: `✨ Features
- **Search workspace files** from a folder's right-click menu
- OMP engine gains plan / bypass permission tiers

🐛 Fixes
- "Edited" line counts now come from the session's edit-call stats
- Narrow windows keep the sidebar toggle visible, fix backdrop gaps, and merge subagent rows`,
    },
  },
  {
    version: "1.0.0",
    date: "2026-09-08",
    content: {
      zh: `✨ 新功能
- 接入 **OMP 引擎**（pi-family 参数化复用 + 全链路接线）
- 新增 **局域网网页访问**：WebSocket 桥接 + 设置页二维码入口，手机浏览器可直接使用
- **Pi 家族引擎认证**：OAuth 订阅授权与 API Key 管理、cc-switch 渠道导入与切换
- **AI 聊天输入区增强**：@ 提及、权限 / effort 档位、分支菜单、提示历史补全
- 消息锚点导航、Provider 配置对话框与引擎 / 历史层增强
- 首页外观设置与交互粒子字标

🐛 修复
- Windows 上派生子进程不再弹出控制台窗口`,
      en: `✨ Features
- Add the **OMP engine** (parameterized reuse of the pi-family pipeline, wired end to end)
- **LAN web access**: WebSocket bridge + QR entry in Settings, so phones on the same network can use CC GUI in a browser
- **Pi-family engine auth**: OAuth subscription sign-in and API Key management, cc-switch channel import and switching
- **Composer upgrades**: @ mentions, permission / effort tiers, branch menu, prompt-history completion
- Message anchor navigation, provider configuration dialog, and engine/history layer improvements
- Home appearance settings with an interactive particle wordmark

🐛 Fixes
- Spawned child processes no longer show console windows on Windows`,
    },
  },
  {
    version: "0.9.4",
    date: "2026-08-30",
    content: {
      zh: `✨ 新功能
- 侧栏工作区子项增加树状连接线，会话重载收敛为强制同步并加重载忙碌态
- 设置新增 **侧栏网络代理抽屉**
- 文件底部状态栏新增 **Git Blame** 切换按钮

🐛 修复
- 修复 pi 多原生 turn 交错下「响应中」卡死、重复叙述与完成音连响
- 修复 Windows 单文件「差异不可用」死路
- 修复新建会话抽屉卡死

⚡ 性能
- live 工具输出增加渲染预算，会话条目缓存驱逐加入近期切换保护`,
      en: `✨ Features
- Sidebar workspace children get tree lines; session reload converges to a forced Session Index sync with a busy state
- New **network proxy drawer** in Settings
- **Git Blame** toggle in the file status bar

🐛 Fixes
- Fix pi sessions stuck in "running" with duplicated narration when native turns interleave
- Fix the Windows single-file "diff unavailable" dead end
- Fix the new-session drawer freeze

⚡ Performance
- Render budget for live tool output; recent-switch protection for session-entry cache eviction`,
    },
  },
  {
    version: "0.9.3",
    date: "2026-08-26",
    content: {
      zh: `🐛 修复
- PI catalog 探测跳过 extension boot 并放宽预算至 15s，根除 auto-only 降级
- Codex usage 事件不再伪造 200K 上下文窗口
- 新增孤儿 turn 零首事件看门狗，防止「响应中」永久卡死
- process_is_alive 增加 Windows 平台分支
- client store 写盘改 raw-string 过桥，遏制 markdown worker 崩溃循环`,
      en: `🐛 Fixes
- PI catalog probing skips extension boot with a 15s budget, eliminating auto-only degradation
- Codex usage events no longer fabricate a 200K context window
- Orphan-turn zero-first-event watchdog prevents sessions stuck in "running" forever
- Windows branch for process_is_alive
- Client store writes cross the bridge as raw strings, stopping markdown-worker crash loops`,
    },
  },
  {
    version: "0.9.2",
    date: "2026-08-22",
    content: {
      zh: `✨ 新功能
- 接入 **Qoder** Global 与 CN 双分发，落地 profile 限定的 Native 会话身份解析
- 会话 catalog 与 provider binding 全面携带分发归属

🐛 修复
- 修复多智能体协作模板选择器卡在加载中
- Shared 链路按 Target 认主并隐藏下崽会话`,
      en: `✨ Features
- **Qoder** Global and CN distributions, with profile-qualified native session identity resolution
- Session catalog and provider binding now carry distribution attribution throughout

🐛 Fixes
- Fix the multi-agent template picker stuck loading
- Shared sessions resolve ownership by target and hide child sessions`,
    },
  },
  {
    version: "0.9.1",
    date: "2026-08-19",
    content: {
      zh: `✨ 新功能
- DSH 接入 composer **Agent Preset** 选择器

🐛 修复
- DSH 按会话隔离 Agent Preset 展示，接通任务条与上下文占用
- 收敛长对话尾部重复的用户气泡
- 隐藏 Shared 协议续跑会话及其侧栏子会话`,
      en: `✨ Features
- DSH gets an **Agent Preset** picker in the composer

🐛 Fixes
- DSH Agent Presets are isolated per session; task bar and context usage are wired up
- Collapse duplicated user bubbles at the tail of long conversations
- Hide Shared-protocol resumed sessions and their sidebar children`,
    },
  },
];
