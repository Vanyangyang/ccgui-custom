/** Pure replay metrics. No I/O; only explicitly selected metadata leaves this module. */
const count = n => Number.isSafeInteger(n) && n >= 0;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const unknown = reason => ({ usd: null, unknown: true, reason });
const roles = ['primary', 'decisions', 'judge'];
const text = value => typeof value === 'string' ? value : null;
const sumKnown = values => values.every(finite) && Number.isFinite(values.reduce((a, b) => a + b, 0))
    ? values.reduce((a, b) => a + b, 0) : null;
export function priceUsage(usage, pricing) {
    if (!pricing || !text(pricing.source)?.trim() || !text(pricing.asOf)?.trim() || pricing.currency !== 'USD')
        return unknown('missing_pricing_metadata');
    if (!['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion'].every(k => finite(pricing[k])))
        return unknown('invalid_pricing');
    if (!usage || !['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'].every(k => count(usage[k])))
        return unknown('unknown_or_invalid_usage');
    const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens } = usage;
    if (cachedInputTokens > inputTokens)
        return unknown('cached_input_exceeds_input');
    if (cacheWriteTokens > inputTokens - cachedInputTokens)
        return unknown('cache_write_exceeds_uncached_input');
    if (cacheWriteTokens > 0 && (!finite(pricing.cacheWritePerMillion) || !['additional', 'included'].includes(pricing.cacheWriteMode)))
        return unknown('unknown_cache_write_pricing');
    // inputTokens includes cache reads. Writes use normal input pricing in included mode;
    // additional mode adds the explicitly supplied write rate, never infers vendor semantics.
    const usd = ((inputTokens - cachedInputTokens) * pricing.inputPerMillion + cachedInputTokens * pricing.cachedInputPerMillion +
        outputTokens * pricing.outputPerMillion + (cacheWriteTokens > 0 && pricing.cacheWriteMode === 'additional' ? cacheWriteTokens * pricing.cacheWritePerMillion : 0)) / 1e6;
    return Number.isFinite(usd) ? { usd, unknown: false } : unknown('cost_overflow');
}
const roundCounts = round => Object.fromEntries([
    ['omissionCount', 'omittedIds'], ['uncertaintyCount', 'uncertainIds'], ['criticalMissingCount', 'criticalMissingIds'],
].map(([name, key]) => [name, Array.isArray(round?.[key]) ? round[key].length : null]));
export function summarizeRun(run) {
    const rounds = Array.isArray(run.rounds) ? run.rounds : [];
    const calls = Array.isArray(run.calls) ? run.calls : [];
    const startedRounds = Array.isArray(run.roundStarts) ? new Set(run.roundStarts.filter(count)).size : rounds.length;
    const accepted = run.status === 'completed' && rounds.at(-1)?.accepted === true;
    const prices = calls.map(call => priceUsage(call.usage, call.pricing));
    const costFor = predicate => sumKnown(prices.filter((_, i) => predicate(calls[i])).map(p => p.usd));
    const workflow = c => c.role !== 'judge';
    const usageTotal = key => sumKnown(calls.map(c => count(c.usage?.[key]) ? c.usage[key] : null));
    return {
        caseId: text(run.caseId), runId: text(run.runId), arm: ['A', 'B'].includes(run.arm) ? run.arm : null,
        repeat: count(run.repeat) ? run.repeat : null, order: typeof run.order === 'number' && finite(run.order) ? run.order : null,
        fidelity: ['recorded', 'reconstructed'].includes(run.fidelity) ? run.fidelity : 'unknown',
        status: ['completed', 'failed', 'interrupted', 'blocked'].includes(run.status) ? run.status : 'unknown',
        accepted, elapsedMs: accepted && finite(run.elapsedMs) ? run.elapsedMs : null,
        timeToAcceptanceMs: accepted && finite(run.elapsedMs) ? run.elapsedMs : null,
        observedElapsedMs: finite(run.elapsedMs) ? run.elapsedMs : null,
        reworks: Math.max(0, startedRounds - 1), initial: roundCounts(rounds[0]), final: roundCounts(startedRounds > rounds.length ? null : rounds.at(-1)),
        workflowCostUsd: costFor(workflow), judgeCostUsd: costFor(c => c.role === 'judge'),
        totalKnownCostUsd: sumKnown(prices.filter(p => !p.unknown).map(p => p.usd)),
        unknownCostRequests: prices.filter(p => p.unknown).length,
        requestCount: calls.length, workflowRequestCount: calls.filter(workflow).length,
        judgeRequestCount: calls.filter(c => c.role === 'judge').length,
        failedRequestCount: calls.filter(c => c.status === 'failed').length,
        unknownStatusRequestCount: calls.filter(c => !['completed', 'failed'].includes(c.status)).length,
        cachedInputTokens: usageTotal('cachedInputTokens'), inputTokens: usageTotal('inputTokens'), outputTokens: usageTotal('outputTokens'),
        cacheWriteTokens: sumKnown(calls.map(c => count(c.usage?.cacheWriteTokens) ? c.usage.cacheWriteTokens : null)),
        roleElapsedMs: Object.fromEntries(roles.map(role => [role, sumKnown(calls.filter(c => c.role === role).map(c => c.elapsedMs))])),
        toolElapsedMs: sumKnown((Array.isArray(run.tools) ? run.tools : []).map(t => t.elapsedMs)),
        assistance: { status: ['skipped', 'unchanged', 'changed', 'applied', 'unavailable', 'completed', 'failed', 'blocked', 'disabled', 'not_requested'].includes(run.assistance?.status) ? run.assistance.status : 'unknown' },
        preparationMs: finite(run.preparationMs) ? run.preparationMs : null,
        pricingMetadata: calls.filter(c => c.pricing).map(c => ({ source: text(c.pricing.source), asOf: text(c.pricing.asOf), currency: c.pricing.currency === 'USD' ? 'USD' : null })),
    };
}
const delta = (a, b) => typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) ? b - a : null;
const median = values => {
    if (!values.length)
        return null;
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timeSummary = pairs => {
    const successful = pairs.filter(p => p.complete && p.A.accepted && p.B.accepted);
    const values = successful.map(p => p.delta.timeToAcceptanceMs).filter(v => v !== null);
    return { denominator: pairs.length, successfulPairs: successful.length, sampleCount: values.length, medianDeltaMs: median(values) };
};
export function buildComparison(input) {
    if (input.schemaVersion !== 1 || !Array.isArray(input.runs))
        throw new TypeError('Expected schemaVersion 1 and runs array');
    const runs = input.runs.map(summarizeRun), groups = new Map();
    for (const run of runs) {
        const key = JSON.stringify([run.caseId, run.repeat]);
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(run);
    }
    const pairs = [...groups.values()].map(group => {
        const A = group.filter(r => r.arm === 'A'), B = group.filter(r => r.arm === 'B');
        const complete = A.length === 1 && B.length === 1 && group.length === 2;
        const a = A[0] ?? null, b = B[0] ?? null;
        return { caseId: group[0].caseId, repeat: group[0].repeat, A: a, B: b, complete,
            strictEligible: complete && a.fidelity === 'recorded' && b.fidelity === 'recorded',
            ambiguous: A.length > 1 || B.length > 1 || group.some(r => r.arm === null),
            delta: Object.fromEntries([
                ['elapsedMs', a?.elapsedMs, b?.elapsedMs], ['timeToAcceptanceMs', a?.timeToAcceptanceMs, b?.timeToAcceptanceMs],
                ['omissionCount', a?.final.omissionCount, b?.final.omissionCount], ['uncertaintyCount', a?.final.uncertaintyCount, b?.final.uncertaintyCount],
                ['criticalMissingCount', a?.final.criticalMissingCount, b?.final.criticalMissingCount], ['reworks', a?.reworks, b?.reworks],
                ['workflowCostUsd', a?.workflowCostUsd, b?.workflowCostUsd], ['judgeCostUsd', a?.judgeCostUsd, b?.judgeCostUsd],
            ].map(([key, av, bv]) => [key, complete ? delta(av, bv) : null])),
        };
    });
    const strict = pairs.filter(p => p.strictEligible);
    const removed = new Set((input.cleanupReceipts ?? []).filter(r => r.status === 'removed').map(r => r.containerName));
    const pendingContainers = [...new Set(input.runs.flatMap(r => (r.tools ?? []).filter(t => t.details?.reason === 'container_cleanup_unconfirmed' && /^replay-[a-f0-9-]{36}$/.test(t.details.containerName ?? '')).map(t => t.details.containerName)))].filter(n => !removed.has(n));
    return { schemaVersion: 1, suiteId: text(input.suiteId), runs, pairs, pendingContainers, summary: {
            totalPairs: pairs.length, completePairs: pairs.filter(p => p.complete).length, strictPairs: strict.length,
            failuresByArm: Object.fromEntries(['A', 'B'].map(arm => [arm, runs.filter(r => r.arm === arm && r.status !== 'completed').length])),
            unknownCostPairs: pairs.filter(p => p.delta.workflowCostUsd === null).length,
            acceptanceTime: timeSummary(pairs), strictAcceptanceTime: timeSummary(strict),
        } };
}
const cell = value => String(value ?? '未知').replace(/[\r\n]/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const seconds = n => finite(n) ? `${(n / 1000).toFixed(3)} 秒` : '未知';
const money = n => finite(n) ? `$${n.toFixed(6)}` : '未知';
const statusLabel = { completed: '完成', failed: '失败', interrupted: '中断', blocked: '阻塞', unknown: '未知' };
const apiLabel = { skipped: 'API已跳过', unchanged: '未改变', changed: '已改变', applied: '已重排', unavailable: '不可用，已回退', completed: '完成', failed: '失败', blocked: '阻塞', disabled: '未启用', not_requested: '未请求', unknown: '未知' };
export function renderReport(comparison) {
    const s = comparison.summary;
    const lines = ['# 回放对照报告', '', '回放对照，不等于人工节省时间。样本结果不代表普遍提效或统计显著。', '',
        comparison.executionMode === 'fixture' ? '本报告来自零付费夹具，不是实际模型效果或耗时。' : '本报告记录配置模型的回放流程，不代表人工工作耗时。',
        'recorded 依据冻结快照与操作者提供的任务起点证据；工具不会独立证明历史时间。', '',
        `共 ${s.totalPairs} 对，完整 ${s.completePairs} 对，严格（recorded）${s.strictPairs} 对；失败/中断/阻塞/未知：A ${s.failuresByArm.A}，B ${s.failuresByArm.B}。`,
        `业务费用未知配对：${s.unknownCostPairs}。金额仅为基于 pricing 的美元估算，不是账单；已知小计不代表总费用。`, '',
        '| 任务 / 重复 | 样本 | 组 | 状态 | 实际运行耗时 | 验收耗时 | 初始→最终遗漏 | 最终未决/关键缺口 | 返工 | 业务费用 | 评测 judge 费用 | API / 辅助 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
    for (const p of comparison.pairs) {
        for (const arm of ['A', 'B']) {
            const matches = comparison.runs.filter(r => r.caseId === p.caseId && r.repeat === p.repeat && r.arm === arm);
            for (const r of matches.length ? matches : [null])
                lines.push(`| ${cell(p.caseId)} / ${cell(p.repeat)} | ${p.strictEligible ? '严格' : p.complete ? '近似/未知保真度' : '不完整/配对歧义'} | ${arm} | ${r ? statusLabel[r.status] : '缺失'} | ${seconds(r?.observedElapsedMs)} | ${seconds(r?.timeToAcceptanceMs)} | ${cell(r?.initial.omissionCount)}→${cell(r?.final.omissionCount)} | ${cell(r?.final.uncertaintyCount)}/${cell(r?.final.criticalMissingCount)} | ${cell(r?.reworks)} | ${money(r?.workflowCostUsd)} | ${money(r?.judgeCostUsd)} | ${r ? apiLabel[r.assistance.status] : '未知'} |`);
        }
    }
    lines.push('', '差值方向为 B−A；验收耗时仅对最终验收通过且 completed 的样本定义。失败样本保留，不能记为完成耗时 0。');
    for (const [label, t] of [['全部样本', s.acceptanceTime], ['严格样本', s.strictAcceptanceTime]]) {
        lines.push(`- ${label}：配对分母 ${t.denominator}，双侧成功 ${t.successfulPairs}，有已知耗时 ${t.sampleCount}，验收耗时中位差 ${t.medianDeltaMs === null ? '未知' : `${(t.medianDeltaMs / 1000).toFixed(3)} 秒`}。`);
    }
    lines.push('', '缓存读取从总输入中扣除后单独计费。缓存写入非零时必须给出费率与模式：included 不重复加费，additional 另加写入费用。', '', '定价元数据（未访问任何来源链接）：');
    const metadata = new Set(comparison.runs.flatMap(r => r.pricingMetadata.map(m => `${cell(m.source)}；日期 ${cell(m.asOf)}；${cell(m.currency)}`)));
    lines.push(...(metadata.size ? [...metadata].map(m => `- ${m}`) : ['- 未知']));
    if (comparison.pendingContainers?.length)
        lines.push('', '容器清理尚未确认；后续运行已停止。可使用 cleanup 子命令逐个处理已登记的容器：', ...comparison.pendingContainers.map(n => `- \`${cell(n)}\``));
    return `${lines.join('\n')}\n`;
}
