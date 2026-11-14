import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { exampleSuite } from './cli.mjs';
import { prepareSuite, loadBundle, runSuite, recoverReport, cleanupRecordedContainer } from './runner.mjs';
import { summarizeRun } from './report.mjs';
import { CHECK_IDS } from './schema.mjs';
import { createFixtureClient } from './api.mjs';
test('retired paid execution is rejected before reading a bundle or creating output', async () => {
    await assert.rejects(runSuite('C:/nonexistent-replay-bundle', { live: true }), /live_execution_removed/);
});
const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } };
const response = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage });
const judged = status => response(JSON.stringify({ items: [{ id: 'latest-correction', status, evidence: 'frozen source' }] }));
const decisions = { model: 'gpt-6-luna', answers: CHECK_IDS.map(name => ({ name, type: 'predicate', probability: 0.2 })), usage };
async function directory(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-replay-runner-')); t.after(async () => { assert.ok(root.startsWith(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }); return root; }
test('paired handoff loop, blind judging, fixed rework limit and separate cost report', async (t) => {
    const root = await directory(t), spec = exampleSuite(), bundle = path.join(root, 'bundle');
    spec.seed = 'test';
    spec.limits.maxReworks = 1;
    await prepareSuite(spec, { outDir: bundle });
    const b = await loadBundle(bundle), steps = [];
    for (const p of b.suite.plan) {
        if (p.arm === 'B')
            steps.push({ role: 'decisions', response: decisions });
        steps.push({ role: 'primary', response: response(p.arm === 'A' ? 'first missing correction' : 'complete answer') }, { role: 'judge', response: judged(p.arm === 'A' ? 'missing' : 'met') });
        if (p.arm === 'A')
            steps.push({ role: 'primary', response: response('reworked complete') }, { role: 'judge', response: judged('met') });
    }
    const result = await runSuite(bundle, { fixture: { steps } });
    assert.equal(result.status, 'completed');
    assert.equal(result.requests, 7);
    assert.ok(result.runs.every(r => r.status === 'completed'));
    const state = JSON.parse(await fs.readFile(path.join(result.results, 'state.json'), 'utf8')), a = state.runs.find(r => r.arm === 'A'), bb = state.runs.find(r => r.arm === 'B');
    assert.equal(a.rounds.length, 2);
    assert.equal(bb.rounds.length, 1);
    assert.equal(a.rounds[0].omittedIds.length, 1);
    assert.equal(bb.calls.filter(c => c.role === 'decisions').length, 1);
    const report = await fs.readFile(path.join(result.results, 'report.md'), 'utf8');
    assert.match(report, /零付费夹具/);
    assert.match(report, /未知/);
    await assert.rejects(runSuite(bundle, { fixture: { steps } }), /EEXIST/);
});
test('judge never receives arm, ordered assisted memories, or advisory telemetry', async (t) => {
    const root = await directory(t), bundle = path.join(root, 'bundle'), spec = exampleSuite();
    await prepareSuite(spec, { outDir: bundle });
    const bodies = [];
    const createClient = options => createFixtureClient({ ...options, fetchImpl: async (url, o) => { const body = JSON.parse(o.body); bodies.push(body); return new Response(JSON.stringify(url.endsWith('decisions') ? decisions : body.text ? judged('met') : response('completed deliverable'))); } });
    await runSuite(bundle, { createClient });
    const judge = bodies.filter(b => b.text);
    assert.equal(judge.length, 2);
    for (const j of judge) {
        const data = JSON.parse(j.input[0].content[0].text);
        assert.ok(!('arm' in data));
        assert.ok(!('advisoryChecks' in data));
        assert.ok(!('calls' in data));
        assert.ok(!('runId' in data));
    }
});
test('insufficient budget blocks both arms before any paid request; report does not replay', async (t) => {
    const root = await directory(t), bundle = path.join(root, 'bundle'), spec = exampleSuite();
    spec.limits.maxRequests = 4;
    await prepareSuite(spec, { outDir: bundle });
    const b = await loadBundle(bundle), first = b.suite.plan[0].arm;
    const result = await runSuite(bundle, { fixture: { steps: [{ role: first === 'B' ? 'decisions' : 'primary', response: first === 'B' ? decisions : response('draft') }] } });
    assert.equal(result.status, 'completed');
    assert.equal(result.requests, 0);
    assert.equal(result.runs.length, 2);
    assert.ok(result.runs.every(r => r.status === 'blocked' && r.error === 'pair_budget_insufficient'));
    const recovered = await recoverReport(bundle);
    assert.equal(recovered.status, 'report_only_no_replay');
});
async function testBundle(t) {
    const root = await directory(t), repo = path.join(root, 'source');
    await fs.mkdir(repo);
    await fs.mkdir(path.join(repo, 'tests'));
    await fs.writeFile(path.join(repo, 'result.txt'), 'original');
    await fs.writeFile(path.join(repo, 'tests', 'check.mjs'), 'fixed validation');
    const git = args => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    const spec = exampleSuite();
    spec.cases[0].initialDraft = spec.cases[0].source;
    spec.cases[0].snapshot = { repoRoot: repo, commit: git(['rev-parse', 'HEAD']), mode: 'commit' };
    spec.cases[0].allowWrite = true;
    spec.cases[0].dockerImage = 'fixture@sha256:' + 'a'.repeat(64);
    spec.cases[0].recipes = [{ id: 'check', argv: ['node', 'tests/check.mjs'], protectedPaths: ['tests/check.mjs'], timeoutMs: 100 }];
    const bundle = path.join(root, 'bundle');
    await prepareSuite(spec, { outDir: bundle });
    return { root, repo, bundle };
}
function fakeDocker(onRun, { cleanupCode = 0, hang = false } = {}) {
    return (_command, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => { child.emit('close', null); };
        setImmediate(async () => {
            if (args[0] === 'info') {
                child.stdout.write(JSON.stringify({ OSType: 'linux', ServerVersion: 'fixture' }));
                child.emit('close', 0);
            }
            else if (args[0] === 'rm')
                child.emit('close', cleanupCode);
            else if (!hang) {
                try {
                    assert.ok(args.includes('none'));
                    const mount = args[args.indexOf('--mount') + 1];
                    assert.ok(mount.endsWith(',readonly'));
                    await onRun?.(mount.match(/^type=bind,source=(.*),target=/)[1]);
                    child.emit('close', 0);
                }
                catch {
                    child.emit('close', 1);
                }
            }
        });
        return child;
    };
}
const simpleClient = options => createFixtureClient({ ...options, fetchImpl: async (_url, o) => new Response(JSON.stringify(JSON.parse(o.body).text ? judged('met') : response('completed deliverable'))) });
for (const change of ['result.txt', 'tests/check.mjs'])
    test(`unexpected test mutation of ${change} blocks acceptance before judge`, async (t) => {
        const { bundle } = await testBundle(t);
        let judges = 0;
        const createClient = options => createFixtureClient({ ...options, fetchImpl: async (_url, o) => { if (JSON.parse(o.body).text)
                judges++; return new Response(JSON.stringify(response('done'))); } });
        const result = await runSuite(bundle, { createClient, toolSpawn: fakeDocker(async (root) => fs.writeFile(path.join(root, change), 'unexpected test mutation')) });
        assert.equal(judges, 0);
        assert.equal(result.status, 'interrupted');
        assert.ok(result.runs.some(r => ['validation_artifact_changed', 'validation_inputs_changed'].includes(r.error)));
        assert.ok(result.runs.every(r => r.status !== 'completed'));
    });
test('unconfirmed container cleanup stops suite, keeps exact identity and has explicit recovery only', async (t) => {
    const { bundle } = await testBundle(t), result = await runSuite(bundle, { createClient: simpleClient, toolSpawn: fakeDocker(null, { hang: true, cleanupCode: 1 }) });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.cleanupPending.length, 1);
    assert.ok(result.runs.some(r => r.error === 'container_cleanup_unconfirmed'));
    let calls = 0;
    const cleanup = async (name) => { calls++; return { status: 'removed', containerName: name }; };
    await assert.rejects(cleanupRecordedContainer(bundle, 'replay-00000000-0000-0000-0000-000000000000', { cleanup }), /not_recorded/);
    assert.equal(calls, 0);
    await cleanupRecordedContainer(bundle, result.cleanupPending[0], { cleanup });
    assert.equal(calls, 1);
    const recovered = await recoverReport(bundle);
    assert.ok(!(await fs.readFile(recovered.report, 'utf8')).includes('容器清理尚未确认'));
});
test('an unreviewed rework is counted and its final omission count remains unknown', async (t) => {
    const root = await directory(t), bundle = path.join(root, 'bundle'), spec = exampleSuite();
    spec.cases[0].initialDraft = spec.cases[0].source;
    await prepareSuite(spec, { outDir: bundle });
    const createClient = options => { let primary = 0; return createFixtureClient({ ...options, fetchImpl: async (_url, o) => { const body = JSON.parse(o.body); if (body.text)
            return new Response(JSON.stringify(judged('missing'))); if (primary++ === 0)
            return new Response(JSON.stringify(response('missing correction'))); throw Error('simulated unknown outcome'); } }); };
    const result = await runSuite(bundle, { createClient });
    assert.equal(result.status, 'interrupted');
    const state = JSON.parse(await fs.readFile(path.join(result.results, 'state.json')));
    const summary = summarizeRun(state.runs[0]);
    assert.equal(summary.reworks, 1);
    assert.equal(summary.final.omissionCount, null);
    assert.equal(summary.workflowCostUsd, null);
});
test('immutable task input cannot change after preparation', async (t) => {
    const root = await directory(t), bundle = path.join(root, 'bundle');
    await prepareSuite(exampleSuite(), { outDir: bundle });
    await fs.appendFile(path.join(bundle, 'cases', 'handoff-example', 'input.json'), ' ');
    await loadBundle(bundle);
    const file = path.join(bundle, 'cases', 'handoff-example', 'input.json'), v = JSON.parse(await fs.readFile(file));
    v.prompt = 'changed';
    await fs.writeFile(file, JSON.stringify(v));
    await assert.rejects(loadBundle(bundle), /input_hash_mismatch/);
});
test('historical code tool loop sees only independent snapshot; reasoning items survive stateless calls', async (t) => {
    const root = await directory(t), repo = path.join(root, 'source');
    await fs.mkdir(repo);
    const git = args => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--quiet']);
    await fs.writeFile(path.join(repo, 'rule.txt'), 'historical rule');
    git(['add', '.']);
    git(['commit', '-qm', 'old']);
    const commit = git(['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repo, 'rule.txt'), 'future answer');
    git(['commit', '-qam', 'future']);
    const spec = exampleSuite();
    spec.cases[0].snapshot = { repoRoot: repo, commit, mode: 'commit' };
    spec.cases[0].initialDraft = spec.cases[0].source;
    spec.limits.maxReworks = 0;
    const bundle = path.join(root, 'bundle');
    await prepareSuite(spec, { outDir: bundle });
    const inputs = [];
    const createClient = options => { let n = 0; return createFixtureClient({ ...options, fetchImpl: async (_url, o) => { const body = JSON.parse(o.body); inputs.push(body); return new Response(JSON.stringify(body.text ? judged('met') : n++ === 0 ? { status: 'completed', output: [{ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque' }, { type: 'function_call', name: 'read_file', call_id: 'call_fixture', arguments: JSON.stringify({ path: 'rule.txt', offset: 1, limit: 10 }) }], usage } : response('historical rule'))); } }); };
    const result = await runSuite(bundle, { createClient });
    assert.ok(result.runs.every(r => r.status === 'completed'));
    const continued = inputs.filter(x => x.input.some(i => i.type === 'function_call_output'));
    assert.equal(continued.length, 2);
    for (const body of continued) {
        assert.ok(body.input.some(x => x.type === 'reasoning' && x.encrypted_content === 'opaque'));
        assert.ok(body.input.some(x => x.type === 'function_call_output' && x.output.includes('historical rule')));
        assert.ok(!JSON.stringify(body).includes('future answer'));
    }
    assert.equal(await fs.readFile(path.join(repo, 'rule.txt'), 'utf8'), 'future answer');
});
