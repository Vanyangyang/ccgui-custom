import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// An isolated run verifies (and optionally builds) a snapshot of the working tree
// in a fixed, short-path checkout. The directory never changes, so Cargo and pnpm
// caches stay valid between runs, and nothing in the developer's checkout,
// index or build outputs is touched or locked.
export const ISOLATED_ROOT_ENV = 'CCGUI_ISOLATED_ROOT';
export const SNAPSHOT_REF = 'refs/ccgui-iso/latest';
const MAX_SNAPSHOT_PATH = 72; // Windows MAX_PATH hit the deepest Cargo and Tauri paths twice before.
const LOCK_FILE = 'isolated-build.lock';
const PID_TOLERANCE_MS = 5000;

export function isolatedRoot(repoRoot, env = process.env, maxSnapshotPath = MAX_SNAPSHOT_PATH) {
  const root = path.resolve(repoRoot, env[ISOLATED_ROOT_ENV] ?? '../ccgui-iso');
  const repo = path.resolve(repoRoot);
  const contains = (outer, inner) => {
    const relative = path.relative(outer, inner);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  if (contains(repo, root) || contains(root, repo)) throw new Error('The isolated build root and the active checkout must not contain each other');
  // MSVC path trimming stops at '=', so a build path with one cannot be made private.
  if (root.includes('=')) throw new Error('The isolated build root must not contain "="');
  if (path.join(root, 'snapshot').length > maxSnapshotPath) throw new Error(`Use a shorter isolated build root (snapshot path over ${maxSnapshotPath} characters)`);
  return root;
}

function lstatOrNull(filename) {
  try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function plainDirectory(filename) {
  const stat = lstatOrNull(filename);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('Isolated build paths must be plain directories, not links or files');
  return stat;
}

// ---- Lock -----------------------------------------------------------------
// Returns a process start time in ms, null when the process does not exist, or
// undefined when that cannot be established (treated as "still running").
export function processStartTime(pid, platform = process.platform) {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH' ? null : undefined; }
  if (platform !== 'win32') return undefined;
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`;
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const time = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
  if (Number.isFinite(time)) return time;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  return undefined;
}

function readHolder(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return value && Number.isInteger(value.pid) ? value : undefined;
  } catch { return undefined; }
}
function holderIsAlive(holder, processStart) {
  const start = processStart(holder.pid);
  if (start === null) return false;
  if (start === undefined) return true;
  // A reused PID belongs to a process created long after the recorded one.
  return !(Number.isFinite(holder.processStart) && Math.abs(start - holder.processStart) > PID_TOLERANCE_MS);
}

/** Takes the exclusive isolated-build lock and returns its release function. */
export function acquireLock(root, purpose, hooks = {}) {
  const processStart = hooks.processStart ?? processStartTime;
  const pid = hooks.pid ?? process.pid;
  const now = hooks.now ?? Date.now;
  const lockPath = path.join(root, LOCK_FILE);
  const guardPath = `${lockPath}.takeover`;
  const token = randomUUID();
  const own = processStart(pid);
  const record = JSON.stringify({ pid, token, processStart: own ?? Math.round(now() - process.uptime() * 1000), startedAt: new Date(now()).toISOString(), purpose });
  const release = () => {
    // Only remove the lock this process created.
    if (readHolder(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, record); } finally { fs.closeSync(fd); }
      return release;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readHolder(lockPath);
    const age = (() => { try { return now() - fs.statSync(lockPath).mtimeMs; } catch { return 0; } })();
    // An unreadable lock is a holder between creating and writing it, or a crash
    // during that instant; only an old one is stale.
    if (holder ? holderIsAlive(holder, processStart) : age < 10_000) {
      const who = holder ? `pid ${holder.pid}, started ${holder.startedAt}, ${holder.purpose}` : 'being created';
      throw new Error(`Another isolated build is running (${who}). Wait for it, or remove ${lockPath} if it is certainly dead.`);
    }
    // Several processes may find the same stale lock; the guard lets exactly one remove it.
    let guard;
    try { guard = fs.openSync(guardPath, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (now() - (lstatOrNull(guardPath)?.mtimeMs ?? now()) > 60_000) fs.rmSync(guardPath, { force: true });
      continue;
    }
    try {
      const current = readHolder(lockPath);
      if (JSON.stringify(current) === JSON.stringify(holder)) fs.rmSync(lockPath, { force: true });
    } finally { fs.closeSync(guard); fs.rmSync(guardPath, { force: true }); }
  }
  throw new Error('Could not take the isolated build lock; try again');
}

// ---- Snapshot -------------------------------------------------------------
export function git(args, { cwd, env = process.env, input } = {}) {
  const result = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? ''} failed (${result.status})`);
  return result.stdout.trimEnd();
}

export function validatePaths(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('--paths needs at least one repository-relative path');
  return list.map(item => {
    const value = item.replaceAll('\\', '/');
    if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || /^[-:]/.test(value) || /[*?[\]\0]/.test(value)) throw new Error('--paths entries must be literal paths inside the repository');
    return value;
  });
}

/**
 * Commits the working tree (or HEAD plus `paths`) without touching the real index,
 * working tree or branch. A tree equal to HEAD's reuses HEAD itself.
 */
export function createSnapshotCommit(repoRoot, root, { paths = null } = {}) {
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const head = git(['rev-parse', 'HEAD'], { cwd: repoRoot });
  const index = path.join(tmp, `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args, options = {}) => git(args, { cwd: repoRoot, env, ...options });
  try {
    // Never start from the real index: skip-worktree and assume-unchanged flags
    // there would hide working-tree edits from `add -A`.
    run(['read-tree', 'HEAD']);
    run(paths ? ['--literal-pathspecs', 'add', '-A', '--', ...validatePaths(paths)] : ['add', '-A']);
    const tree = run(['write-tree']);
    const changed = tree === git(['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot })
      ? []
      : git(['diff', '--name-status', '--no-renames', 'HEAD', tree], { cwd: repoRoot }).split(/\r?\n/).filter(Boolean);
    if (!changed.length) return { commit: head, parent: head, synthetic: false, changed };
    // The same tree on the same parent keeps its commit, so reruns of an unchanged
    // working tree are one provenance, not a new commit each time.
    const previous = (() => { try { return git(['rev-parse', '--verify', '--quiet', `${SNAPSHOT_REF}^{commit}`], { cwd: repoRoot }); } catch { return null; } })();
    if (previous && git(['rev-parse', `${previous}^{tree}`], { cwd: repoRoot }) === tree && git(['rev-parse', `${previous}^`], { cwd: repoRoot }) === head) return { commit: previous, parent: head, synthetic: true, changed };
    const identity = { GIT_AUTHOR_NAME: 'ccgui isolated build', GIT_AUTHOR_EMAIL: 'isolated@ccgui.invalid', GIT_COMMITTER_NAME: 'ccgui isolated build', GIT_COMMITTER_EMAIL: 'isolated@ccgui.invalid' };
    const commit = git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-m', `ccgui isolated snapshot of ${head.slice(0, 12)}`], { cwd: repoRoot, env: { ...process.env, ...identity } });
    // A ref keeps the commit reachable for the installed build's provenance.
    git(['update-ref', SNAPSHOT_REF, commit], { cwd: repoRoot });
    return { commit, parent: head, synthetic: true, changed };
  } finally { fs.rmSync(index, { force: true }); }
}

const realCommonDirectory = cwd => {
  const resolved = fs.realpathSync.native(path.resolve(cwd, git(['rev-parse', '--git-common-dir'], { cwd })));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// Snapshots are checked out without end-of-line conversion: the committed blobs
// are the canonical (LF) form that CI sees. Converting to CRLF would also make
// byte-exact checks, such as the generated SDK reference, depend on the checkout.
// Test builds only need line numbers in backtraces. Measured on this machine, cold builds of
// the lib tests and send_path went from 429 s and a 15 GB linker peak to 329 s and 6 GB.
// Only used with a target directory of its own, so the developer's shared debug cache is not rebuilt.
export const LEAN_TEST_BUILD = { CARGO_PROFILE_DEV_DEBUG: 'line-tables-only' };
export const SNAPSHOT_GIT_CONFIG = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
const FORMAT_MARKER = 'snapshot-format.json';
const SNAPSHOT_FORMAT = { eol: 'as-committed' };

/** Creates the fixed worktree on first use; later runs only rewrite files that differ. */
export function prepareSnapshot(repoRoot, snapshotDir, commit) {
  const env = { ...process.env, ...SNAPSHOT_GIT_CONFIG };
  const marker = path.join(path.dirname(snapshotDir), FORMAT_MARKER);
  plainDirectory(path.dirname(snapshotDir));
  if (!plainDirectory(snapshotDir)) {
    fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
    git(['worktree', 'add', '--detach', '--quiet', snapshotDir, commit], { cwd: repoRoot, env });
    fs.writeFileSync(marker, JSON.stringify(SNAPSHOT_FORMAT) + '\n');
    return;
  }
  if (!lstatOrNull(path.join(snapshotDir, '.git'))) throw new Error('The snapshot directory exists but is not a worktree of this repository');
  if (realCommonDirectory(snapshotDir) !== realCommonDirectory(repoRoot)) throw new Error('The snapshot directory belongs to another repository');
  let current = false;
  try { current = JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8'))) === JSON.stringify(SNAPSHOT_FORMAT); } catch { /* Unknown format: rewrite. */ }
  if (current) {
    // Ignored outputs (node_modules, target, artifacts) survive; only tracked files and
    // stray untracked sources are reset, so Cargo fingerprints of unchanged files hold.
    git(['checkout', '--quiet', '--force', '--detach', commit], { cwd: snapshotDir, env });
  } else {
    // Files written under another conversion setting look modified but are never
    // rewritten while their cached stat matches, so drop the index and write them all.
    const gitDirectory = path.resolve(snapshotDir, git(['rev-parse', '--git-dir'], { cwd: snapshotDir, env }));
    fs.rmSync(path.join(gitDirectory, 'index'), { force: true });
    git(['reset', '--hard', '--quiet', commit], { cwd: snapshotDir, env });
    fs.writeFileSync(marker, JSON.stringify(SNAPSHOT_FORMAT) + '\n');
  }
  git(['clean', '-fdq'], { cwd: snapshotDir, env });
}

// ---- Dependencies and environment -----------------------------------------
export function dependencyKey(snapshotDir, commit) {
  const listing = git(['ls-tree', '-r', '-z', commit], { cwd: snapshotDir }).split('\0').filter(Boolean);
  const relevant = listing.filter(entry => /\t(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|(?:[^\t]*\/)?package\.json|patches\/[^\t]*)$/.test(entry));
  return createHash('sha256').update(relevant.sort().join('\n')).digest('hex');
}

export function sanitizedEnvironment(root, base = process.env) {
  const env = {};
  // Agent-session variables change how child tools and tests behave, and inherited
  // GIT_* variables would redirect the git calls of the tests themselves.
  for (const [name, value] of Object.entries(base)) if (!/^(?:CLAUDE|CCGUI_|CODEX_|GIT_|ANTHROPIC_|OPENAI_|GEMINI_)/i.test(name) || /^CCGUI_(?:VITEST_WORKERS|RELEASE_PARALLEL)$/i.test(name)) env[name] = value;
  const tmp = path.join(root, 'tmp');
  Object.assign(env, { TEMP: tmp, TMP: tmp, TMPDIR: tmp, CCGUI_SOURCE_SNAPSHOT: '1' }, LEAN_TEST_BUILD, SNAPSHOT_GIT_CONFIG);
  if (process.platform === 'win32') {
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    const entries = (env[key] ?? '').split(path.delimiter);
    const kits = 'C:/Program Files (x86)/Windows Kits/10/bin';
    // tauri-winres needs rc.exe; fall back to the newest installed Windows SDK.
    if (!entries.some(entry => entry && fs.existsSync(path.join(entry, 'rc.exe'))) && fs.existsSync(kits)) {
      const versions = fs.readdirSync(kits).filter(name => /^10\./.test(name) && fs.existsSync(path.join(kits, name, 'x64', 'rc.exe'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (versions.length) env[key] = [path.join(kits, versions.at(-1), 'x64'), ...entries].join(path.delimiter);
    }
  }
  return env;
}

function spawnLogged(exe, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 1));
  });
}

const defaultCorepack = path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/corepack.js');
export async function ensureDependencies(root, snapshotDir, commit, env, { install = spawnLogged, corepack = defaultCorepack } = {}) {
  const key = dependencyKey(snapshotDir, commit);
  const statePath = path.join(root, 'dependencies.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* No record: install. */ }
  if (state?.key === key && fs.existsSync(path.join(snapshotDir, 'node_modules'))) return { installed: false };
  if (!fs.existsSync(corepack)) throw new Error('corepack was not found next to Node; install dependencies in the snapshot manually');
  // The store is shared, so a complete store makes this a hard-link only operation.
  for (const mode of ['--offline', '--prefer-offline']) {
    if (await install(process.execPath, [corepack, 'pnpm', 'install', '--frozen-lockfile', mode], { cwd: snapshotDir, env }) === 0) {
      fs.writeFileSync(statePath, JSON.stringify({ key }) + '\n');
      return { installed: true, mode };
    }
  }
  throw new Error('pnpm install failed in the snapshot');
}

// ---- Entry point ----------------------------------------------------------
export const ISOLATED_COMMANDS = ['check', 'build', 'release'];
export async function runIsolated({ repoRoot, command, fresh = false, paths = null, env = process.env, hooks = {}, run = spawnLogged }) {
  if (!ISOLATED_COMMANDS.includes(command)) throw new Error(`Use isolated ${ISOLATED_COMMANDS.join(', ')}`);
  const root = isolatedRoot(repoRoot, env, hooks.maxSnapshotPath);
  plainDirectory(root);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const snapshotDir = path.join(root, 'snapshot');
  const release = acquireLock(root, `isolated ${command}`, hooks);
  const onSignal = signal => { release(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const snapshot = createSnapshotCommit(repoRoot, root, { paths });
    prepareSnapshot(repoRoot, snapshotDir, snapshot.commit);
    const childEnv = sanitizedEnvironment(root, env);
    const dependencies = await ensureDependencies(root, snapshotDir, snapshot.commit, childEnv, { install: hooks.install, corepack: hooks.corepack });
    const script = path.join(snapshotDir, 'scripts/custom-maintain.mjs');
    console.log(JSON.stringify({ isolated: true, snapshot: snapshotDir, commit: snapshot.commit, parent: snapshot.parent, synthetic: snapshot.synthetic, changedFiles: snapshot.changed.length, changed: snapshot.changed.slice(0, 30), dependencies }));
    const code = await run(process.execPath, [script, command, ...(fresh ? ['--fresh'] : [])], { cwd: snapshotDir, env: childEnv });
    const installable = code === 0 && command !== 'check';
    console.log(JSON.stringify({ isolatedExit: code, ...(installable ? { install: `node "${script}" install` } : {}) }));
    return code;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    release();
  }
}
