#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSuite, planSuite, runSuite, recoverReport, cleanupRecordedContainer } from './runner.mjs';
import { captureSnapshot } from './snapshot.mjs';
import { doctorDocker } from './tools.mjs';
export function exampleSuite() {
    return { schemaVersion: 1, id: 'historical-task-pilot', seed: 'pilot-01', repeats: 1,
        primary: { model: 'gpt-6-astra', effort: 'high', maxOutputTokens: 2048 }, judge: { model: 'gpt-6-astra', effort: 'high', maxOutputTokens: 2048 }, decisions: { model: 'gpt-6-luna' },
        limits: { maxRequests: 60, maxReworks: 2, maxToolSteps: 8, requestTimeoutMs: 60000, maxInputBytes: 262144, maxRunMs: 600000 }, pricing: {},
        cases: [{ id: 'handoff-example', kind: 'handoff', prompt: '请把初始摘要整理为可继续工作的交接稿，保留修正、待办和验证边界。', source: '替换为真实任务在固定时间点已经可见的原始资料。', initialDraft: '替换为当时的初始交接摘要。', requirements: [{ id: 'latest-correction', description: '替换为根据原始资料提前制定的验收项。', critical: true }], provenance: { taskStartedAt: '2026-01-01T00:00:00Z', snapshotRecordedAtStart: false, evidence: '示例占位；尚无历史现场证据。' }, allowWrite: false, recipes: [] }] };
}
function argumentsOf(args) { const options = {}; for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--'))
        throw Error('invalid_arguments');
    if (['--live', '--key-file'].includes(key))
        throw Error('live_execution_removed');
    if (i + 1 === args.length || args[i + 1].startsWith('--'))
        throw Error('missing_argument_value');
    options[key.slice(2)] = args[++i];
} return options; }
const json = async (file) => {
    const resolved = path.resolve(file), stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('invalid_input_file');
    return JSON.parse(await fs.readFile(resolved, 'utf8'));
};
export async function main(argv = process.argv.slice(2)) {
    const [command, ...rest] = argv, o = argumentsOf(rest);
    const only = allowed => { if (Object.keys(o).some(k => !allowed.includes(k)))
        throw Error('unknown_option'); };
    if (!command || command === 'help')
        return { commands: ['init --out suite.json', 'capture --repo PATH --commit FULL_SHA --mode commit|working-tree --out SNAPSHOT', 'prepare --spec suite.json --out NEW_BUNDLE', 'plan --bundle BUNDLE', 'doctor', 'run --bundle BUNDLE --fixture responses.json', 'report --bundle BUNDLE', 'cleanup --bundle BUNDLE --container RECORDED_NAME'], note: 'Offline only. Live API execution and credential handling were removed. run requires a local JSON fixture.' };
    if (command === 'init') {
        only(['out']);
        await fs.writeFile(path.resolve(o.out), JSON.stringify(exampleSuite(), null, 2) + '\n', { flag: 'wx' });
        return { template: path.resolve(o.out), placeholder: true };
    }
    if (command === 'capture') {
        only(['repo', 'commit', 'mode', 'out']);
        return captureSnapshot({ repoRoot: path.resolve(o.repo), commit: o.commit, mode: o.mode ?? 'commit', outDir: path.resolve(o.out) });
    }
    if (command === 'prepare') {
        only(['spec', 'out']);
        return prepareSuite(await json(o.spec), { outDir: path.resolve(o.out), baseDir: path.dirname(path.resolve(o.spec)) });
    }
    if (command === 'plan') {
        only(['bundle']);
        return planSuite(o.bundle);
    }
    if (command === 'doctor') {
        only([]);
        return { node: process.version, docker: await doctorDocker(), liveExecutionSupported: false };
    }
    if (command === 'report') {
        only(['bundle']);
        return recoverReport(o.bundle);
    }
    if (command === 'cleanup') {
        only(['bundle', 'container']);
        return cleanupRecordedContainer(o.bundle, o.container);
    }
    if (command === 'run') {
        only(['bundle', 'fixture']);
        if (!o.fixture)
            throw Error('fixture_required');
        const control = new AbortController(), stop = () => control.abort();
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        try {
            return await runSuite(o.bundle, { fixture: await json(o.fixture), signal: control.signal });
        }
        finally {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
        }
    }
    throw Error('unknown_command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(value => {
        process.stdout.write(JSON.stringify(value, null, 2) + '\n');
        if (Array.isArray(value?.runs) && value.runs.some(r => r.status !== 'completed') || value?.status === 'unknown') process.exitCode = 1;
    }).catch(error => {
        const code = /^[a-z][a-z0-9_]{1,80}$/.test(error.message) ? error.message
            : error.code === 'EEXIST' ? 'target_exists' : error.code === 'ENOENT' ? 'path_not_found'
                : error instanceof SyntaxError ? 'invalid_json' : 'replay_command_failed';
        process.stderr.write(JSON.stringify({ error: code }) + '\n');
        process.exitCode = 1;
    });
}
