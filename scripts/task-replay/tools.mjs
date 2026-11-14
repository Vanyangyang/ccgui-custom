import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const OUTPUT = 64 * 1024;
const FILE = 256 * 1024;
const fail = (reason) => { throw Object.assign(new Error(reason), { code: reason }); };
const codes = new Set(['invalid_input', 'unsafe_path', 'not_found', 'not_file', 'not_directory', 'binary_file', 'io_error', 'aborted', 'scan_limit']);
const errorResult = (e) => ({ status: 'error', reason: codes.has(e?.code) ? e.code : 'io_error' });
const inside = (base, target) => { const r = path.relative(base, target); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
const device = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\.|$)/i;
function parts(value, directory = false) {
    if (directory && value === '.')
        return [];
    if (typeof value !== 'string' || !value || /[\\:\0]/.test(value) || path.isAbsolute(value))
        fail('unsafe_path');
    const p = value.split('/');
    if (p.some(s => !s || s === '.' || s === '..' || /^(\.git|git~\d+)$/i.test(s) || /[. ]$/.test(s) || device.test(s)))
        fail('unsafe_path');
    return p;
}
function cliEnv() {
    const env = { DOCKER_CONFIG: path.join(os.tmpdir(), `replay-docker-config-${randomUUID()}`) };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR'])
        if (process.env[key])
            env[key] = process.env[key];
    return env;
}
// No shell, stdin, inherited Docker endpoint/configuration, or user secrets.
function processRun(spawnImpl, argv, { timeoutMs = 5000, signal, cap = OUTPUT } = {}) {
    return new Promise(resolve => {
        if (signal?.aborted)
            return resolve({ reason: 'aborted' });
        let child, timer, done = false, bytes = 0;
        const chunks = { stdout: [], stderr: [] };
        const finish = result => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            resolve(result);
        };
        const stop = reason => {
            finish({ reason });
            try {
                child?.kill('SIGKILL');
            }
            catch { /* bounded best effort */ }
        };
        const abort = () => stop('aborted');
        try {
            child = spawnImpl('docker', argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
            child.on('error', () => finish({ reason: 'docker_unavailable' }));
            for (const stream of ['stdout', 'stderr'])
                child[stream]?.on('data', data => {
                    if (done)
                        return;
                    const b = Buffer.from(data);
                    bytes += b.length;
                    if (bytes > cap)
                        return stop('output_limit');
                    chunks[stream].push(b);
                });
            child.on('close', code => finish({ exitCode: code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }));
            timer = setTimeout(() => stop('timeout'), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted)
                abort();
        }
        catch {
            finish({ reason: 'docker_unavailable' });
        }
    });
}
export async function doctorDocker({ spawnImpl = spawn } = {}) {
    const r = await processRun(spawnImpl, ['info', '--format', '{"OSType":{{json .OSType}},"ServerVersion":{{json .ServerVersion}}}']);
    if (r.reason || r.exitCode !== 0)
        return { available: false, reason: 'docker_unavailable' };
    try {
        const info = JSON.parse(r.stdout);
        if (info.OSType !== 'linux')
            return { available: false, reason: 'docker_not_linux' };
        return { available: true, ...(typeof info.ServerVersion === 'string' && /^[\w.+-]{1,80}$/.test(info.ServerVersion) ? { version: info.ServerVersion } : {}) };
    }
    catch {
        return { available: false, reason: 'docker_unavailable' };
    }
}
export async function cleanupReplayContainer(name, { spawnImpl = spawn } = {}) {
    if (typeof name !== 'string' || !/^replay-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name))
        fail('invalid_input');
    const result = await processRun(spawnImpl, ['rm', '-f', name], { timeoutMs: 1500, cap: 4096 });
    return { containerName: name, status: !result.reason && result.exitCode === 0 ? 'removed' : 'unknown' };
}
const str = { type: 'string' };
function definition(name, properties, description) {
    return { type: 'function', name, description, strict: true, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}
function validate(def, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        fail('invalid_input');
    const props = def.parameters.properties;
    if (Object.keys(args).length !== Object.keys(props).length || Object.keys(args).some(k => !Object.hasOwn(props, k)))
        fail('invalid_input');
    for (const [k, v] of Object.entries(props)) {
        if (!Object.hasOwn(args, k) || (v.type === 'string' ? typeof args[k] !== 'string' : !Number.isInteger(args[k]) || args[k] < v.minimum || args[k] > v.maximum))
            fail('invalid_input');
    }
}
function bounded(result) {
    if (Buffer.byteLength(JSON.stringify(result)) <= OUTPUT)
        return result;
    if (typeof result.content === 'string') {
        let lo = 0, hi = result.content.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (Buffer.byteLength(JSON.stringify({ ...result, content: result.content.slice(0, mid), truncated: true })) <= OUTPUT)
                lo = mid;
            else
                hi = mid - 1;
        }
        if (lo && /[\uD800-\uDBFF]/.test(result.content[lo - 1]))
            lo--;
        return { ...result, content: result.content.slice(0, lo), truncated: true };
    }
    const key = Array.isArray(result.files) ? 'files' : 'matches';
    if (Array.isArray(result[key])) {
        result.truncated = true;
        while (result[key].length && Buffer.byteLength(JSON.stringify(result)) > OUTPUT)
            result[key].pop();
        return result;
    }
    return { status: 'blocked', reason: 'output_limit' };
}
export async function createReplayTools({ root, recipes = [], dockerImage = null, allowWrite = false, signal, onEvent = () => { }, spawnImpl = spawn }) {
    // Reject linked ancestors too, rather than silently canonicalizing a linked root.
    if (typeof root !== 'string' || !path.isAbsolute(root))
        fail('unsafe_path');
    root = path.resolve(root);
    let ancestor = root;
    while (true) {
        const s = await fs.lstat(ancestor).catch(() => fail('unsafe_path'));
        if (s.isSymbolicLink() || !s.isDirectory())
            fail('unsafe_path');
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
            break;
        ancestor = parent;
    }
    const realRoot = await fs.realpath(root);
    const rootStat = await fs.lstat(root);
    const checkRoot = async () => {
        const s = await fs.lstat(root);
        if (s.isSymbolicLink() || !s.isDirectory() || s.dev !== rootStat.dev || s.ino !== rootStat.ino || await fs.realpath(root) !== realRoot)
            fail('unsafe_path');
    };
    async function checked(value, { directory = false, createParents = false, missingLeaf = false } = {}) {
        const segments = parts(value, directory);
        await checkRoot();
        let current = root;
        for (let i = 0; i < segments.length; i++) {
            current = path.join(current, segments[i]);
            let stat;
            try {
                stat = await fs.lstat(current);
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
                if (createParents && i < segments.length - 1) {
                    await fs.mkdir(current);
                    stat = await fs.lstat(current);
                }
                else if (missingLeaf && i === segments.length - 1)
                    return current;
                else
                    fail('not_found');
            }
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1))
                fail('unsafe_path');
            const real = await fs.realpath(current);
            if (!inside(realRoot, real) || path.relative(realRoot, real).split(path.sep).some(p => p.toLowerCase() === '.git'))
                fail('unsafe_path');
            if (i < segments.length - 1 && !stat.isDirectory())
                fail('not_directory');
        }
        return current;
    }
    async function read(value) {
        const p = await checked(value);
        const h = await fs.open(p, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const s = await h.stat();
            if (!s.isFile())
                fail('not_file');
            if (s.nlink > 1)
                fail('unsafe_path');
            const now = await fs.lstat(await checked(value));
            if (s.ino !== now.ino || s.dev !== now.dev)
                fail('unsafe_path');
            const buf = Buffer.alloc(FILE);
            let used = 0;
            while (used < FILE) {
                const { bytesRead } = await h.read(buf, used, FILE - used, used);
                if (!bytesRead)
                    break;
                used += bytesRead;
            }
            const data = buf.subarray(0, used);
            if (data.includes(0))
                fail('binary_file');
            let content;
            try {
                content = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: s.size > used });
            }
            catch {
                fail('binary_file');
            }
            return { content, truncated: s.size > used };
        }
        finally {
            await h.close();
        }
    }
    async function walk(dir = '.', rejectGit = false) {
        const all = [], pending = [dir];
        let count = 0;
        while (pending.length) {
            if (signal?.aborted)
                fail('aborted');
            const rel = pending.pop();
            const p = await checked(rel, { directory: true });
            const entries = await fs.opendir(p);
            for await (const entry of entries) {
                if (++count > 10000)
                    fail('scan_limit');
                if (entry.name.toLowerCase() === '.git') {
                    if (rejectGit)
                        fail('unsafe_path');
                    else
                        continue;
                }
                const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
                const target = await checked(child);
                const stat = await fs.lstat(target);
                if (stat.isDirectory())
                    pending.push(child);
                else
                    all.push(child);
            }
        }
        return all.sort();
    }
    const recipeMap = new Map();
    for (const r of recipes) {
        if (!r || typeof r.id !== 'string' || !r.id || recipeMap.has(r.id) || !Array.isArray(r.argv) || !r.argv.length || r.argv.some(a => typeof a !== 'string' || a.includes('\0')) || !r.argv[0] || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > 2147483647)
            fail('invalid_input');
        recipeMap.set(r.id, { argv: [...r.argv], timeoutMs: r.timeoutMs });
    }
    const definitions = [
        definition('read_file', { path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 400 } }, 'Read UTF-8 lines from a workspace file.'),
        definition('list_files', { path: str }, 'List files recursively within a workspace directory.'),
        definition('search_files', { query: str, limit: { type: 'integer', minimum: 1, maximum: 200 } }, 'Find literal text in workspace files.'),
        ...(allowWrite ? [definition('write_file', { path: str, content: str }, 'Write a UTF-8 workspace file.')] : []),
        ...(recipes.length ? [definition('run_test', { id: str }, 'Run a configured test recipe in an isolated Linux Docker container.')] : []),
    ];
    const byName = new Map(definitions.map(d => [d.name, structuredClone(d)]));
    let doctor;
    async function auditGitMetadata() {
        const pending = [path.join(root, '.git')];
        let count = 0;
        while (pending.length) {
            const file = pending.pop();
            let s;
            try {
                s = await fs.lstat(file);
            }
            catch (e) {
                if (e.code === 'ENOENT')
                    continue;
                throw e;
            }
            if (++count > 10000 || s.isSymbolicLink() || !s.isDirectory() && !s.isFile() || s.isFile() && s.nlink > 1)
                fail('unsafe_path');
            if (!inside(realRoot, await fs.realpath(file)))
                fail('unsafe_path');
            if (s.isDirectory())
                for (const child of await fs.readdir(file))
                    pending.push(path.join(file, child));
            else if (file === path.join(root, '.git'))
                fail('unsafe_path');
        }
    }
    async function runTest(id) {
        const recipe = recipeMap.get(id);
        if (!recipe)
            fail('invalid_input');
        if (!dockerImage || !/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-fA-F0-9]{64}$/.test(dockerImage))
            return { status: 'blocked', reason: 'invalid_docker_image' };
        if (root.includes(','))
            return { status: 'blocked', reason: 'unsafe_mount' };
        await walk();
        await auditGitMetadata();
        doctor ??= doctorDocker({ spawnImpl });
        const health = await doctor;
        if (!health.available)
            return { status: 'blocked', reason: health.reason };
        if (signal?.aborted)
            return { status: 'blocked', reason: 'aborted' };
        const name = `replay-${randomUUID()}`;
        const args = ['run', '--rm', '--name', name, '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--user', '65534:65534', '--tmpfs', '/tmp:size=64m', '--mount', `type=bind,source=${root},target=/workspace,readonly`, '--workdir', '/workspace', dockerImage, ...recipe.argv];
        const result = await processRun(spawnImpl, args, { timeoutMs: recipe.timeoutMs, signal });
        if (result.reason || result.exitCode === null) {
            const cleanup = await processRun(spawnImpl, ['rm', '-f', name], { timeoutMs: 1500, cap: 4096 });
            if (cleanup.reason || cleanup.exitCode !== 0)
                return { status: 'blocked', reason: 'container_cleanup_unconfirmed', containerName: name };
            return { status: 'blocked', reason: result.reason || 'docker_failed' };
        }
        if (result.exitCode === 125 || result.exitCode === 126 || result.exitCode === 127)
            return { status: 'blocked', reason: 'docker_failed' };
        return { status: 'completed', ...result, truncated: false };
    }
    async function execute(name, args) {
        const start = performance.now();
        let result;
        try {
            const def = byName.get(name);
            if (!def)
                fail('invalid_input');
            validate(def, args);
            if (signal?.aborted) {
                if (name !== 'run_test')
                    fail('aborted');
                result = { status: 'blocked', reason: 'aborted' };
            }
            if (result) { /* An already aborted test never probes or starts Docker. */ }
            else if (name === 'read_file') {
                const r = await read(args.path);
                const lines = r.content.split('\n');
                result = { status: 'completed', content: lines.slice(args.offset - 1, args.offset - 1 + args.limit).join('\n'), truncated: r.truncated || lines.length > args.offset - 1 + args.limit };
            }
            else if (name === 'list_files') {
                result = { status: 'completed', files: await walk(args.path), truncated: false };
            }
            else if (name === 'search_files') {
                const matches = [];
                let truncated = false;
                for (const file of await walk()) {
                    let r;
                    try {
                        r = await read(file);
                    }
                    catch (e) {
                        if (e.code === 'binary_file')
                            continue;
                        throw e;
                    }
                    truncated ||= r.truncated;
                    const lines = r.content.split('\n');
                    for (let i = 0; i < lines.length; i++)
                        if (lines[i].includes(args.query)) {
                            if (matches.length === args.limit) {
                                truncated = true;
                                break;
                            }
                            matches.push({ path: file, line: i + 1, content: lines[i] });
                        }
                    if (matches.length === args.limit) {
                        truncated = true;
                        break;
                    }
                }
                result = { status: 'completed', matches, truncated };
            }
            else if (name === 'write_file') {
                if (Buffer.byteLength(args.content) > FILE)
                    fail('invalid_input');
                const target = await checked(args.path, { createParents: true, missingLeaf: true });
                const existing = await fs.lstat(target).catch(e => { if (e.code === 'ENOENT')
                    return null; throw e; });
                if (existing && !existing.isFile())
                    fail('not_file');
                // Write a fresh inode then rename, never truncate an existing hardlink.
                const temp = path.join(path.dirname(target), `.replay-${randomUUID()}`);
                let h;
                try {
                    h = await fs.open(temp, 'wx', 0o644);
                    await h.writeFile(args.content, 'utf8');
                    await h.close();
                    h = null;
                    await checked(args.path, { missingLeaf: true });
                    await fs.rename(temp, target);
                    result = { status: 'completed' };
                }
                finally {
                    await h?.close();
                    await fs.unlink(temp).catch(() => { });
                }
            }
            else
                result = await runTest(args.id);
            result = bounded(result);
        }
        catch (e) {
            result = errorResult(e);
        }
        try {
            onEvent({ name: byName.has(name) ? name : 'unknown', elapsedMs: Math.max(0, Math.round(performance.now() - start)), status: result.status, ...(result.reason ? { details: result.containerName ? { reason: result.reason, containerName: result.containerName } : result.reason } : {}) });
        }
        catch { /* telemetry must not affect tools */ }
        return result;
    }
    return { definitions, execute };
}
