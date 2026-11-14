import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { captureSnapshot, verifySnapshot, materializeSnapshot } from './snapshot.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function git(root, ...args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
    return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], {
        cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' },
    }).trim();
}
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-snapshot-test-'));
    t.after(async () => {
        const real = await fs.realpath(root), temp = await fs.realpath(os.tmpdir());
        assert.equal(path.dirname(real), temp);
        assert.ok(path.basename(real).startsWith('task-snapshot-test-'));
        await fs.rm(real, { recursive: true, force: true });
    });
    const repo = path.join(root, 'source');
    await fs.mkdir(repo);
    git(repo, 'init', '--template=', '--initial-branch=main');
    await fs.writeFile(path.join(repo, 'base.txt'), 'old\r\n');
    await fs.writeFile(path.join(repo, 'deleted.txt'), 'delete me');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'one');
    const first = git(repo, 'rev-parse', 'HEAD');
    const out = path.join(root, 'snapshot');
    return { root, repo, first, out };
}
async function sourceState(repo) {
    const files = {};
    async function walk(dir, prefix = '') {
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
            const name = prefix + item.name;
            if (name === '.git')
                continue;
            if (item.isDirectory())
                await walk(path.join(dir, item.name), `${name}/`);
            else
                files[name] = digest(await fs.readFile(path.join(dir, item.name)));
        }
    }
    await walk(repo);
    return { files, index: digest(await fs.readFile(path.join(repo, '.git/index'))), refs: git(repo, 'show-ref'), head: git(repo, 'rev-parse', 'HEAD') };
}
test('historical bytes, future isolation, deterministic independent repositories, source read-only', async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'future-answer.txt'), 'future secret');
    await fs.writeFile(path.join(f.repo, 'base.txt'), 'new');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'future');
    const future = git(f.repo, 'rev-parse', 'HEAD');
    const before = await sourceState(f.repo);
    const m = await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    assert.equal(m.source.fidelity, 'commit-only');
    const a = await materializeSnapshot({ snapshotDir: f.out, targetDir: path.join(f.root, 'a') });
    const b = await materializeSnapshot({ snapshotDir: f.out, targetDir: path.join(f.root, 'b') });
    assert.equal(a.commit, b.commit);
    assert.equal(git(a.root, 'rev-list', '--all', '--count'), '1');
    assert.throws(() => git(a.root, 'show', future));
    assert.equal(git(a.root, 'remote'), '');
    await assert.rejects(fs.readFile(path.join(a.root, 'future-answer.txt')));
    await assert.rejects(fs.readFile(path.join(a.root, 'snapshot.json')));
    assert.equal(await fs.readFile(path.join(a.root, 'base.txt'), 'utf8'), 'old\r\n');
    await fs.writeFile(path.join(a.root, 'base.txt'), 'changed a');
    assert.equal(await fs.readFile(path.join(b.root, 'base.txt'), 'utf8'), 'old\r\n');
    assert.deepEqual(await sourceState(f.repo), before);
});
test('working tree captures dirty bytes, binary, untracked and deletion; ignores ignored files', async (t) => {
    const f = await fixture(t);
    const binary = Buffer.from([0, 255, 254, 10, 13]);
    await fs.writeFile(path.join(f.repo, 'base.txt'), 'dirty');
    await fs.unlink(path.join(f.repo, 'deleted.txt'));
    await fs.writeFile(path.join(f.repo, 'binary'), binary);
    await fs.writeFile(path.join(f.repo, '.gitignore'), 'ignored\n');
    await fs.writeFile(path.join(f.repo, 'ignored'), 'not captured');
    const before = await sourceState(f.repo);
    const m = await captureSnapshot({ repoRoot: f.repo, commit: f.first, mode: 'working-tree', outDir: f.out });
    assert.equal(m.source.fidelity, 'captured-working-tree');
    const a = await materializeSnapshot({ snapshotDir: f.out, targetDir: path.join(f.root, 'target'), initializeGit: false });
    assert.equal(a.commit, null);
    assert.deepEqual(await fs.readFile(path.join(a.root, 'binary')), binary);
    assert.equal(await fs.readFile(path.join(a.root, 'base.txt'), 'utf8'), 'dirty');
    assert.ok(!m.entries.some(e => ['deleted.txt', 'ignored'].includes(e.path)));
    assert.deepEqual(await sourceState(f.repo), before);
});
test('rejects abbreviated/non-commit IDs, mismatched HEAD, budgets, overlapping or existing destinations', async (t) => {
    const f = await fixture(t);
    const run = extra => captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out, ...extra });
    await assert.rejects(run({ commit: 'HEAD' }));
    await assert.rejects(run({ commit: git(f.repo, 'rev-parse', 'HEAD:base.txt') }));
    await assert.rejects(run({ outDir: path.join(f.repo, 'inside') }));
    await assert.rejects(run({ maxFiles: 1 }));
    await assert.rejects(fs.stat(path.join(f.out, 'snapshot.json')));
    await assert.rejects(run({}));
    await assert.rejects(run({ outDir: path.join(f.root, 'tiny'), maxBytes: 1 }));
    git(f.repo, 'commit', '--allow-empty', '-m', 'next');
    await assert.rejects(run({ mode: 'working-tree', outDir: path.join(f.root, 'mismatch') }));
});
test('rejects tampered blobs, manifest hashes, size and budget', async (t) => {
    const f = await fixture(t);
    const m = await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    const manifestFile = path.join(f.out, 'snapshot.json'), blob = path.join(f.out, 'blobs', m.entries[0].sha256);
    const original = await fs.readFile(blob);
    await fs.writeFile(blob, 'tamper');
    await assert.rejects(verifySnapshot(f.out));
    await fs.writeFile(blob, original);
    for (const patch of [{ treeHash: '0'.repeat(64) }, { totalBytes: -1 }, { budgets: { maxFiles: 0, maxBytes: 10 } }, { schemaVersion: 2 }]) {
        await fs.writeFile(manifestFile, JSON.stringify({ ...m, ...patch }));
        await assert.rejects(verifySnapshot(f.out));
    }
});
test('rejects traversal, Windows reserved paths, case collisions and file/directory conflicts', async (t) => {
    const f = await fixture(t);
    const m = await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    for (const bad of ['../escape', '/absolute', 'C:/drive', '.git/config', 'x/.GiT/y', 'NUL.txt', 'com1', 'x:ads', 'trailing.', 'space ', 'a\\b', '"leading', 'line\nbreak']) {
        const entries = [{ ...m.entries[0], path: bad }];
        await fs.writeFile(path.join(f.out, 'snapshot.json'), JSON.stringify({ ...m, entries, treeHash: digest(JSON.stringify(entries)), totalBytes: entries[0].size }));
        await assert.rejects(verifySnapshot(f.out), undefined, bad);
    }
    for (const names of [['A/x', 'a/y'], ['a', 'a/b']]) {
        const entries = names.map(name => ({ ...m.entries[0], path: name }));
        await fs.writeFile(path.join(f.out, 'snapshot.json'), JSON.stringify({ ...m, entries, treeHash: digest(JSON.stringify(entries)), totalBytes: entries.reduce((s, e) => s + e.size, 0) }));
        await assert.rejects(verifySnapshot(f.out));
    }
});

function interceptGit(t, intercept) {
    const original = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (command, args, options) => intercept(args, options) ?? original(command, args, options));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function reply(bytes) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => { child.stdout.end(bytes); child.emit('close', 0); });
    return child;
}
test('batch processes preserve binary/CRLF/Unicode paths and legacy commit identity with constant Git calls', async t => {
    const f = await fixture(t);
    const calls = [];
    interceptGit(t, args => { calls.push(args); });
    const counts = [];
    for (const count of [3, 40]) {
        const expected = new Map();
        for (let i = 0; i < count; i++) {
            const name = `空 格 😀/ file ${i}.bin`;
            const bytes = Buffer.from([0, 255, 254, 13, 10, i, 10, 0, 128]);
            expected.set(name, bytes);
            await fs.mkdir(path.dirname(path.join(f.repo, name)), { recursive: true });
            await fs.writeFile(path.join(f.repo, name), bytes);
        }
        await fs.writeFile(path.join(f.repo, 'empty'), '');
        await fs.writeFile(path.join(f.repo, '.gitattributes'), '*.bin text eol=lf\n*.txt text eol=lf\n');
        // Bypass fixture attributes too: the historical blobs contain exact bytes.
        for (const [name] of expected) {
            const oid = git(f.repo, 'hash-object', '-w', '--no-filters', '--', name);
            git(f.repo, 'update-index', '--add', '--cacheinfo', `100644,${oid},${name}`);
        }
        git(f.repo, 'add', 'empty', '.gitattributes');
        git(f.repo, 'commit', '-m', `batch ${count}`);
        const before = await sourceState(f.repo);
        const outDir = path.join(f.root, `snapshot-${count}`);
        calls.length = 0;
        const m = await captureSnapshot({ repoRoot: f.repo, commit: before.head, outDir });
        const captureCalls = calls.length;
        assert.equal(calls.filter(args => args.includes('--batch-check')).length, 1);
        assert.equal(calls.filter(args => args.includes('--batch')).length, 1);
        calls.length = 0;
        const result = await materializeSnapshot({ snapshotDir: outDir, targetDir: path.join(f.root, `target-${count}`) });
        counts.push([captureCalls, calls.length]);
        const hashes = calls.filter(args => args.includes('hash-object'));
        assert.equal(hashes.length, 1);
        assert.ok(hashes[0].includes('--stdin-paths') && hashes[0].includes('--no-filters'));
        for (const [name, bytes] of expected) {
            assert.deepEqual(await fs.readFile(path.join(result.root, name)), bytes);
            assert.equal(git(result.root, 'rev-parse', `HEAD:${name}`), git(f.repo, 'rev-parse', `HEAD:${name}`));
        }
        assert.equal(await fs.readFile(path.join(result.root, 'base.txt'), 'utf8'), 'old\r\n');
        // The old per-file --stdin path produces these same unfiltered blob IDs.
        for (const entry of m.entries) {
            const bytes = await fs.readFile(path.join(outDir, 'blobs', entry.sha256));
            const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
            assert.equal(git(result.root, 'rev-parse', `HEAD:${entry.path}`), oid);
        }
        const tree = git(f.repo, 'rev-parse', 'HEAD^{tree}');
        const commitBytes = Buffer.from(`tree ${tree}\nauthor Task Replay <replay@invalid> 946684800 +0000\ncommitter Task Replay <replay@invalid> 946684800 +0000\n\nTask replay snapshot\n`);
        assert.equal(result.commit, createHash('sha1').update(`commit ${commitBytes.length}\0`).update(commitBytes).digest('hex'));
        assert.deepEqual(await sourceState(f.repo), before);
    }
    assert.deepEqual(counts, [[7, 6], [7, 6]]);
});

test('batch preflight rejects aggregate byte budget before requesting content', async t => {
    const f = await fixture(t);
    const calls = [];
    interceptGit(t, args => { calls.push(args); });
    await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out, maxBytes: 10 }), /Byte budget/);
    assert.equal(calls.filter(args => args.includes('--batch-check')).length, 1);
    assert.equal(calls.filter(args => args.includes('--batch')).length, 0);
    assert.deepEqual(await fs.readdir(path.join(f.out, 'blobs')), []);
});

test('batch parser rejects wrong OID/type/size, truncation, separators and trailing output', async t => {
    const f = await fixture(t);
    const oid = git(f.repo, 'rev-parse', 'HEAD:base.txt');
    const mutations = [
        bytes => Buffer.from(bytes.toString().replace(oid, '0'.repeat(40))),
        bytes => Buffer.from(bytes.toString().replace(' blob ', ' tree ')),
        bytes => Buffer.from(bytes.toString().replace(' blob 5\n', ' blob 4\n')),
        bytes => bytes.subarray(0, bytes.length - 2),
        bytes => { const copy = Buffer.from(bytes); copy[copy.indexOf(10) + 6] = 0; return copy; },
        bytes => Buffer.concat([bytes, Buffer.from('x')]),
    ];
    let mutate;
    interceptGit(t, (args, options) => {
        if (args.includes('--batch')) {
            const input = git(f.repo, 'ls-tree', '-r', 'HEAD').split('\n').map(row => row.split(' ')[2].split('\t')[0]).join('\n') + '\n';
            const bytes = execFileSync('git', args, { ...options, input });
            return reply(mutate(bytes));
        }
    });
    for (const [i, mutation] of mutations.entries()) {
        mutate = mutation;
        await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: path.join(f.root, `bad-${i}`) }), /Git batch|Git output budget/);
    }
});

test('batch preflight rejects malformed sizes and extra or missing headers', async t => {
    const f = await fixture(t);
    const rows = git(f.repo, 'ls-tree', '-r', 'HEAD').split('\n');
    const oids = rows.map(row => row.split(' ')[2].split('\t')[0]);
    let response;
    interceptGit(t, args => {
        assert.ok(!args.includes('--batch'), 'invalid preflight must never read blobs');
        if (args.includes('--batch-check')) return reply(Buffer.from(response));
    });
    const valid = `${oids[0]} blob 5\n${oids[1]} blob 9\n`;
    const responses = [valid.replace('blob 5', 'blob -1'), valid.replace('blob 5', 'blob 9007199254740992'),
        valid.replace(oids[0], '0'.repeat(40)), valid.replace('blob', 'tree'), valid.split('\n')[0] + '\n', valid + 'extra\n'];
    for (const [i, value] of responses.entries()) {
        response = value;
        await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: path.join(f.root, `preflight-${i}`) }), /Git batch/);
    }
});

test('materialization rejects malformed or miscounted hash-object responses before indexing', async t => {
    const f = await fixture(t);
    await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    let response;
    interceptGit(t, args => {
        assert.ok(!args.includes('update-index'), 'invalid object IDs must never enter the index');
        if (args.includes('hash-object')) return reply(Buffer.from(response));
    });
    for (const [i, value] of ['', 'a'.repeat(40) + '\n', 'z'.repeat(40) + '\n' + 'a'.repeat(40) + '\n', 'a'.repeat(40) + '\n' + 'b'.repeat(40)].entries()) {
        response = value;
        await assert.rejects(materializeSnapshot({ snapshotDir: f.out, targetDir: path.join(f.root, `bad-hash-${i}`) }), /Invalid Git hash-object output/);
    }
});

test('empty commit snapshots materialize independent empty repositories', async t => {
    const f = await fixture(t);
    git(f.repo, 'rm', 'base.txt', 'deleted.txt');
    git(f.repo, 'commit', '-m', 'empty');
    const m = await captureSnapshot({ repoRoot: f.repo, commit: git(f.repo, 'rev-parse', 'HEAD'), outDir: f.out, maxFiles: 0, maxBytes: 0 });
    assert.deepEqual(m.entries, []);
    const result = await materializeSnapshot({ snapshotDir: f.out, targetDir: path.join(f.root, 'empty-target') });
    assert.equal(git(result.root, 'ls-tree', '-r', 'HEAD'), '');
    assert.equal(git(result.root, 'rev-list', '--all', '--count'), '1');
});
test('rejects junctions in snapshot and output ancestry', async (t) => {
    const f = await fixture(t);
    await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    const link = path.join(f.out, 'linked');
    await fs.symlink(f.repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifySnapshot(f.out));
    await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: path.join(link, 'nested') }));
});
test('rejects symbolic-link and gitlink tree entries', async (t) => {
    const f = await fixture(t);
    const oid = git(f.repo, 'rev-parse', 'HEAD:base.txt');
    git(f.repo, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
    git(f.repo, 'commit', '-m', 'symlink');
    await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: git(f.repo, 'rev-parse', 'HEAD'), outDir: f.out }));
    git(f.repo, 'update-index', '--force-remove', 'link');
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${f.first},module`);
    git(f.repo, 'commit', '-m', 'gitlink');
    await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: git(f.repo, 'rev-parse', 'HEAD'), outDir: path.join(f.root, 'gitlink') }));
});
test('materialization refuses existing targets and source overlap without altering them', async (t) => {
    const f = await fixture(t);
    await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    const target = path.join(f.root, 'existing');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep'), 'keep');
    for (const targetDir of [target, f.repo, path.join(f.repo, 'nested'), path.join(f.out, 'nested')]) {
        await assert.rejects(materializeSnapshot({ snapshotDir: f.out, targetDir }));
    }
    assert.equal(await fs.readFile(path.join(target, 'keep'), 'utf8'), 'keep');
});
test('working capture rejects staged gitlinks and hostile inherited Git environment is ignored', async (t) => {
    const f = await fixture(t);
    const old = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(f.root, 'does-not-exist');
    try {
        await captureSnapshot({ repoRoot: f.repo, commit: f.first, outDir: f.out });
    }
    finally {
        if (old === undefined)
            delete process.env.GIT_DIR;
        else
            process.env.GIT_DIR = old;
    }
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${f.first},module`);
    await assert.rejects(captureSnapshot({ repoRoot: f.repo, commit: f.first, mode: 'working-tree', outDir: path.join(f.root, 'staged') }));
    await assert.rejects(fs.stat(path.join(f.root, 'staged', 'snapshot.json')));
});
