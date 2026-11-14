import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, createSnapshotCommit, dependencyKey, ensureDependencies, git, isolatedRoot, prepareSnapshot, runIsolated, sanitizedEnvironment, SNAPSHOT_REF, validatePaths } from './isolated-build.mjs';

// Inside an isolated snapshot the environment pins git settings (such as
// core.autocrlf); these tests set their own and must not inherit them.
for (const name of Object.keys(process.env)) if (/^GIT_(?:CONFIG|DIR|INDEX|WORK_TREE|COMMON_DIR)/i.test(name)) delete process.env[name];

function temporary(t, prefix = 'ccgui-iso-test-') {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}
function repository(t, files = {}) {
  const container = temporary(t);
  const repo = path.join(container, 'repo');
  fs.mkdirSync(repo);
  const run = (...args) => git(args, { cwd: repo });
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.name', 'Fixture');
  run('config', 'user.email', 'fixture@example.invalid');
  run('config', 'core.autocrlf', 'false');
  write(repo, '.gitignore', 'ignored.txt\nbuild/\nartifacts/\nnode_modules/\n');
  for (const [file, contents] of Object.entries({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'dir/c.txt': 'c\n', 'package.json': '{}\n', 'pnpm-lock.yaml': 'lock: 1\n', ...files })) write(repo, file, contents);
  run('add', '--all');
  run('commit', '--quiet', '-m', 'baseline');
  return { container, repo, run, isolated: path.join(container, 'iso') };
}
const treeFiles = (repo, commit) => git(['ls-tree', '-r', '--name-only', commit], { cwd: repo }).split(/\r?\n/).filter(Boolean).sort();
const show = (repo, commit, file) => git(['show', `${commit}:${file}`], { cwd: repo });

test('the isolated root is a short sibling directory that never overlaps the checkout', t => {
  const container = temporary(t);
  const repo = path.join(container, 'repo');
  // Temporary directories are long; the production limit is checked separately.
  const root = env => isolatedRoot(repo, env, 1000);
  assert.equal(root({}), path.join(container, 'ccgui-iso'));
  assert.equal(root({ CCGUI_ISOLATED_ROOT: '../elsewhere' }), path.join(container, 'elsewhere'));
  assert.throws(() => root({ CCGUI_ISOLATED_ROOT: 'inside' }), /contain each other/);
  assert.throws(() => root({ CCGUI_ISOLATED_ROOT: '.' }), /contain each other/);
  assert.throws(() => root({ CCGUI_ISOLATED_ROOT: container }), /contain each other/);
  assert.throws(() => root({ CCGUI_ISOLATED_ROOT: '../a=b' }), /"="/);
  assert.throws(() => isolatedRoot(path.resolve('/ccgui-custom'), { CCGUI_ISOLATED_ROOT: `../${'x'.repeat(80)}` }), /shorter/);
  assert.equal(isolatedRoot(path.resolve('/Projects/ccgui-custom'), {}), path.resolve('/Projects/ccgui-iso'));
});

test('literal path lists reject anything outside the repository or interpreted by git', () => {
  assert.deepEqual(validatePaths(['a.txt', 'dir\\c.txt']), ['a.txt', 'dir/c.txt']);
  for (const bad of [[], ['../x'], ['a/../../x'], ['/abs'], ['C:/x'], ['-flag'], [':(top)x'], ['*.rs'], ['a?'], ['[ab]'], [''], 'x']) assert.throws(() => validatePaths(bad), /--paths/, JSON.stringify(bad));
});

// ---- Lock ------------------------------------------------------------------
function lockHooks(table, extra = {}) {
  return { pid: 4242, now: () => 1_000_000, processStart: pid => (pid in table ? table[pid] : undefined), ...extra };
}
const lockFile = root => path.join(root, 'isolated-build.lock');

test('the lock is exclusive, names its holder and is released only by its owner', t => {
  const root = temporary(t);
  const release = acquireLock(root, 'isolated check', lockHooks({ 4242: 1000 }));
  const holder = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
  assert.equal(holder.pid, 4242);
  assert.equal(holder.processStart, 1000);
  assert.equal(holder.purpose, 'isolated check');
  assert.throws(() => acquireLock(root, 'second', lockHooks({ 4242: 1000, 7: 1000 }, { pid: 7 })), /Another isolated build is running \(pid 4242/);
  assert.ok(fs.existsSync(lockFile(root)));
  release();
  assert.equal(fs.existsSync(lockFile(root)), false);
  acquireLock(root, 'again', lockHooks({ 4242: 1000 }))();
});

test('a dead holder or a reused process id is stale, a live or unknown holder is not', t => {
  const root = temporary(t);
  const hooks = table => lockHooks(table, { pid: 7 });
  const plant = (processStart, pid = 4242) => fs.writeFileSync(lockFile(root), JSON.stringify({ pid, token: 'old', processStart, startedAt: 'x', purpose: 'old run' }));
  // The recorded process is gone.
  plant(1000);
  acquireLock(root, 'new', hooks({ 7: 5000, 4242: null }))();
  // Same pid, started long after the recorded start: the id was reused.
  plant(1000);
  acquireLock(root, 'new', hooks({ 7: 5000, 4242: 1000 + 60_000 }))();
  // Same pid and start within tolerance: still running.
  plant(1000);
  assert.throws(() => acquireLock(root, 'new', hooks({ 7: 5000, 4242: 1000 + 2000 })), /Another isolated build is running/);
  // The start time cannot be read: never assume a build is dead.
  assert.throws(() => acquireLock(root, 'new', hooks({ 7: 5000, 4242: undefined })), /Another isolated build is running/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile(root), 'utf8')).token, 'old');
});

test('an unreadable lock is a holder in the middle of creating it until it is old', t => {
  const root = temporary(t);
  const hooks = lockHooks({ 7: 5000 }, { pid: 7 });
  fs.writeFileSync(lockFile(root), '');
  assert.throws(() => acquireLock(root, 'new', { ...hooks, now: () => fs.statSync(lockFile(root)).mtimeMs + 1000 }), /being created/);
  acquireLock(root, 'new', { ...hooks, now: () => fs.statSync(lockFile(root)).mtimeMs + 60_000 })();
  fs.writeFileSync(lockFile(root), '{not json');
  acquireLock(root, 'new', { ...hooks, now: () => fs.statSync(lockFile(root)).mtimeMs + 60_000 })();
});

test('an old release function never removes a lock that another process took over', t => {
  const root = temporary(t);
  const releaseFirst = acquireLock(root, 'first', lockHooks({ 4242: 1000 }));
  // The first process is considered dead and the lock is taken over.
  const releaseSecond = acquireLock(root, 'second', lockHooks({ 4242: null, 8: 2000 }, { pid: 8 }));
  releaseFirst();
  assert.equal(JSON.parse(fs.readFileSync(lockFile(root), 'utf8')).pid, 8);
  releaseSecond();
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('a leftover takeover guard does not block forever', t => {
  const root = temporary(t);
  const guard = `${lockFile(root)}.takeover`;
  fs.writeFileSync(lockFile(root), JSON.stringify({ pid: 4242, token: 'old', processStart: 1, startedAt: 'x', purpose: 'old' }));
  fs.writeFileSync(guard, '');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(guard, old, old);
  acquireLock(root, 'new', lockHooks({ 4242: null, 7: 1 }, { pid: 7, now: Date.now }))();
  assert.equal(fs.existsSync(guard), false);
});

// ---- Snapshot --------------------------------------------------------------
test('a clean tree is its own snapshot', t => {
  const r = repository(t);
  const head = r.run('rev-parse', 'HEAD');
  const snapshot = createSnapshotCommit(r.repo, r.isolated);
  assert.deepEqual({ ...snapshot, changed: snapshot.changed.length }, { commit: head, parent: head, synthetic: false, changed: 0 });
  assert.throws(() => r.run('rev-parse', '--verify', SNAPSHOT_REF));
});

test('the snapshot holds the whole working tree and leaves the repository untouched', t => {
  const r = repository(t);
  const head = r.run('rev-parse', 'HEAD');
  write(r.repo, 'a.txt', 'a changed\n');
  fs.rmSync(path.join(r.repo, 'b.txt'));
  write(r.repo, 'new/untracked.txt', 'u\n');
  write(r.repo, 'ignored.txt', 'ignored\n');
  write(r.repo, 'build/out.bin', 'out\n');
  write(r.repo, 'dir/c.txt', 'c staged\n');
  r.run('add', 'dir/c.txt');
  write(r.repo, 'dir/c.txt', 'c staged then changed\n');
  const statusBefore = r.run('status', '--porcelain=v1');
  const indexBefore = fs.readFileSync(path.join(r.repo, '.git/index'));
  const snapshot = createSnapshotCommit(r.repo, r.isolated);
  assert.equal(snapshot.synthetic, true);
  assert.equal(snapshot.parent, head);
  assert.equal(r.run('rev-parse', `${snapshot.commit}^`), head);
  assert.equal(r.run('rev-parse', SNAPSHOT_REF), snapshot.commit);
  assert.deepEqual(treeFiles(r.repo, snapshot.commit), ['.gitignore', 'a.txt', 'dir/c.txt', 'new/untracked.txt', 'package.json', 'pnpm-lock.yaml']);
  assert.equal(show(r.repo, snapshot.commit, 'a.txt'), 'a changed');
  assert.equal(show(r.repo, snapshot.commit, 'dir/c.txt'), 'c staged then changed');
  assert.deepEqual(snapshot.changed.sort(), ['A\tnew/untracked.txt', 'D\tb.txt', 'M\ta.txt', 'M\tdir/c.txt']);
  // Nothing of the developer's repository moved.
  assert.equal(r.run('rev-parse', 'HEAD'), head);
  assert.equal(r.run('branch', '--show-current'), 'main');
  assert.equal(r.run('status', '--porcelain=v1'), statusBefore);
  assert.deepEqual(fs.readFileSync(path.join(r.repo, '.git/index')), indexBefore);
  assert.equal(fs.readFileSync(path.join(r.repo, 'a.txt'), 'utf8'), 'a changed\n');
  assert.deepEqual(fs.readdirSync(path.join(r.isolated, 'tmp')), []);
});

test('an unchanged working tree keeps one snapshot commit across runs', t => {
  const r = repository(t);
  write(r.repo, 'a.txt', 'edited\n');
  const first = createSnapshotCommit(r.repo, r.isolated);
  assert.equal(createSnapshotCommit(r.repo, r.isolated).commit, first.commit);
  write(r.repo, 'a.txt', 'edited again\n');
  const second = createSnapshotCommit(r.repo, r.isolated);
  assert.notEqual(second.commit, first.commit);
  assert.equal(r.run('rev-parse', SNAPSHOT_REF), second.commit);
  // Committing the same content moves HEAD, so the parent changes and so does the commit.
  r.run('add', '--all');
  r.run('commit', '--quiet', '-m', 'same content');
  assert.equal(createSnapshotCommit(r.repo, r.isolated).synthetic, false);
});

test('listed paths are the only changes added to HEAD', t => {
  const r = repository(t);
  write(r.repo, 'a.txt', 'a changed\n');
  fs.rmSync(path.join(r.repo, 'b.txt'));
  write(r.repo, 'new.txt', 'n\n');
  write(r.repo, 'dir/extra.txt', 'e\n');
  const snapshot = createSnapshotCommit(r.repo, r.isolated, { paths: ['a.txt', 'dir'] });
  assert.deepEqual(snapshot.changed.sort(), ['A\tdir/extra.txt', 'M\ta.txt']);
  assert.equal(show(r.repo, snapshot.commit, 'b.txt'), 'b');
  assert.equal(treeFiles(r.repo, snapshot.commit).includes('new.txt'), false);
  // A listed deletion is a change too, and a path pattern is never expanded.
  assert.deepEqual(createSnapshotCommit(r.repo, r.isolated, { paths: ['b.txt'] }).changed, ['D\tb.txt']);
  assert.throws(() => createSnapshotCommit(r.repo, r.isolated, { paths: ['*.txt'] }), /literal paths/);
  assert.throws(() => createSnapshotCommit(r.repo, r.isolated, { paths: ['missing-file.txt'] }), /git add failed/);
});

test('flagged files cannot hide working-tree edits from the snapshot', t => {
  const r = repository(t);
  r.run('update-index', '--skip-worktree', 'a.txt');
  r.run('update-index', '--assume-unchanged', 'dir/c.txt');
  write(r.repo, 'a.txt', 'a edited behind a flag\n');
  write(r.repo, 'dir/c.txt', 'c edited behind a flag\n');
  const snapshot = createSnapshotCommit(r.repo, r.isolated);
  assert.equal(show(r.repo, snapshot.commit, 'a.txt'), 'a edited behind a flag');
  assert.equal(show(r.repo, snapshot.commit, 'dir/c.txt'), 'c edited behind a flag');
});

test('the snapshot worktree is created once and later updates keep ignored outputs and unchanged files', t => {
  const r = repository(t);
  const snapshotDir = path.join(r.isolated, 'snapshot');
  const first = r.run('rev-parse', 'HEAD');
  prepareSnapshot(r.repo, snapshotDir, first);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a\n');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(snapshotDir, 'package.json'), old, old);
  // Git rewrites files whose cached stat is stale; a real snapshot's stat cache is current.
  git(['update-index', '--refresh'], { cwd: snapshotDir });
  write(snapshotDir, 'build/out.bin', 'kept build output');
  write(snapshotDir, 'node_modules/dep/index.js', 'kept dependency');
  write(snapshotDir, 'stray-source.rs', 'untracked leftover');
  write(snapshotDir, 'dir/c.txt', 'locally modified');
  write(r.repo, 'a.txt', 'a changed\n');
  const second = createSnapshotCommit(r.repo, r.isolated).commit;
  prepareSnapshot(r.repo, snapshotDir, second);
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: snapshotDir }), second);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a changed\n');
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'dir/c.txt'), 'utf8'), 'c\n');
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'build/out.bin'), 'utf8'), 'kept build output');
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'node_modules/dep/index.js'), 'utf8'), 'kept dependency');
  assert.equal(fs.existsSync(path.join(snapshotDir, 'stray-source.rs')), false);
  // Cargo and Vite fingerprints use mtimes: an unchanged file must not be rewritten.
  assert.equal(fs.statSync(path.join(snapshotDir, 'package.json')).mtimeMs, old.getTime());
  assert.equal(git(['status', '--porcelain=v1'], { cwd: snapshotDir }), '');
});

test('snapshots hold the committed bytes even when the user converts line endings on checkout', t => {
  const r = repository(t);
  r.run('config', 'core.autocrlf', 'true');
  const head = r.run('rev-parse', 'HEAD');
  const snapshotDir = path.join(r.isolated, 'snapshot');
  prepareSnapshot(r.repo, snapshotDir, head);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a\n');
  // Later commands outside the helper use the user's configuration and must still see a clean tree.
  assert.equal(git(['status', '--porcelain=v1'], { cwd: snapshotDir }), '');
  write(r.repo, 'a.txt', 'a changed\n');
  prepareSnapshot(r.repo, snapshotDir, createSnapshotCommit(r.repo, r.isolated).commit);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a changed\n');
  assert.equal(git(['status', '--porcelain=v1'], { cwd: snapshotDir }), '');
});

test('a worktree written with line-ending conversion is rewritten once and keeps ignored outputs', t => {
  const r = repository(t);
  r.run('config', 'core.autocrlf', 'true');
  const head = r.run('rev-parse', 'HEAD');
  const snapshotDir = path.join(r.isolated, 'snapshot');
  fs.mkdirSync(r.isolated, { recursive: true });
  git(['worktree', 'add', '--detach', '--quiet', snapshotDir, head], { cwd: r.repo });
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a\r\n');
  write(snapshotDir, 'build/out.bin', 'kept build output');
  prepareSnapshot(r.repo, snapshotDir, head);
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'build/out.bin'), 'utf8'), 'kept build output');
  assert.equal(git(['status', '--porcelain=v1'], { cwd: snapshotDir }), '');
  // The conversion is migrated once; afterwards unchanged files are left alone.
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(path.join(snapshotDir, 'package.json'), old, old);
  git(['update-index', '--refresh'], { cwd: snapshotDir });
  prepareSnapshot(r.repo, snapshotDir, head);
  assert.equal(fs.statSync(path.join(snapshotDir, 'package.json')).mtimeMs, old.getTime());
});

test('a directory that is not this repository\'s worktree is never reset', t => {
  const r = repository(t);
  const other = repository(t);
  const head = r.run('rev-parse', 'HEAD');
  const plain = path.join(r.isolated, 'snapshot');
  write(plain, 'precious.txt', 'user data');
  assert.throws(() => prepareSnapshot(r.repo, plain, head), /not a worktree/);
  assert.equal(fs.readFileSync(path.join(plain, 'precious.txt'), 'utf8'), 'user data');
  const foreign = path.join(other.container, 'foreign');
  git(['worktree', 'add', '--detach', '--quiet', foreign, other.run('rev-parse', 'HEAD')], { cwd: other.repo });
  write(foreign, 'precious.txt', 'user data');
  assert.throws(() => prepareSnapshot(r.repo, foreign, head), /another repository/);
  assert.equal(fs.readFileSync(path.join(foreign, 'precious.txt'), 'utf8'), 'user data');
  const file = path.join(r.container, 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => prepareSnapshot(r.repo, path.join(file, 'snapshot'), head));
});

// ---- Dependencies and environment ------------------------------------------
test('the dependency key follows manifests, the lockfile and patches only', t => {
  const r = repository(t, { 'patches/x.patch': 'p1', 'packages/sdk/package.json': '{}\n' });
  const key = commit => dependencyKey(r.repo, commit);
  const base = key('HEAD');
  const commitChange = (file, contents) => { write(r.repo, file, contents); r.run('add', '--all'); r.run('commit', '--quiet', '-m', file); return key('HEAD'); };
  assert.equal(commitChange('src/code.ts', 'code'), base);
  assert.equal(commitChange('docs/readme.md', 'docs'), base);
  const lock = commitChange('pnpm-lock.yaml', 'lock: 2\n');
  assert.notEqual(lock, base);
  const patch = commitChange('patches/x.patch', 'p2');
  assert.notEqual(patch, lock);
  assert.notEqual(commitChange('packages/sdk/package.json', '{"a":1}\n'), patch);
});

test('dependencies are installed offline first, only when their key changed', async t => {
  const r = repository(t);
  const snapshotDir = path.join(r.isolated, 'snapshot');
  prepareSnapshot(r.repo, snapshotDir, r.run('rev-parse', 'HEAD'));
  const corepack = write(r.container, 'corepack.js', '');
  const calls = [];
  const install = results => async (exe, args, options) => {
    calls.push(args.slice(1));
    assert.equal(options.cwd, snapshotDir);
    const code = results.shift() ?? 0;
    if (code === 0) fs.mkdirSync(path.join(snapshotDir, 'node_modules'), { recursive: true });
    return code;
  };
  const head = () => r.run('rev-parse', 'HEAD');
  assert.deepEqual(await ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([]), corepack }), { installed: true, mode: '--offline' });
  assert.deepEqual(calls, [['pnpm', 'install', '--frozen-lockfile', '--offline']]);
  assert.deepEqual(await ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([]), corepack }), { installed: false });
  assert.equal(calls.length, 1);
  // A changed lockfile installs again; an incomplete offline store falls back to the network.
  write(r.repo, 'pnpm-lock.yaml', 'lock: 2\n');
  r.run('add', '--all');
  r.run('commit', '--quiet', '-m', 'lock');
  prepareSnapshot(r.repo, snapshotDir, head());
  assert.deepEqual(await ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([1]), corepack }), { installed: true, mode: '--prefer-offline' });
  assert.deepEqual(calls.slice(1).map(call => call.at(-1)), ['--offline', '--prefer-offline']);
  // Both attempts failing leaves no state that would suppress the next try.
  write(r.repo, 'pnpm-lock.yaml', 'lock: 3\n');
  r.run('add', '--all');
  r.run('commit', '--quiet', '-m', 'lock 3');
  prepareSnapshot(r.repo, snapshotDir, head());
  await assert.rejects(ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([1, 1]), corepack }), /pnpm install failed/);
  assert.deepEqual(await ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([]), corepack }), { installed: true, mode: '--offline' });
  write(r.repo, 'pnpm-lock.yaml', 'lock: 4\n');
  r.run('add', '--all');
  r.run('commit', '--quiet', '-m', 'lock 4');
  prepareSnapshot(r.repo, snapshotDir, head());
  await assert.rejects(ensureDependencies(r.isolated, snapshotDir, head(), {}, { install: install([]), corepack: path.join(r.container, 'missing.js') }), /corepack was not found/);
});

test('the child environment drops agent-session variables, keeps proxies and moves temporary files', t => {
  const root = temporary(t);
  const env = sanitizedEnvironment(root, {
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CODEX_HOME: 'c', GIT_INDEX_FILE: 'i', GIT_DIR: 'd', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', CCGUI_FRONTEND_FINGERPRINT: 'f', CCGUI_VITEST_WORKERS: '3', CCGUI_RELEASE_PARALLEL: '0',
    HTTPS_PROXY: 'http://proxy.fixture:8080', USERPROFILE: 'home', PATH: process.env.PATH ?? process.env.Path, TEMP: 'elsewhere',
  });
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'GIT_INDEX_FILE', 'GIT_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CCGUI_FRONTEND_FINGERPRINT']) assert.equal(name in env, false, name);
  assert.equal(env.CCGUI_VITEST_WORKERS, '3');
  assert.equal(env.CCGUI_RELEASE_PARALLEL, '0');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.fixture:8080');
  assert.equal(env.USERPROFILE, 'home');
  assert.deepEqual([env.TEMP, env.TMP, env.TMPDIR], Array(3).fill(path.join(root, 'tmp')));
  assert.equal(env.CCGUI_SOURCE_SNAPSHOT, '1');
  assert.equal(env.CARGO_PROFILE_DEV_DEBUG, 'line-tables-only');
  // Git inside the run must not convert line endings of the snapshot.
  assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ['1', 'core.autocrlf', 'false']);
});

// ---- Entry point -----------------------------------------------------------
function entry(t, extra = {}) {
  const r = repository(t);
  const calls = [];
  const hooks = { processStart: pid => (pid === process.pid ? 1000 : undefined), install: async () => { fs.mkdirSync(path.join(r.isolated, 'snapshot/node_modules'), { recursive: true }); return 0; }, corepack: write(r.container, 'corepack.js', ''), ...extra.hooks };
  const run = async (exe, args, options) => { calls.push({ exe, args, ...options }); return extra.code ?? 0; };
  const options = { repoRoot: r.repo, command: 'release', env: { ...process.env, CCGUI_ISOLATED_ROOT: r.isolated }, hooks: { ...hooks, maxSnapshotPath: 1000 }, run, ...extra.options };
  return { r, calls, options };
}
const quietly = async fn => {
  const original = console.log;
  const lines = [];
  console.log = line => lines.push(String(line));
  try { return [await fn(), lines.map(line => JSON.parse(line))]; } finally { console.log = original; }
};

test('an isolated run snapshots the working tree, runs the command there and releases the lock', async t => {
  const { r, calls, options } = entry(t, { options: { fresh: true } });
  write(r.repo, 'a.txt', 'working tree edit\n');
  const [code, lines] = await quietly(() => runIsolated(options));
  const snapshotDir = path.join(r.isolated, 'snapshot');
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [path.join(snapshotDir, 'scripts/custom-maintain.mjs'), 'release', '--fresh']);
  assert.equal(calls[0].cwd, snapshotDir);
  assert.equal(calls[0].env.CCGUI_SOURCE_SNAPSHOT, '1');
  assert.equal(calls[0].env.TEMP, path.join(r.isolated, 'tmp'));
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'a.txt'), 'utf8'), 'working tree edit\n');
  assert.equal(lines[0].isolated, true);
  assert.equal(lines[0].synthetic, true);
  assert.equal(lines[0].changedFiles, 1);
  assert.match(lines.at(-1).install, /custom-maintain\.mjs" install$/);
  assert.equal(fs.existsSync(path.join(r.isolated, 'isolated-build.lock')), false);
  assert.equal(r.run('status', '--porcelain=v1'), ' M a.txt');
});

test('failed or check-only runs are not offered for installation and keep the exit code', async t => {
  const failing = entry(t, { code: 3 });
  const [code, lines] = await quietly(() => runIsolated(failing.options));
  assert.equal(code, 3);
  assert.equal(lines.at(-1).isolatedExit, 3);
  assert.equal('install' in lines.at(-1), false);
  const checking = entry(t, { options: { command: 'check' } });
  const [, checkLines] = await quietly(() => runIsolated(checking.options));
  assert.equal('install' in checkLines.at(-1), false);
  assert.deepEqual(checking.calls[0].args.slice(1), ['check']);
});

test('a second isolated run is refused while the first holds the lock, and a crash releases it', async t => {
  const { r, calls, options } = entry(t, { hooks: { processStart: () => 1000 } });
  fs.mkdirSync(r.isolated, { recursive: true });
  fs.writeFileSync(path.join(r.isolated, 'isolated-build.lock'), JSON.stringify({ pid: 99999, token: 'other', processStart: 1000, startedAt: 'earlier', purpose: 'isolated build' }));
  await assert.rejects(quietly(() => runIsolated(options)), /Another isolated build is running/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(r.isolated, 'snapshot')), false);
  fs.rmSync(path.join(r.isolated, 'isolated-build.lock'));
  const crashing = { ...options, run: async () => { throw new Error('child failed to start'); } };
  await assert.rejects(quietly(() => runIsolated(crashing)), /child failed to start/);
  assert.equal(fs.existsSync(path.join(r.isolated, 'isolated-build.lock')), false);
  await assert.rejects(runIsolated({ ...options, command: 'install' }), /Use isolated/);
});
