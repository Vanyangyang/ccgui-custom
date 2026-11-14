# 任务快照与离线回放

入口：`node scripts/task-replay/cli.mjs`，或 `corepack pnpm task-replay`。2026-10-29 按用户最终要求撤回 Decisions API 接入并取消后续付费验证；当前工具仅保留快照、离线 JSON 夹具与历史报告处理，已经删除网络发送和凭据读取路径，拒绝 `--live` 与 `--key-file`。历史实验包和结果保留原样，不继续执行其付费入口。夹具报告不能作为模型提效结论。

## 离线夹具保留的历史实验定义

- **memory**：A 使用冻结的原候选顺序；B 用 JSON 夹具模拟历史 Decisions 结果，并按工作台 0.13.33 的保守规则只排列前 16 项中的无条件候选，条件记录和无法判定的记录保持原槽位。主模型与评审响应也来自离线夹具。
- **handoff**：使用冻结来源、初始摘要和 JSON 中的主模型／评审响应模拟交接；B 额外提供一次离线参考检查。相同 source/draft 跳过这一步。两组使用相同验收项和返工反馈规则。
- 主模型、思考级别、输出上限、工具轮数与最大返工次数固定。按 seed 与样本次序交替 AB/BA。每轮评审使用独立无历史请求，不携带组别、辅助分数、运行 ID 或另一组结果；答案内容本身仍可能透露辅助痕迹，不能宣称完全消除评审偏差。
- 本工具模拟模型工作流；没有测量人工操作或人工复核时间。配对结果不等于普遍准确率、统计显著或用户实际节省时间。

## 1. 创建并填写任务清单

```powershell
node scripts/task-replay/cli.mjs init --out G:/Replay/pilot.json
```

父目录需预先存在，目标文件不能已存在。模板中的来源、初始摘要、验收项是占位内容，必须替换。不要把真实密钥放进清单、任务文本或快照。

每个 case 包含：

| 字段 | 内容 |
| --- | --- |
| `id`, `kind`, `prompt` | 稳定样本 ID、`memory`/`handoff`、当时任务要求 |
| `requirements` | 提前制定的 `{id, description, critical}` 列表，运行中不能修改 |
| `source`, `initialDraft` | handoff 的当时已知资料与原摘要，最多各 48000 UTF-16 单元 |
| `candidates` | memory 的冻结候选：`id/title/text/conditions/kind/authority/revision`，最多 48 项 |
| `snapshot` 或 `snapshotDir` | 从明确 commit 捕获，或导入此前已记录的快照 |
| `provenance` | 起点时间、是否有当时记录及其证据说明；不确定时保持 false |
| `allowWrite`, `recipes`, `dockerImage` | 是否允许修改隔离副本、固定验收命令、镜像 digest |

纯文本样本可以不带代码快照。带文件写入或测试命令的样本必须有快照。

历史 commit 示例（需填真实完整 SHA，不能写 HEAD/分支名/短 SHA）：

```json
"snapshot": {
  "repoRoot": "G:/Project/game",
  "commit": "完整的40或64位commit哈希",
  "mode": "commit"
}
```

`commit` 模式只读取该提交的 Git blob，不读取当前新代码，默认标记为近似重建：仅有 commit 不能证明当时没有未提交改动。不要选任务完成后的修复提交作为起点。

## 2. 为今后的任务记录完整起点

```powershell
node scripts/task-replay/cli.mjs capture --repo G:/Project/game --commit 完整SHA --mode working-tree --out G:/Replay/start-snapshot
```

`working-tree` 要求 HEAD 与指定 SHA 相等，记录实际已跟踪文件的修改/删除及未忽略的未跟踪文件，保留二进制与实际换行。忽略文件（如依赖目录、构建产物）不捕获；锁文件、必要测试数据需已跟踪或未被忽略。读取前后核对变化，发现变动则拒绝完成；这不是操作系统原子文件系统快照。

以后在 case 中使用 `"snapshotDir":"G:/Replay/start-snapshot"`。只有确实保存了任务开始时的资料，才把 `provenance.snapshotRecordedAtStart` 标为 true 并填证据。`recorded` 基于操作者提供的历史证据；工具验证快照完整性，但不会独立证明过去发生的时间。commit-only 始终保留近似标签。

快照保存在内容寻址 blob 和 manifest 中，校验 SHA-256、长度、预算与路径。拒绝符号链接、junction、硬链接文件、submodule、Windows 保留路径和大小写碰撞。默认最多 20000 文件/256MiB，可调低，不自动扩大。失败可能留下本次新建的部分目录，不递归清理用户目录。

历史 blob 使用 `git cat-file --batch-check` 预检总尺寸后，通过 `git cat-file --batch` 按字节长度读取；建库使用一次 `hash-object --no-filters --stdin-paths`，不逐文件启动 Git。批量响应仍验证 OID、类型、长度、边界与输出预算。没有使用会受导出属性影响的 `git archive` 来代替完整原始树。

## 3. 冻结实验包与检查计划

```powershell
node scripts/task-replay/cli.mjs prepare --spec G:/Replay/pilot.json --out G:/Replay/pilot-bundle
node scripts/task-replay/cli.mjs plan --bundle G:/Replay/pilot-bundle
node scripts/task-replay/cli.mjs doctor
```

输出目录必须是全新目录，且不能与源码仓库互相包含。每个 A/B 运行从同一份 blob 创建独立仓库：只有一个固定合成提交，无远端、alternates、共享对象库或未来 refs。原仓库的 index、分支与工作文件不改变。

包中冻结输入、验收项、运行顺序、模型参数、历史定价、夹具合同和运行时文件哈希。旧 Decisions 提问合同仅作为 `scripts/task-replay/decisions-contract.fixture.json` 离线资料保留，不再是宿主原生资源；每包冻结具体版本。

源码工具更新后，旧包需用它自己的冻结版本执行：

```powershell
node G:/Replay/pilot-bundle/runtime/cli.mjs plan --bundle G:/Replay/pilot-bundle
```

### 预算公平性

`maxRequests` 是离线编排的模拟请求上限，包含辅助、主模型与评审夹具。开始一对样本前，必须能预留两组的最坏请求数：

`2 × (maxReworks + 1) × (maxToolSteps + 1) + 1`

其中每轮最多 `maxToolSteps` 个主模型请求及一个 judge，B 最多增加一个 Decisions 请求。额度不足时两组都标为 blocked、零请求，不让先运行的一组挤占另一组预算。plan 会显示每对所需预留和全部最坏上限；未使用额度供后续完整配对使用。

这不是金额硬上限：费率和未知计费可能导致实际费用与估算不同。每个请求另有限定输入字节、输出 token 与超时，不自动重试。

## 4. 文件工具和测试隔离

模型只可调用 `read_file`、`list_files`、字面量 `search_files`，以及显式允许的 `write_file`、`run_test`。所有文件路径必须相对当前副本；拒绝外部路径、`.git`/短名别名、链接与路径逃逸。模型无法直接调用宿主 shell、网络、Git 或其它会话。

测试 recipe 示例：

```json
"allowWrite": true,
"dockerImage": "your-runtime@sha256:完整的64位镜像摘要",
"recipes": [{
  "id": "acceptance",
  "argv": ["node", "--test", "tests/replay-acceptance.mjs"],
  "timeoutMs": 30000,
  "protectedPaths": ["tests/replay-acceptance.mjs", "package.json"]
}]
```

recipe 是提前定义的 argv，不接受模型生成的命令。Docker 必须为本机 Linux engine，镜像已存在且按 digest 固定；不会拉取镜像或安装 Docker。只读挂载当前副本，无网络、无额外卷、无 Docker socket、无宿主密钥，降权并限制 CPU/内存/PID；仅 `/tmp` 可写。测试需把临时文件和构建输出放到 `/tmp`，依赖由固定镜像提供。依赖不同、不能在只读工作目录运行的历史测试不能冒充精确现场。

`protectedPaths` 必须在冻结快照中，模型不能修改；测试前后核对它们及产物完整性，每轮还会独立运行所有验收 recipes。缺少 Docker、镜像不可用、测试产物变化或保护文件被篡改会阻止该运行，不回退宿主直接执行。

文件工具通过宿主路径校验限制模型能力，容器限制测试代码；它们不是对恶意同用户宿主进程并发替换目录的完整 OS 安全边界。

## 5. 离线执行

```powershell
node scripts/task-replay/cli.mjs run --bundle G:/Replay/pilot-bundle --fixture G:/Replay/responses.json
```

只使用 JSON 中按计划排列的响应，每项 `{role:"primary"|"decisions"|"judge",response:...}`；不连接模型服务、不读取环境变量或文件中的 API Key。旧 `--live`、`--key-file` 参数在读取 bundle/文件之前就返回 `live_execution_removed`，直接调用运行器的 live 选项也被拒绝。用途是验证编排、工具循环、返工和报告，报告显著标为夹具。

任务输入和回复属于实验资料，保存在实验包内；共享包前自行确认内容。历史真实调用记录仅供审计，不构成继续调用授权。

## 6. 结果、失败与费用

`results/state.json` 逐请求保存 started/settled、请求摘要、用量、耗时与状态。开始请求前先保存 unknown；超时或传输不明时停止，不自动重发。每轮主模型草稿先独立保存，judge 失败不会丢失已经生成的产物。

运行耗时包含本组副本准备、主模型、辅助、工具与评审等待；捕获/冻结整套实验包不在组内计时。角色耗时和副本准备耗时另有记录。API 未提供可核验的独立排队时长时 `queueMs` 为 null，不从总等待时间猜测；网络与服务等待均包含在请求耗时内。

- `comparison.json`：逐任务 A/B 差值、严格/近似资格、失败分母、成功配对耗时和角色用量。
- `report.md`：实际运行耗时与达到验收的耗时分开；失败不填完成耗时 0。初始/最终遗漏、未决项、关键缺口、实际启动的返工轮次、辅助是否应用或跳过均保留。
- `round-*-draft.json` 和 `round-*.json`：实际答案、最终文件证据与独立评审。

费用按模型名配置 `pricing`，必须包含 `currency:"USD"`、来源 `source`、日期 `asOf`、每百万普通输入/缓存输入/输出的费率。缺费率或用量就是未知，不以 0 或已知小计代替总费用，包括缺失的缓存写入计数。缓存输入从总输入中扣除后单独计费；非零 cache write 另需费率与 included/additional 模式，且写入计数不能超过未缓存输入。对于写入已包含在 input、写入总费率为普通输入 1.25 倍的 API，`additional` 填额外 0.25 倍差价，避免重复加完整写入价。judge 费用单列；这些都是费率估算，不是账单扣款凭证。

中断后只生成审计报告，不恢复付费任务：

```powershell
node scripts/task-replay/cli.mjs report --bundle G:/Replay/pilot-bundle
```

已经执行过的 bundle 禁止再次 run。需要重新实验时创建新的 bundle，避免不确定的请求被悄悄重放。容器清理未确认会保存确切名称并停止后续运行；只能显式清理该 bundle 登记的名称：

```powershell
node scripts/task-replay/cli.mjs cleanup --bundle G:/Replay/pilot-bundle --container replay-已登记的UUID
```

## 当前验证范围

最初实现验收使用 Node/Git 和零付费夹具，未发现 Docker。Node 回归验证真实临时 Git 快照、未来提交不可达、只读原仓库、假 API 工具循环、预算公平性及失败报告；Docker 参数与清理仅用假执行器验证。Windows 文件符号链接创建权限不足的用例明确跳过，硬链接/junction 用例实际执行。后续经用户明确要求执行了纯文本真实 API 对照，见下方记录；该试验不包含代码执行或 Docker 实机验证。

先选有真实起点证据的少量任务，冻结验收项与预算，再执行真实对照。无法恢复历史 dirty/untracked 状态的样本留在近似组，不与精确现场混称。

### 2026-10-29 交付验证

- `corepack pnpm test:task-replay`：53 项，52 通过、1 跳过、0 失败。跳过的是 Windows 文件符号链接创建，硬链接和 junction 拒绝测试通过。
- `cargo test --lib decisions::protocol -- --nocapture`：3/3 通过；原生与回放共用的提问合同校验通过。
- 实际 CLI `init → prepare → plan → run --fixture → report` 完整执行；合成 A/B 中 A 返工一次、B 无返工，7 个响应全部来自 JSON 夹具，真实 API 请求为 0。中断恢复入口没有调用模型，重复 run 被拒绝。
- 独立只读审阅发现的配对预算、测试后证据漂移和容器清理状态问题均已修复并加入回归；复核未发现新的明确阻断项。
- [示例报告（合成夹具）](../.artifacts/task-replay-demo-final-bff500e8/results/report.md)、[最终 Node 测试日志](../.artifacts/task-replay-tests-delivery-final.log)、[原生合同日志](../.artifacts/task-replay-contract-native-final.log)。这些文件是本地验收证据，不作为真实提效数据。

### 2026-10-29 首轮真实交接对照

用户明确要求执行后，完成 8 对真实历史文本重建样本、16 次任务运行、44 次真实 API 请求。主模型及独立评审均为 Astra medium/default，辅助为 Luna Decisions。两组最终均 8/8 通过，首轮各遗漏一项、各返工一次；平均模型流程耗时 A 12.296 秒、B 13.500 秒，含评审的验收耗时 A 20.488 秒、B 21.309 秒。8 对中 B 五对更快、三对更慢，未显示稳定净提效。

费用含缓存写入差价。冻结运行器没有保留零写入计数的字段存在性，因此本批使用保守区间：业务费用 A $0.442239–$0.448914、B $0.444138–$0.446707，区间重叠；含评审总计 $1.737192–$1.746436。源运行器已修复缺写入计数误记零并校验计数上界，API/报告/编排/CLI 26 项回归通过；冻结实验未改写或重复执行。

这是既有总结的交接文本整理，不含记忆重排、代码任务、Docker 或人工耗时；严格历史现场样本为零。详见[完整首轮报告](../.artifacts/task-replay-real-pilot-final.md)及其中的来源、逐项评审和原始运行文件。

### 后续记忆与代码对照准备

真实记忆库冻结时为 29 条 active 记录，28 条带适用条件，仅一条无条件。8 条真实来源查询经现有词法检索和关系处理后，开／关均保持相同候选原文与顺序；开启组全部 `conditional_candidates` 跳过，helper/API 调用为零。有效重排干预样本为 0，不继续用相同输入支付主模型 A/B，也不删条件来制造干预。详见[记忆预检报告](../.artifacts/task-replay-memory-preflight-20261029.md)。

三个真实历史代码缺陷曾冻结修复前树，并仅叠加固定验收测试，全部标为近似重建。代码 A/B 已按用户要求取消，未运行，云端输入包未上传；快照和前期资源/计时合同作为离线资料保留，不再等待恢复登录或安装隔离环境。详见[代码准备历史记录](../.artifacts/task-replay-code-preparation-20261029.md)。

批量快照新增验证：15/15 快照回归及 10/10 编排/CLI 回归通过。Windows 上 1,716 文件、约 22.5 MB 的完整准备实测 35.419 秒；文件清单、模式、字节哈希与合成 commit 均和旧实现一致。这是快照准备阶段测量，不代表模型或代码执行提效。
