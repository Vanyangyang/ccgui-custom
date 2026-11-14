import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const MAX_FILES = 20000, MAX_BYTES = 268435456;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const treeHash = entries => hash(JSON.stringify(entries));
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const hex = /^[a-f0-9]{64}$/;
const commitId = /^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/;
function environment() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Task Replay', GIT_AUTHOR_EMAIL: 'replay@invalid',
        GIT_COMMITTER_NAME: 'Task Replay', GIT_COMMITTER_EMAIL: 'replay@invalid',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
}
function git(root, args, input, limit = MAX_BYTES + 1048576) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
            '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd: root, env: environment(), shell: false, windowsHide: true });
        const chunks = [];
        let size = 0, error = '', exceeded = false;
        child.stdout.on('data', data => { size += data.length; if (size > limit) {
            exceeded = true;
            child.kill();
        }
        else
            chunks.push(data); });
        child.stderr.on('data', data => { if (error.length < 8192)
            error += data.toString(); });
        child.on('error', reject);
        child.on('close', code => code === 0 && !exceeded ? resolve(Buffer.concat(chunks)) : reject(new Error(exceeded ? 'Git output budget exceeded' : `Git ${args[0]} failed: ${error}`)));
        child.stdin.on('error', () => { });
        child.stdin.end(input);
    });
}
const gitText = async (root, args) => (await git(root, args)).toString().trim();
function validPath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value) || path.posix.isAbsolute(value))
        throw new Error('Unsafe snapshot path');
    for (const part of value.split('/')) {
        if (!part || part === '.' || part === '..' || /^(\.git|git~[0-9]+)$/i.test(part) || /[. ]$/.test(part) || /[<>"|?*]/.test(part)
            || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
            throw new Error(`Unsafe snapshot path: ${value}`);
    }
}
function checkPaths(entries) {
    const names = new Map(), files = new Set();
    for (const entry of entries) {
        validPath(entry.path);
        let prefix = '';
        for (const part of entry.path.split('/')) {
            prefix = prefix ? `${prefix}/${part}` : part;
            const key = prefix.toLowerCase();
            if (names.has(key) && names.get(key) !== prefix)
                throw new Error('Case collision');
            names.set(key, prefix);
            if (prefix !== entry.path && files.has(key))
                throw new Error('File/directory collision');
        }
        const key = entry.path.toLowerCase();
        if (files.has(key))
            throw new Error('Duplicate path');
        files.add(key);
    }
    for (const name of names.keys()) {
        const parts = name.split('/');
        parts.pop();
        while (parts.length) {
            if (files.has(parts.join('/')))
                throw new Error('File/directory collision');
            parts.pop();
        }
    }
}
async function noLinks(filename, missing = false) {
    const absolute = path.resolve(filename), parsed = path.parse(absolute);
    let cursor = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        let stat;
        try {
            stat = await fs.lstat(cursor);
        }
        catch (error) {
            if (missing && error.code === 'ENOENT')
                return absolute;
            throw error;
        }
        if (stat.isSymbolicLink())
            throw new Error(`Links are forbidden: ${cursor}`);
        if (cursor !== absolute && !stat.isDirectory())
            throw new Error('Non-directory ancestor');
    }
    return absolute;
}
function contains(a, b) { const rel = path.relative(a.toLowerCase(), b.toLowerCase()); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function separate(a, b) { if (contains(a, b) || contains(b, a))
    throw new Error('Directories must not contain each other'); }
async function canonical(filename) {
    let cursor = await noLinks(filename, true);
    const tail = [];
    for (;;) {
        try {
            return path.join(await fs.realpath(cursor), ...tail.reverse());
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            tail.push(path.basename(cursor));
            cursor = path.dirname(cursor);
        }
    }
}
async function newDirectory(dir) { await noLinks(dir, true); await fs.mkdir(dir); return dir; }
function budget(maxFiles, maxBytes) {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > MAX_FILES || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES)
        throw new Error('Invalid snapshot budget');
}
function decode(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
async function tree(root, commit) {
    const records = decode(await git(root, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean);
    return records.map(record => {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
        if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob')
            throw new Error('Unsupported symlink, submodule or tree entry');
        return { path: match[4], mode: match[1], oid: match[3] };
    });
}
async function working(root, base) {
    const stages = decode(await git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
    if (stages.some(row => !/^(100644|100755) [a-f0-9]+ 0\t/.test(row)))
        throw new Error('Unsupported index entry or unresolved conflict');
    const listed = decode(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    const names = [...new Set(listed)].sort();
    const modes = new Map(base.map(entry => [entry.path, entry.mode]));
    const result = [];
    for (const name of names) {
        validPath(name);
        const filename = path.join(root, ...name.split('/'));
        await noLinks(filename, true);
        let stat;
        try {
            stat = await fs.lstat(filename);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        if (!stat.isFile() || stat.nlink > 1)
            throw new Error('Unsupported working-tree entry');
        result.push({ path: name, mode: process.platform === 'win32' ? (modes.get(name) ?? '100644') : (stat.mode & 0o111 ? '100755' : '100644'), filename });
    }
    return result;
}
async function commitBlobs(root, candidates, maxBytes) {
    if (!candidates.length)
        return [];
    const input = candidates.map(entry => `${entry.oid}\n`).join('');
    // Only headers are decoded. Blob payloads remain byte slices, including NULs
    // and bytes that are not valid UTF-8.
    const header = (bytes, offset, candidate, expectedSize) => {
        const end = bytes.indexOf(10, offset);
        if (end < offset || end - offset > 96)
            throw new Error('Invalid Git batch header');
        const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) blob (0|[1-9][0-9]*)$/.exec(decode(bytes.subarray(offset, end)));
        const size = match ? Number(match[2]) : NaN;
        if (!match || match[1] !== candidate.oid || !Number.isSafeInteger(size) || (expectedSize !== undefined && size !== expectedSize))
            throw new Error('Invalid Git batch object');
        return { size, next: end + 1 };
    };
    const checked = await git(root, ['cat-file', '--batch-check'], input, candidates.length * 97);
    const sizes = [];
    let offset = 0, total = 0, outputLimit = 0;
    for (const candidate of candidates) {
        const row = header(checked, offset, candidate);
        total += row.size;
        if (total > maxBytes)
            throw new Error('Byte budget exceeded');
        sizes.push(row.size);
        outputLimit += row.next - offset + row.size + 1;
        offset = row.next;
    }
    if (offset !== checked.length)
        throw new Error('Unexpected Git batch-check output');
    const content = await git(root, ['cat-file', '--batch'], input, outputLimit);
    const blobs = [];
    offset = 0;
    for (let i = 0; i < candidates.length; i++) {
        const row = header(content, offset, candidates[i], sizes[i]);
        const end = row.next + row.size;
        if (end >= content.length || content[end] !== 10)
            throw new Error('Invalid Git batch payload delimiter');
        blobs.push(content.subarray(row.next, end));
        offset = end + 1;
    }
    if (offset !== content.length)
        throw new Error('Unexpected Git batch output');
    return blobs;
}
async function collect(root, commit, mode, maxFiles, maxBytes, sink) {
    const base = await tree(root, commit);
    const candidates = mode === 'commit' ? base : await working(root, base);
    if (candidates.length > maxFiles)
        throw new Error('File budget exceeded');
    checkPaths(candidates);
    const blobs = mode === 'commit' ? await commitBlobs(root, candidates, maxBytes) : null;
    const entries = [];
    let totalBytes = 0;
    for (const [index, candidate] of candidates.entries()) {
        let bytes;
        if (candidate.filename) {
            const stat = await fs.lstat(candidate.filename);
            if (!stat.isFile() || stat.nlink > 1 || stat.size > maxBytes - totalBytes)
                throw new Error('Byte budget exceeded or unsafe file');
            bytes = await fs.readFile(candidate.filename);
        }
        else {
            bytes = blobs[index];
        }
        totalBytes += bytes.length;
        if (totalBytes > maxBytes)
            throw new Error('Byte budget exceeded');
        const entry = { path: candidate.path, sha256: hash(bytes), size: bytes.length, mode: candidate.mode };
        entries.push(entry);
        if (sink)
            await sink(entry, bytes);
    }
    entries.sort(compare);
    return { entries, totalBytes, treeHash: treeHash(entries) };
}
export async function captureSnapshot({ repoRoot, commit, mode = 'commit', outDir, maxFiles = MAX_FILES, maxBytes = MAX_BYTES }) {
    if (!commitId.test(commit ?? ''))
        throw new Error('An explicit full commit ID is required');
    if (!['commit', 'working-tree'].includes(mode))
        throw new Error('Unsupported mode');
    budget(maxFiles, maxBytes);
    repoRoot = await fs.realpath(await noLinks(repoRoot));
    outDir = await canonical(outDir);
    separate(repoRoot, outDir);
    const top = await gitText(repoRoot, ['rev-parse', '--show-toplevel']);
    if ((await fs.realpath(top)).toLowerCase() !== repoRoot.toLowerCase())
        throw new Error('repoRoot must be the repository root');
    if (await gitText(repoRoot, ['cat-file', '-t', commit]) !== 'commit')
        throw new Error('Object is not a commit');
    commit = commit.toLowerCase();
    const head = await gitText(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    if (mode === 'working-tree' && head !== commit)
        throw new Error('Working tree requires HEAD equal to commit');
    const indexBefore = mode === 'working-tree' ? await git(repoRoot, ['ls-files', '--stage', '-z']) : null;
    await newDirectory(outDir);
    await fs.mkdir(path.join(outDir, 'blobs'));
    const captured = await collect(repoRoot, commit, mode, maxFiles, maxBytes, async (entry, bytes) => {
        const dest = path.join(outDir, 'blobs', entry.sha256);
        try {
            await fs.writeFile(dest, bytes, { flag: 'wx' });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
    });
    if (mode === 'working-tree') {
        const after = await collect(repoRoot, commit, mode, maxFiles, maxBytes);
        if (after.treeHash !== captured.treeHash || !(await git(repoRoot, ['ls-files', '--stage', '-z'])).equals(indexBefore))
            throw new Error('Working tree changed during capture');
    }
    if (await gitText(repoRoot, ['rev-parse', '--verify', 'HEAD']) !== head)
        throw new Error('HEAD changed during capture');
    const manifest = { schemaVersion: 1, source: { commit, mode, capturedAt: new Date().toISOString(), repoRoot,
            fidelity: mode === 'commit' ? 'commit-only' : 'captured-working-tree' }, ...captured, budgets: { maxFiles, maxBytes } };
    await fs.writeFile(path.join(outDir, 'snapshot.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return manifest;
}
async function auditDirectory(dir, count = { n: 0 }) {
    await noLinks(dir);
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (++count.n > MAX_FILES * 3 + 10)
            throw new Error('Directory budget exceeded');
        const filename = path.join(dir, item.name), stat = await fs.lstat(filename);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1 || (!stat.isFile() && !stat.isDirectory()))
            throw new Error('Unsupported snapshot filesystem entry');
        if (stat.isDirectory())
            await auditDirectory(filename, count);
    }
}
export async function verifySnapshot(snapshotDir) {
    snapshotDir = await fs.realpath(await noLinks(snapshotDir));
    await auditDirectory(snapshotDir);
    const filename = path.join(snapshotDir, 'snapshot.json');
    if ((await fs.stat(filename)).size > 16 * 1024 * 1024)
        throw new Error('Manifest budget exceeded');
    const m = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (m.schemaVersion !== 1 || !m.source || !commitId.test(m.source.commit ?? '') || !['commit', 'working-tree'].includes(m.source.mode)
        || m.source.fidelity !== (m.source.mode === 'commit' ? 'commit-only' : 'captured-working-tree')
        || typeof m.source.repoRoot !== 'string' || !path.isAbsolute(m.source.repoRoot) || typeof m.source.capturedAt !== 'string' || !Number.isFinite(Date.parse(m.source.capturedAt))
        || !Array.isArray(m.entries) || !hex.test(m.treeHash ?? ''))
        throw new Error('Invalid manifest');
    const { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = m.budgets ?? {};
    budget(maxFiles, maxBytes);
    if (m.entries.length > maxFiles)
        throw new Error('File budget exceeded');
    checkPaths(m.entries);
    let total = 0;
    for (const entry of m.entries) {
        if (!hex.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.size) || entry.size < 0 || !['100644', '100755'].includes(entry.mode))
            throw new Error('Invalid entry');
        total += entry.size;
        if (total > maxBytes)
            throw new Error('Byte budget exceeded');
        const blob = path.join(snapshotDir, 'blobs', entry.sha256);
        await noLinks(blob);
        const stat = await fs.lstat(blob);
        if (!stat.isFile() || stat.nlink > 1 || stat.size !== entry.size || hash(await fs.readFile(blob)) !== entry.sha256)
            throw new Error('Blob integrity failure');
    }
    const sorted = [...m.entries].sort(compare);
    if (JSON.stringify(sorted) !== JSON.stringify(m.entries) || treeHash(m.entries) !== m.treeHash || total !== m.totalBytes)
        throw new Error('Manifest integrity failure');
    return m;
}
export async function materializeSnapshot({ snapshotDir, targetDir, initializeGit = true }) {
    snapshotDir = await fs.realpath(await noLinks(snapshotDir));
    const manifest = await verifySnapshot(snapshotDir);
    targetDir = await canonical(targetDir);
    separate(snapshotDir, targetDir);
    separate(await canonical(manifest.source.repoRoot), targetDir);
    await newDirectory(targetDir);
    for (const entry of manifest.entries) {
        const blob = path.join(snapshotDir, 'blobs', entry.sha256);
        await noLinks(blob);
        const bytes = await fs.readFile(blob);
        if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
            throw new Error('Blob changed during materialization');
        const dest = path.join(targetDir, ...entry.path.split('/'));
        await noLinks(dest, true);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
    let commit = null;
    if (initializeGit) {
        await git(targetDir, ['init', '--template=', '--initial-branch=replay', '--object-format=sha1']);
        const records = [];
        if (manifest.entries.length) {
            // stdin-paths uses Git C quoting, not JSON quoting. Octal-encode UTF-8
            // bytes so spaces, Unicode and initial quotes cannot change framing.
            const paths = manifest.entries.map(entry => '"' + [...Buffer.from(`./${entry.path}`)]
                .map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('') + '"\n').join('');
            const output = decode(await git(targetDir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], paths, manifest.entries.length * 41));
            const oids = output.split('\n');
            if (oids.pop() !== '' || oids.length !== manifest.entries.length || oids.some(oid => !/^[a-f0-9]{40}$/.test(oid)))
                throw new Error('Invalid Git hash-object output');
            for (const [index, entry] of manifest.entries.entries())
                records.push(`${entry.mode} ${oids[index]}\t${entry.path}\0`);
        }
        await git(targetDir, ['update-index', '-z', '--index-info'], records.join(''));
        const tree = await gitText(targetDir, ['write-tree']);
        commit = (await git(targetDir, ['commit-tree', tree], 'Task replay snapshot\n')).toString().trim();
        await git(targetDir, ['update-ref', 'refs/heads/replay', commit]);
    }
    return { root: targetDir, manifest, commit };
}
