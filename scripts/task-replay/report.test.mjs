import test from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, summarizeRun, buildComparison, renderReport } from './report.mjs';
const pricing = { inputPerMillion: 10, cachedInputPerMillion: 2, outputPerMillion: 20, source: 'synthetic fixture', asOf: '2026-10-29', currency: 'USD' };
const usage = { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, cacheWriteTokens: 0 };
const round = (omittedIds = [], accepted = true) => ({ accepted, omittedIds, uncertainIds: [], criticalMissingIds: [] });
const call = (role = 'primary', extra = {}) => ({ role, status: 'completed', elapsedMs: 100, usage, pricing, ...extra });
const run = (arm, extra = {}) => ({ caseId: 'synthetic', runId: arm, arm, repeat: 1, order: arm === 'A' ? 1 : 2, fidelity: 'recorded', status: 'completed', elapsedMs: 1000, rounds: [round()], calls: [call()], tools: [], assistance: { status: 'skipped' }, ...extra });
const compare = runs => buildComparison({ schemaVersion: 1, suiteId: 'fixture', runs });
test('cache reads are charged once, at cached rate', () => {
    assert.deepEqual(priceUsage(usage, pricing), { usd: 0.0088, unknown: false });
    assert.equal(priceUsage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }, pricing).usd, 0);
});
test('unknown counts, illegal counts and missing pricing metadata never become zero', () => {
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens']) {
        for (const value of [null, undefined, -1, NaN, Infinity, 0.5, '1'])
            assert.equal(priceUsage({ ...usage, [field]: value }, pricing).usd, null);
    }
    for (const field of ['source', 'asOf', 'currency', 'inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
        assert.equal(priceUsage(usage, { ...pricing, [field]: undefined }).unknown, true);
    }
    assert.equal(priceUsage(usage, null).unknown, true);
    assert.equal(priceUsage({ ...usage, cachedInputTokens: 1001 }, pricing).unknown, true);
    assert.equal(priceUsage(usage, { ...pricing, source: ' ' }).unknown, true);
});
test('cache write requires rate and explicit included or additional mode', () => {
    const u = { ...usage, cacheWriteTokens: 200 };
    assert.equal(priceUsage(u, pricing).unknown, true);
    assert.equal(priceUsage(u, { ...pricing, cacheWritePerMillion: 5 }).unknown, true);
    assert.equal(priceUsage(u, { ...pricing, cacheWriteMode: 'included' }).unknown, true);
    assert.equal(priceUsage(u, { ...pricing, cacheWritePerMillion: 5, cacheWriteMode: 'included' }).usd, 0.0088);
    assert.equal(priceUsage(u, { ...pricing, cacheWritePerMillion: 5, cacheWriteMode: 'additional' }).usd, 0.0098);
    assert.equal(priceUsage({ ...usage, cacheWriteTokens: null }, pricing).unknown, true);
    assert.equal(priceUsage({ ...usage, cacheWriteTokens: 601 }, { ...pricing, cacheWritePerMillion: 5, cacheWriteMode: 'additional' }).reason, 'cache_write_exceeds_uncached_input');
});
test('workflow unknown does not masquerade as known subtotal; judge costs stay separate', () => {
    const m = summarizeRun(run('A', { calls: [call(), call('decisions', { pricing: undefined, status: 'failed' }), call('judge')] }));
    assert.equal(m.workflowCostUsd, null);
    assert.equal(m.judgeCostUsd, 0.0088);
    assert.equal(m.totalKnownCostUsd, 0.0176);
    assert.equal(m.requestCount, 3);
    assert.equal(m.workflowRequestCount, 2);
    assert.equal(m.judgeRequestCount, 1);
    assert.equal(m.failedRequestCount, 1);
    assert.equal(m.cachedInputTokens, 1200);
    assert.deepEqual(m.roleElapsedMs, { primary: 100, decisions: 100, judge: 100 });
    const judgeUnknown = summarizeRun(run('B', { calls: [call(), call('judge', { usage: null })] }));
    assert.equal(judgeUnknown.workflowCostUsd, 0.0088);
    assert.equal(judgeUnknown.judgeCostUsd, null);
    assert.equal(judgeUnknown.cachedInputTokens, null);
});
test('failed, interrupted, blocked and unaccepted samples have no acceptance time', () => {
    for (const status of ['failed', 'interrupted', 'blocked']) {
        const m = summarizeRun(run('A', { status }));
        assert.equal(m.elapsedMs, null);
        assert.equal(m.timeToAcceptanceMs, null);
        assert.equal(m.observedElapsedMs, 1000);
    }
    assert.equal(summarizeRun(run('A', { rounds: [round([], false)] })).timeToAcceptanceMs, null);
    assert.equal(summarizeRun(run('A', { rounds: [] })).final.omissionCount, null);
});
test('slower but fewer reworks remains visible as mixed outcome', () => {
    const c = compare([run('A', { rounds: [round(['x'], false), round([], false), round()] }), run('B', { elapsedMs: 2500 })]);
    assert.equal(c.pairs[0].delta.elapsedMs, 1500);
    assert.equal(c.pairs[0].delta.reworks, -2);
    assert.equal(c.pairs[0].delta.omissionCount, 0);
    assert.deepEqual(c.summary.acceptanceTime, { denominator: 1, successfulPairs: 1, sampleCount: 1, medianDeltaMs: 1500 });
});
test('failure pairs retained as strict; missing pairs and reconstructed excluded from strict', () => {
    const c = compare([
        run('A', { status: 'failed' }), run('B', { status: 'interrupted' }),
        run('A', { caseId: 'missing' }),
        run('A', { caseId: 'approx', fidelity: 'reconstructed' }), run('B', { caseId: 'approx' }),
    ]);
    assert.equal(c.summary.totalPairs, 3);
    assert.equal(c.summary.completePairs, 2);
    assert.equal(c.summary.strictPairs, 1);
    assert.deepEqual(c.summary.failuresByArm, { A: 1, B: 1 });
    assert.equal(c.pairs[0].delta.timeToAcceptanceMs, null);
    assert.equal(c.pairs[1].B, null);
    assert.equal(c.pairs[1].delta.reworks, null);
    assert.equal(c.summary.unknownCostPairs, 1);
    assert.equal(c.summary.acceptanceTime.sampleCount, 1);
    assert.equal(c.summary.strictAcceptanceTime.sampleCount, 0);
});
test('unknown cost propagates into pair differences and median uses only known paired successes', () => {
    const c = compare([run('A'), run('B', { elapsedMs: 3000, calls: [call('primary', { pricing: null })] }),
        run('A', { repeat: 2, elapsedMs: 5000 }), run('B', { repeat: 2, elapsedMs: 1000 }),
        run('A', { repeat: 3, elapsedMs: null }), run('B', { repeat: 3 })]);
    assert.equal(c.pairs[0].delta.workflowCostUsd, null);
    assert.equal(c.summary.unknownCostPairs, 1);
    assert.deepEqual(c.summary.acceptanceTime, { denominator: 3, successfulPairs: 3, sampleCount: 2, medianDeltaMs: -1000 });
});
test('duplicate arms are preserved but cannot create an arbitrary comparison', () => {
    const c = compare([run('A'), run('A', { runId: 'A2' }), run('B')]);
    assert.equal(c.runs.length, 3);
    assert.equal(c.pairs[0].ambiguous, true);
    assert.equal(c.pairs[0].strictEligible, false);
    assert.equal(c.pairs[0].delta.elapsedMs, null);
});
test('allowlisted output does not leak prompts, IDs of omissions, reasons or unrelated metadata', () => {
    const secret = 'SYNTHETIC_PRIVATE_SENTINEL';
    const c = buildComparison({ schemaVersion: 1, suiteId: 'fixture', secret, runs: [run('A', {
                prompt: secret, metadata: { secret }, rounds: [round([secret])],
                assistance: { status: 'unchanged', reason: secret }, calls: [call('primary', { prompt: secret, pricing: { ...pricing, secret } })],
            })] });
    assert.ok(!JSON.stringify(c).includes(secret));
    assert.ok(!renderReport(c).includes(secret));
});
test('Chinese report labels unknown, failures, API markers, judge costs and denominators', () => {
    const c = compare([run('A', { status: 'failed', calls: [call('primary', { usage: null })] }), run('B', { assistance: { status: 'unchanged' } }), run('A', { caseId: 'missing' })]);
    const markdown = renderReport(c);
    for (const expected of ['回放对照，不等于人工节省时间', '失败', '未知', '缺失', '严格', 'API已跳过', '未改变', '评测 judge 费用', '不是账单', '配对分母 2', '1.000 秒'])
        assert.ok(markdown.includes(expected), expected);
    const failureLine = markdown.split('\n').find(line => line.includes('| 失败 |'));
    assert.ok(failureLine.includes('| 未知 |'));
    assert.ok(!failureLine.includes('0.000 秒'));
});
