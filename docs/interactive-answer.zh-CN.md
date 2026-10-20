# 交互式回答（Intelligence UI）

普通本地 Codex、Claude 与 AGY 对话会收到 Intelligence UI 能力说明：当调整真实输入、约束或决策能帮助当前任务，且比直接阅读文字或表格更有用时，主动生成紧凑交互卡，例如预算重算、条件变化下的方案推演。实质性回答或方案比较本身不构成出卡理由。定性卡片可以用选择或开关联动建议和取舍，不局限于计算器；一个有效控件也可以，不为凑数量添加控件，通常使用 1–3 个，不编造评分、指标或精度。简短事实、状态/完成汇报、源码核对、实现规划和验收清单默认使用普通文字；其中确有可调计算或待决取舍时仍可出卡。尊重用户明确指定的格式，文字保留结论、假设和必读核对项。没有专用指令，也可直接用自然语言提出（例如「做成可以调参数的」）。当前会话使用已有模型、渠道、权限和发送链路生成回答；无需另配 API key，也没有旁路模型调用。

卡片状态应代表输入假设、用户约束或值得继续讨论的决策，不能只是正在阅读哪个段落。不得用下拉框或开关给短静态说明、汇报章节、实现阶段、代码模块或并列验收项分页；这些内容应平铺，便于完整核对。文字变化不等于交互有用，少量方案用表格一眼能看全时优先用表格。内置定性示例使用「离线可用」「多设备」两项真实约束共同推导存储与同步建议，避免示范章节切换器；并不要求每张卡片都有两个控件。

协议提供结构底线：至少一个从 `root` 可达的交互控件；每个 `$state` 均需绑定可达控件，并直接或经派生表达式影响可达的非控件输出。未挂载的声明、控件自身标签和范围不计作结果，孤立状态不进入参数反馈。不满足时使用原有失败回退，保留「查看原文」，不改写历史消息或已存参数。此检查只能发现无控件、空转控件等结构问题，不能判定说明是否有价值，也不能识别所有常量分支或只回显选择值的伪交互；语义质量仍由生成规则和实际模型抽样验证。

说明与现有宿主角色指令组合，保留用户原有指令，不写入供应商配置或用户气泡：Codex 通过原生新建/恢复线程的开发者上下文传入，Claude 随每次启动的 `--append-system-prompt-file` 追加，AGY 写入每次运行的临时宿主插件 `rules/AGENTS.md`。受限工具任务、旁聊和其它引擎不注入这份说明。

2026-10-19 起移除 `/ui` 应用指令：上线后三天内本机 Codex 会话没有一次实际使用，且它只覆盖 Codex。输入 `/ui …` 现在按普通文字或用户自定义同名命令发送；此前 `/ui` 请求在历史中附带的格式说明仍按原样隐藏。生成图片走独立的聊天图片预览，不属于 `ccgui-ui` 组件协议。

普通文字与 `ccgui-ui` 围栏可以混排。完整围栏通过检查后在聊天中显示可操作控件；未完成的围栏显示生成状态，生成中断或载荷失败保留上下文文字及原文入口。历史消息沿用相同渲染路径。支持布局、文字、指标、滑块、数字输入、选择、开关、表格和条形图。参数调整在本地计算，重置恢复模型给出的初值。输入状态按宿主会话、消息、代码块和源码 SHA-256 隔离，保存到应用的 SQLite 参数库；虚拟列表卸载、刷新和重启均可恢复。读取完成前不开放控件，保存失败保留当前输入并提供重试；写入使用修订号检查，旧请求不能覆盖新修改。

Intelligence UI 保持聊天内主入口，吸收 Canvas 的状态持久化、来源绑定和参数反馈。点击「使用这些参数继续讨论」只向确切来源会话的现有草稿追加参数及来源标识，用户自行决定是否发送；不覆盖草稿、不自动切换会话或调用模型，不把控件选择视为执行授权。外框仍统一提供参数保存、重置与反馈，因此生成内容需符合参数语义。没有稳定来源的预览仅保留当前页状态，并明确显示不能反馈的原因。不会自动把交互作品发布到 Spellcast Canvas；模型提供的组件仍不能执行工具、URL、命令或任意脚本。

## 实现与依赖

- `src/features/interactive-answer/prompt.ts`：支持引擎判断 `supportsInteractiveAnswer`（与后端 `PRESENTATION_ENGINES` 对齐），以及旧 `/ui` 请求说明的历史显示清理。
- `capability-instructions.txt` / `src-tauri/src/engine/host_instructions.rs`：普通 Codex / Claude / AGY 对话的常驻能力说明与角色组合；说明中的全部计算与定性示例由生产协议解析器回归验证。
- `protocol.ts`：严格词法/语法检查及规范化；32 KiB 源码、声明/深度/引用展开预算、闭集组件/函数、原始状态类型与控件范围。拒绝未知语法、环与指数引用展开、属性访问、动态赋值、工具/动作及内部对象标记。数学函数验证参数形状；除法和余数须证明分母非零或显式在条件分支内保护，避免上游将错误计算静默变成 0。
- `components.tsx` / `interactive-answer.css`：Gemini 4 协助实现的原生 React 组件，遵循现有主题，主代理完成边界修正和集成验收。
- `InteractiveAnswer.tsx` / `persistent-state.ts` / `persistence.ts`：错误边界、完整程序解析、250ms 合并写入、串行保存、冲突状态与有界缓存。
- `src-tauri/src/interactive_answer_state.rs`：只保存参数与来源哈希，不保存程序源码；原生与已授权 Web 共用修订号检查，最多 10,000 条记录，达到上限时报告失败而不静默淘汰。
- `feedback.ts`：严格解析原会话/消息/代码块身份，只允许有界基本类型参数追加到来源草稿。
- `Markdown.tsx` / `MessageTimeline.tsx`：仅 Codex、Claude 与 AGY assistant 消息启用该围栏；普通围栏和插件覆盖保持原有入口。

固定使用 `@openuidev/react-lang` / `@openuidev/lang-core` 0.3.2 和 Zod 4.4.3。1.0.0 因未满既有七天发布等待期未采用，没有放宽 `minimumReleaseAge`。lang-core 的可选遥测 postinstall 明确禁用。Vite/Vitest 对 React 绑定使用精确的 `index.native.mjs` 别名：它重导相同运行时，省去开发模式自动加载远程 Devtools 的副作用；Renderer 关闭 `publishObservability`，不配置工具或宿主动作。升级时应重新核对这个入口及边界。

## 验证与预览

生成质量验收应区分正反例：Godot 撤离/过场/失败恢复的源码核对与验收清单直接列出全部内容；简短的轮询/WebSocket 优缺点用普通对比表，不生成文字翻页器；离线与多设备约束共同影响存储建议时可生成定性卡片；有明确单价和假设的预算推演可生成计算卡片。协议测试覆盖可达性与间接依赖，不能替代这些真实生成场景的质量验证，也不能证明出卡频率已改善。

`tests/fixtures/interactive-answer/gpt-budget.md` 来自一次真实 `gpt-6-astra` / medium 的 Codex CLI 试跑，仅使用合成的活动预算假设；不是人工假装模型生成。初始人数 12、餐费每人 120 元、场地 800 元，总额 2240 元、人均 186.67 元。该单次模型输出不等同于所有提示词的生成质量保证。

```powershell
pnpm exec vitest run src/features/interactive-answer src/features/chat/components/use-composer-interactive.test.tsx src/features/chat/components/Markdown.test.tsx src/features/chat/components/composer-draft.test.tsx src/features/chat/components/MessageTimeline.test.tsx
pnpm build
node scripts/build-interactive-answer-preview.mjs
```

浏览器夹具 `/tests/browser/interactive-answer.html` 使用生产 Markdown 和交互组件，提供真实 GPT 示例、控件、异常回退、生成回放、明暗主题及卸载/恢复。所有 IPC 与浏览器存储在该文档内模拟；打开页面不调用模型、不读取用户聊天或原生配置。本地单文件产物 `artifacts/interactive-answer/gpt-interactive-preview.html` 可离线打开。

## 初版的 2026-10-16 本机部署记录

以下仅记录持久化及参数反馈加入前的初版部署，不代表上述新增链路已部署或完成原生界面验收。

当前运行的 `1.1.1+protected.31.leaderguard.20261016` 已包含本功能。原生更新状态为 `Committed`，活动清单为 `f4a19f8200181d64166f7265a3d2328478db1248d22f43494764b1953f8e92f0`；活动 EXE 与共享工作区完成的本机构建 SHA-256 一致，且包含对应 `InteractiveAnswer` 与主入口前端产物名。核对记录位于 `artifacts/interactive-answer-release-20261016/deployment.json`。

另行尝试的两个 UI 专用版本号原生重构建均因 LLVM 内存不足退出，未部署；最终核对的是已经由原生更新器提交、包含相同前端的共享本机构建，没有冒充这两次失败构建成功。98 项定向测试、5 项页面隐私检查与 18 项真实浏览器检查通过；浏览器检查和安装版本核对分别记录，未把它们表述为已在原生 GUI 点击操作全部控件。
