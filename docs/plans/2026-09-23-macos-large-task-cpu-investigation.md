# macOS 大任务 CPU 异常调查

日期：2026-09-23。性质：源码调查与低负载合成验证，不是修复完成报告。

## 结论

已确认客户端存在随任务规模放大的工作量：工具结构事件逐条扫描/复制消息列表、单个 process 内工具行没有虚拟化、长思考全文逐帧揭示、长 Markdown 仍全量解析。它们是需要处理的性能风险，但当前没有故障现场调用栈，不能确认各自占截图 CPU 的比例，不能宣称已定位唯一根因或已解决整机卡死。

“修改 100 个文件”并不是足够的复现条件：必须同时记录工具事件数量、会话历史长度、思考与正文长度、过程是否展开、是否打开大 diff，以及引擎子进程并发。

## 调查边界

- 截图显示整机接近满载，CC GUI Graphics and Media 与 CC GUI 位列高负载进程。截图本身不足以区分 JS、布局/绘制、原生计算和引擎工具进程，也不宜未经确认直接把不同 CPU 指标相加。
- 调查时的进程列表未发现运行中的 CC GUI 主程序，未取得对应故障进程的 sample。没有主动启动大任务、重启应用或杀进程。
- `/Applications/CC GUI.app` 标注 1.0.7；另有 `/Applications/ccgui.app` 标注 1.0.0。安装存在不证明故障当时运行的是哪一个。
- 工作区 HEAD 为 `41b1c900c`，版本为 1.0.8；`refs/tags/v1.0.7` 为 `b218a77a0c40ab98bbb3c32c3ea535393965ed5e`。显式比较标签到 HEAD 及工作树，`src/features/chat`、`src/features/git`、`src/features/files`、`src-tauri/src/git.rs`、`src/hooks`、`src/components/application/agent-log` 无差异。因此下述对应模块的问题不是仅存在于未发布 1.0.8 的推测；但未核验安装二进制的实际构建来源。
- 开始与结束检查均有 58 个既有工作区变更条目；本轮不修改这些内容，仅新增本报告。

## 1. 工具事件批量到达，却逐条执行全表工作

证据链：

- `src/features/chat/store/engine-events.ts:1181`：事件数组逐条分派。
- `src/features/chat/store/stream.ts:340`：每个工具事件单独进入 store set。
- `src/features/chat/store/stream.ts:271`：settleLiveRows 检查消息列表；工具追加复制数组。
- `src/features/chat/store/stream.ts:349`：result patch 复制、反转、查找并 map；args patch 同样 find/map。
- 与之不同，文本 delta/thinking 已有 pending 合并、rAF flush 和超时兜底。

从已有 N 条消息继续增加 T 条工具消息，累计数组工作量可达到 O(TN + T²)。React 可以合并提交，但不能消除已经执行的这些 store 扫描/复制。

只读合成实验通过 Proxy 计数源码对数组数字索引的读取：

| 连续追加工具数 | store 写入次数 | 累计数组索引读取 |
| --- | ---: | ---: |
| 60 | 60 | 3,599 |
| 120 | 120 | 14,399 |

这证明工作量增长形态，不是 CPU 百分比；百余次事件本身是否足以造成明显卡顿，还取决于历史长度、事件密度与下游工作。

补充：重复 result 即使使用同一个对象也会替换消息和 process row；没有找到 args patch 目标仍更新 session 包装。实际引擎是否频繁触发这些重复输入尚未记录，不把它们当作已证实的主要负载。

## 2. 外层有虚拟列表，但单个过程组内部没有

- `src/features/chat/components/timeline-rows.ts:92`：连续 tool/thinking 聚合成 process。
- `src/features/chat/components/MessageTimeline.tsx:468`：虚拟化单位为 timeline row。
- `src/features/chat/components/ProcessDisclosure.tsx:319`：展开组内部直接 sections.map / calls.map。

源码实验：120 条连续 Edit 得到 1 个 timeline row，内部含 120 个 ProcessItem。因此“时间线已经虚拟化”不等于百次工具调用只挂载可见部分。一个足够大的展开 process 仍可包含整组 DOM。

每个新工具行还使用 `agent-log-motion.ts:27` 的 height 0→auto、blur 6px→0、透明度和渐变遮罩动效，见 `agent-log.tsx:172`。批量新增时这些效果可能叠加；是否占用截图中高负载图形进程需要原生录制验证。

现有保护不能忽略：FrozenStepRow 有 memo；已见工具 key 防止重复入场；遮罩在动画完成后移除；收起后 body 通常经过 300ms 卸载。不能声称所有历史工具每帧完整重渲染，或这些动画永久运行。

## 3. 长思考文本每帧更新完整已揭示前缀

- `src/features/chat/components/ProcessDisclosure.tsx:185`：ThinkingSurface 订阅整个文本范围，并渲染 reader.prefix(revealed)。
- `src/features/chat/components/stream-reveal.ts`：通过 rAF 推进展示游标。
- `src/features/chat/components/use-scroll-follow.ts:85`：跟随时读取 scrollHeight/clientHeight 并写 scrollTop。
- 同文件 `:315`、`:326`：消息更新和 ResizeObserver 都可触发跟随。

因此，流式长思考不仅是存储追加几个字符，还会反复改变较长文本节点，并与高度测量、自动滚动交错。是否发生昂贵的同步布局必须通过 WebKit 时间线确认；当前没有测到布局时间或每帧成本。

2026-09-22 的 `fbfca1b20` 为避免已读文字被裁掉，移除了 2,000 字尾窗。不能直接把尾窗加回去作为“优化”：那会重新破坏内容完整性。正确修复方向是保留全文，把稳定前缀与活动尾部拆开，并对不可见部分有界渲染。

## 4. Markdown 节流不是单次解析预算

- `src/features/chat/components/MessageTimeline.tsx:279` 使用动态解析间隔。
- `src/hooks/throttled-text.ts:3`：长度档位为 32/64/128ms；反馈间隔上限 160ms。
- `src/features/chat/components/Markdown.tsx:161`、`cached-highlight.ts`：高亮缓存有边界，但正文依然完整解析。

本机 Node v22.22.3 的有界合成实验：ReactMarkdown + remark-gfm + remark-math + rehype-katex + 项目 cached-highlight；重复中文、emoji、表格与闭合 TypeScript 代码块；每种长度渲染 4 次，后续增加一字符令正文变化；各档之间休息 250ms。

| UTF-16 长度 | 首次 SSR / ms | 后续三次 SSR / ms |
| --- | ---: | --- |
| 4,000 | 36.2 | 15.6 / 10.9 / 9.1 |
| 16,000 | 66.8 | 45.4 / 37.5 / 32.4 |
| 64,000 | 252.7 | 198.6 / 226.2 / 188.3 |

这是 Node 服务端静态渲染（包含输出字符串生成），不是生产 Markdown 组件的浏览器提交，不包含原生 IPC、WebKit 排版/绘制，也不是完整插件流水线。机器未隔离其他程序负载，因此数字只是局部风险示例，不用于断言原生 CPU 或准确性能比例。它说明长正文的全量解析不能只靠固定上限的节流当作解决方案；不说明“100 个文件必然生成 64k 正文”。

## 5. 条件性风险与排除项

### 打开工具参数或大 diff

`ToolPayloadViewer.tsx:125` 的 max-height + overflow 只限制显示高度，随后 diffLines.map 仍创建所有行。1,000 行中间改一行的实验产生 1,001 个 diff 行，其中 999 行是上下文。

但工具参数默认不挂载，只在用户展开时渲染（`ProcessDisclosure.tsx:157`）；diff 算法是线性前后缀扫描，不是 LCS 平方矩阵。这不是“100 次 Edit 自动生成 100 个完整 diff”的证据。

### Git

`src-tauri/src/git.rs:517` 的状态请求包括递归状态扫描、staged/unstaged 行数 diff；`:384` 的未跟踪文件计行限制 100,000 行，但没有字节上限。少换行的大文件可能一直扫描到 EOF，这是独立的资源边界缺口。

然而 `src/features/git/store.ts:102` 有同仓库 in-flight 合并及 30 秒缓存 TTL，文件树刷新也有去重；TTL 不是轮询定时器。没有在当前源码找到“每次文件写入均触发 Rust watcher 全仓扫描”的证据，不把 watcher 风暴作为结论。

### 引擎并发和任务状态派生

注册 run 的数量上限不是工具后代进程的 CPU 配额，任务启动构建/测试/搜索时仍需检查真实进程树。未取得故障时引擎进程证据。

RunStatusStrip 订阅消息并推导任务/文件状态；非 Claude 的未完成子任务场景存在向后查找的平方扫描（`agent-task-steps.ts:393`）。普通 Edit 不自动满足该条件，故列为次级候选。

## 验证

运行：

```sh
pnpm exec vitest run src/features/chat/components/ProcessDisclosure.test.tsx src/features/chat/components/use-tail-pin.test.tsx src/features/chat/store/stream.test.ts src/features/git/ChangesPanel.test.tsx --maxWorkers=1 --minWorkers=1
```

结果：4 个文件、31 个测试通过，用时 3.84 秒。这些测试保护展开/收起、流式文本完整性、消息引用与 Git 面板行为；不是原生 CPU 验收。

未运行全量 build/lint/Rust 编译；本次不修改生产代码。未进行故障负载重放、原生 WebKit 性能录制或内存泄漏验证。

## 建议修复次序与验收

1. **同一批工具事件有序归并后一次提交**，避免逐事件全历史扫描。不得打乱 tool/name/args/result、取消和 done 边界；回归检查存储与复制内容完整。
2. **process 组内有界渲染**，而不只是外层 row 虚拟化；批量工具到达不同时播放整批 blur/height/mask。保留展开、搜索定位与完整历史访问。
3. **长思考稳定前缀 + 活动尾部隔离**，原文不裁剪；合并布局读取和滚动写入，检查缩放、中文、emoji、复制与滚动暂停。
4. **长正文与大 diff 的工作量边界**：优先按可复用结构避免整篇重做；不能破坏引用链接、表格、代码块和插件；diff 可折叠上下文或虚拟化。
5. **Git 大文件字节预算与跨请求限流**。先有实际扫描证据再提升优先级；不无依据替换整个 Git 实现。

修复验收应包括：固定历史规模与工具事件数的工作量/通知数、120/500 条工具下挂载 DOM 数、长思考全文完整性、单次长任务最大阻塞、native CPU 按进程分拆，以及任务结束/取消后的归零行为。不能仅用构建成功代替这些指标。

## 下一次自然复现时的取证

无需再次让 AI 主动改 100 个文件。故障自然发生时，短时采集：

1. 活动监视器按 CPU 排序，记录 CC GUI 主程序、Graphics and Media、网页内容相关进程、实际引擎以及构建/测试子进程的 PID。核对应用运行路径和版本。
2. 对热点 PID 分别使用活动监视器“取样进程”，或 `sample <实际PID> 5 -file /tmp/ccgui-<实际PID>.sample.txt`。不要把占位符当命令直接运行，不杀进程。报告只在本地保留，分享前检查路径等敏感信息。
3. 在不取消任务的前提下分别收起思考/工具过程、关闭大 diff、最小化窗口，记录各进程 CPU 是否下降；每次只改变一个因素。下降仅用于缩小范围，不独立证明某段代码就是根因。
4. 若可用，录制同一时段的 WebKit JS/布局/绘制时间线，关联引擎事件速率与消息规模；与原生 sample 对照。

本轮产出是明确的风险链路、可验证的工作量证据与修复顺序。唯一根因及各环节贡献仍待故障现场采样确认。
