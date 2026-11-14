import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createReplayTools, doctorDocker } from './tools.mjs';
const image = `example/test@sha256:${'a'.repeat(64)}`;
const recipes = [{ id: 'unit', argv: ['node', '--test', 'fixture.mjs'], timeoutMs: 1000 }];
async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-tools-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, ...await createReplayTools({ root, ...options }) };
}
function fakeDocker({ osType = 'linux', missing = false, run, cleanup } = {}) {
    const calls = [];
    const spawnImpl = (command, argv, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => { child.killed = true; return true; };
        calls.push({ command, argv, options, child });
        queueMicrotask(() => {
            if (missing)
                return child.emit('error', new Error('secret host failure'));
            if (argv[0] === 'info') {
                child.stdout.write(JSON.stringify({ OSType: osType, ServerVersion: '28.0.1' }));
                child.emit('close', 0);
            }
            else if (argv[0] === 'rm') {
                if (cleanup)
                    cleanup(child);
                else
                    child.emit('close', 0);
            }
            else if (run)
                run(child);
            else {
                child.stdout.write('测试😀\n');
                child.emit('close', 0);
            }
        });
        return child;
    };
    return { spawnImpl, calls };
}
test('strict Responses schemas and runtime validation; optional tools are hidden', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.definitions.map(x => x.name), ['read_file', 'list_files', 'search_files']);
    for (const d of f.definitions) {
        assert.equal(d.type, 'function');
        assert.equal(d.strict, true);
        assert.equal(d.parameters.additionalProperties, false);
        assert.deepEqual(d.parameters.required, Object.keys(d.parameters.properties));
    }
    for (const args of [{ path: 'a' }, { path: 'a', offset: 0, limit: 1 }, { path: 'a', offset: 1, limit: 401 }, { path: 'a', offset: 1.2, limit: 1 }, { path: 'a', offset: 1, limit: 1, extra: true }]) {
        assert.deepEqual(await f.execute('read_file', args), { status: 'error', reason: 'invalid_input' });
    }
    assert.deepEqual(await f.execute('write_file', { path: 'a', content: '' }), { status: 'error', reason: 'invalid_input' });
    for (const limit of [0, 201, 1.1])
        assert.equal((await f.execute('search_files', { query: 'x', limit })).reason, 'invalid_input');
});
test('UTF-8 read/write/list/literal search, nested parents, and replacement', async (t) => {
    const f = await fixture(t, { allowWrite: true });
    assert.equal((await f.execute('write_file', { path: 'nested/file.txt', content: '中文😀\n[a.*]\n末行' })).status, 'completed');
    assert.deepEqual(await f.execute('read_file', { path: 'nested/file.txt', offset: 2, limit: 1 }), { status: 'completed', content: '[a.*]', truncated: true });
    assert.deepEqual((await f.execute('list_files', { path: '.' })).files, ['nested/file.txt']);
    assert.deepEqual((await f.execute('search_files', { query: '[a.*]', limit: 10 })).matches, [{ path: 'nested/file.txt', line: 2, content: '[a.*]' }]);
    assert.equal((await f.execute('write_file', { path: 'nested/file.txt', content: '替换😀' })).status, 'completed');
    assert.equal((await f.execute('read_file', { path: 'nested/file.txt', offset: 1, limit: 400 })).content, '替换😀');
});
test('invalid paths, Windows devices, git paths, and sibling escape fail with fixed codes', async (t) => {
    const events = [];
    const f = await fixture(t, { allowWrite: true, onEvent: e => events.push(e) });
    for (const p of ['', '/etc/passwd', '../other', 'a/../b', 'a\\b', 'C:/data', 'x\0y', 'a//b', 'NUL', 'con.txt', 'COM1', 'lpt².log', 'CONIN$', 'a.', 'a ', '.git/config', '.GiT/config', 'a/.GIT/b']) {
        assert.deepEqual(await f.execute('read_file', { path: p, offset: 1, limit: 1 }), { status: 'error', reason: 'unsafe_path' }, p);
        assert.deepEqual(await f.execute('write_file', { path: p, content: 'private-content' }), { status: 'error', reason: 'unsafe_path' }, p);
    }
    assert.equal((await f.execute('read_file', { path: 'missing', offset: 1, limit: 1 })).reason, 'not_found');
    assert.ok(!JSON.stringify(events).includes(f.root));
    assert.ok(!JSON.stringify(events).includes('private-content'));
    await fs.mkdir(path.join(f.root, '.GiT'));
    await fs.writeFile(path.join(f.root, '.GiT', 'secret'), 'secret');
    assert.deepEqual((await f.execute('list_files', { path: '.' })).files, []);
    assert.deepEqual((await f.execute('search_files', { query: 'secret', limit: 10 })).matches, []);
});
test('file hardlinks, symlinks and directory junctions are rejected', async (t) => {
    const f = await fixture(t, { allowWrite: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'secret'), 'external secret');
    await fs.link(path.join(outside, 'secret'), path.join(f.root, 'hard'));
    for (const name of ['read_file', 'write_file'])
        assert.equal((await f.execute(name, name === 'read_file' ? { path: 'hard', offset: 1, limit: 1 } : { path: 'hard', content: 'changed' })).reason, 'unsafe_path');
    await fs.unlink(path.join(f.root, 'hard'));
    await fs.symlink(outside, path.join(f.root, 'dirlink'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await f.execute('read_file', { path: 'dirlink/secret', offset: 1, limit: 1 })).reason, 'unsafe_path');
    assert.equal((await f.execute('write_file', { path: 'dirlink/new', content: 'changed' })).reason, 'unsafe_path');
    assert.equal((await f.execute('list_files', { path: '.' })).reason, 'unsafe_path');
    assert.equal((await f.execute('search_files', { query: 'secret', limit: 10 })).reason, 'unsafe_path');
    await assert.rejects(createReplayTools({ root: path.join(f.root, 'dirlink') }), /unsafe_path/);
    await fs.unlink(path.join(f.root, 'dirlink'));
    await t.test('file symlink', async (sub) => {
        try {
            await fs.symlink(path.join(outside, 'secret'), path.join(f.root, 'symlink'), 'file');
        }
        catch (e) {
            if (e.code === 'EPERM') {
                sub.skip('Windows does not grant file symlink creation.');
                return;
            }
            throw e;
        }
        assert.equal((await f.execute('read_file', { path: 'symlink', offset: 1, limit: 1 })).reason, 'unsafe_path');
        assert.equal((await f.execute('write_file', { path: 'symlink', content: 'changed' })).reason, 'unsafe_path');
    });
    assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'external secret');
});
test('bounded UTF-8 reads and serialized outputs; binary rejection', async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'large'), '中文😀'.repeat(40000));
    const r = await f.execute('read_file', { path: 'large', offset: 1, limit: 400 });
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 65536);
    assert.ok(!r.content.includes('\uFFFD'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(r.content));
    const s = await f.execute('search_files', { query: '中文', limit: 200 });
    assert.ok(Buffer.byteLength(JSON.stringify(s)) <= 65536);
    assert.equal(s.truncated, true);
    await fs.writeFile(path.join(f.root, 'binary'), Buffer.from([0, 1, 2]));
    assert.equal((await f.execute('read_file', { path: 'binary', offset: 1, limit: 1 })).reason, 'binary_file');
    await fs.writeFile(path.join(f.root, 'invalid-utf8'), Buffer.from([255, 254]));
    assert.equal((await f.execute('read_file', { path: 'invalid-utf8', offset: 1, limit: 1 })).reason, 'binary_file');
});
test('Docker flags, one mount, fixed argv, sanitized environment, and cached Linux doctor', async (t) => {
    const fake = fakeDocker();
    const f = await fixture(t, { recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
    for (let i = 0; i < 2; i++)
        assert.deepEqual(await f.execute('run_test', { id: 'unit' }), { status: 'completed', exitCode: 0, stdout: '测试😀\n', stderr: '', truncated: false });
    assert.equal(fake.calls.filter(c => c.argv[0] === 'info').length, 1);
    const run = fake.calls.find(c => c.argv[0] === 'run');
    assert.equal(run.command, 'docker');
    assert.match(run.argv[run.argv.indexOf('--name') + 1], /^replay-[0-9a-f-]{36}$/);
    for (const [flag, value] of [['--pull', 'never'], ['--network', 'none'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pids-limit', '128'], ['--memory', '512m'], ['--cpus', '1'], ['--user', '65534:65534'], ['--tmpfs', '/tmp:size=64m'], ['--workdir', '/workspace']])
        assert.equal(run.argv[run.argv.indexOf(flag) + 1], value);
    assert.ok(run.argv.includes('--read-only'));
    assert.equal(run.argv.filter(a => a === '--mount').length, 1);
    assert.equal(run.argv[run.argv.indexOf('--mount') + 1], `type=bind,source=${f.root},target=/workspace,readonly`);
    assert.deepEqual(run.argv.slice(run.argv.indexOf(image) + 1), recipes[0].argv);
    assert.ok(!run.argv.includes('--env') && !run.argv.includes('-v'));
    for (const c of fake.calls) {
        assert.equal(c.options.shell, false);
        assert.equal(c.options.windowsHide, true);
        assert.deepEqual(c.options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.ok(Object.keys(c.options.env).every(k => ['PATH', 'SystemRoot', 'WINDIR', 'DOCKER_CONFIG'].includes(k)));
        assert.notEqual(c.options.env.DOCKER_CONFIG, process.env.DOCKER_CONFIG);
    }
});
test('missing Docker, non-Linux, unpinned image, unknown recipe and comma mount are blocked', async (t) => {
    for (const [options, reason] of [[{ missing: true }, 'docker_unavailable'], [{ osType: 'windows' }, 'docker_not_linux']]) {
        const fake = fakeDocker(options);
        const f = await fixture(t, { recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
        assert.deepEqual(await f.execute('run_test', { id: 'unit' }), { status: 'blocked', reason });
        assert.ok(fake.calls.every(c => c.argv[0] === 'info'));
    }
    const fake = fakeDocker();
    const f = await fixture(t, { recipes, dockerImage: 'example:latest', spawnImpl: fake.spawnImpl });
    assert.equal((await f.execute('run_test', { id: 'unit' })).reason, 'invalid_docker_image');
    assert.equal((await f.execute('run_test', { id: 'arbitrary-command' })).reason, 'invalid_input');
    const comma = path.join(f.root, 'comma,root');
    await fs.mkdir(comma);
    const c = await createReplayTools({ root: comma, recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
    assert.equal((await c.execute('run_test', { id: 'unit' })).reason, 'unsafe_mount');
    assert.equal(fake.calls.length, 0);
});
for (const mode of ['timeout', 'aborted', 'output_limit'])
    test(`${mode}: kill CLI and clean only exact generated name`, async (t) => {
        const controller = new AbortController();
        const fake = fakeDocker({ run: child => {
                if (mode === 'aborted')
                    controller.abort();
                if (mode === 'output_limit') {
                    child.stdout.write(Buffer.alloc(32769));
                    child.stderr.write(Buffer.alloc(32768));
                }
            } });
        const f = await fixture(t, { recipes: [{ ...recipes[0], timeoutMs: 30 }], dockerImage: image, signal: controller.signal, spawnImpl: fake.spawnImpl });
        assert.deepEqual(await f.execute('run_test', { id: 'unit' }), { status: 'blocked', reason: mode });
        const run = fake.calls.find(c => c.argv[0] === 'run');
        assert.equal(run.child.killed, true);
        const cleanup = fake.calls.filter(c => c.argv[0] === 'rm');
        assert.equal(cleanup.length, 1);
        assert.deepEqual(cleanup[0].argv, ['rm', '-f', run.argv[run.argv.indexOf('--name') + 1]]);
    });
test('doctor is read-only, malformed info is fixed failure, nonzero recipes retain exitCode', async (t) => {
    const fake = fakeDocker({ run: c => { c.stderr.write('assertion failed'); c.emit('close', 1); } });
    assert.deepEqual(await doctorDocker({ spawnImpl: fake.spawnImpl }), { available: true, version: '28.0.1' });
    assert.deepEqual(fake.calls[0].argv, ['info', '--format', '{"OSType":{{json .OSType}},"ServerVersion":{{json .ServerVersion}}}']);
    const f = await fixture(t, { recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
    assert.deepEqual(await f.execute('run_test', { id: 'unit' }), { status: 'completed', exitCode: 1, stdout: '', stderr: 'assertion failed', truncated: false });
    const malformed = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => { child.stdout.write('host-private-error'); child.emit('close', 0); });
        return child;
    };
    assert.deepEqual(await doctorDocker({ spawnImpl: malformed }), { available: false, reason: 'docker_unavailable' });
});
test('list serialization cap, read byte cap, and container preflight allows independent git but rejects gitdir indirection', async (t) => {
    const fake = fakeDocker();
    const f = await fixture(t, { recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
    for (let i = 0; i < 320; i++)
        await fs.writeFile(path.join(f.root, `${String(i).padStart(3, '0')}-${'x'.repeat(210)}`), '');
    const list = await f.execute('list_files', { path: '.' });
    assert.equal(list.truncated, true);
    assert.ok(list.files.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(list)) <= 65536);
    await fs.writeFile(path.join(f.root, 'capped'), `${'x'.repeat(262144)}\nHIDDEN_AFTER_BYTE_CAP`);
    const read = await f.execute('read_file', { path: 'capped', offset: 2, limit: 1 });
    assert.equal(read.content, '');
    assert.equal(read.truncated, true);
    await fs.mkdir(path.join(f.root, '.git'));
    assert.equal((await f.execute('run_test', { id: 'unit' })).status, 'completed');
    const called = fake.calls.length;
    await fs.rmdir(path.join(f.root, '.git'));
    await fs.writeFile(path.join(f.root, '.git'), 'gitdir: /external/repo/.git');
    assert.deepEqual(await f.execute('run_test', { id: 'unit' }), { status: 'error', reason: 'unsafe_path' });
    assert.equal(fake.calls.length, called);
});
test('invalid roots/configuration and already aborted operations fail closed', async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.root, 'file'), 'data');
    await assert.rejects(createReplayTools({ root: path.join(f.root, 'file') }), /unsafe_path/);
    await assert.rejects(createReplayTools({ root: path.join(f.root, 'missing') }), /unsafe_path/);
    await assert.rejects(createReplayTools({ root: f.root, recipes: [{ id: 'bad', argv: [], timeoutMs: 1 }] }), /invalid_input/);
    const fake = fakeDocker();
    const controller = new AbortController();
    controller.abort();
    const aborted = await createReplayTools({ root: f.root, signal: controller.signal, recipes, dockerImage: image, spawnImpl: fake.spawnImpl });
    assert.deepEqual(await aborted.execute('run_test', { id: 'unit' }), { status: 'blocked', reason: 'aborted' });
    assert.equal(fake.calls.length, 0);
});
test('cleanup is bounded even when Docker rm hangs', async (t) => {
    const fake = fakeDocker({ run: () => { }, cleanup: () => { } });
    const f = await fixture(t, { recipes: [{ ...recipes[0], timeoutMs: 10 }], dockerImage: image, spawnImpl: fake.spawnImpl });
    const start = Date.now();
    const result = await f.execute('run_test', { id: 'unit' });
    assert.equal(result.reason, 'container_cleanup_unconfirmed');
    assert.match(result.containerName, /^replay-[a-f0-9-]{36}$/);
    assert.ok(Date.now() - start < 4000);
    assert.equal(fake.calls.find(c => c.argv[0] === 'rm').child.killed, true);
});
