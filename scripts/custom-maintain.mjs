import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { assertNativeReleasePaths, prepareReleaseCompiler } from './release-compiler.mjs';
import { NATIVE_EMBEDDED_INPUTS, defaultCargoJobs } from './self-update-build.mjs';
import { LEAN_TEST_BUILD, runIsolated } from './isolated-build.mjs';
import { canReuseStage, headEntries, loadStageCache, runStages, saveStageCache, stageKey, stageScopes, summarizeResults, toolVersions } from './check-stages.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://github.com/zhukunpenglinyutong/desktop-cc-gui.git';
const production = { root: ROOT, upstream: UPSTREAM, backup: path.resolve(ROOT, '../ccgui-custom-backup.git'), userProfile: process.env.USERPROFILE };
export function safeRef(ref) {
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.includes('//') || /[./]$|(^|\/)\.|\.lock(\/|$)/.test(ref)) throw new Error('Use an explicit safe upstream tag or commit');
  return ref;
}
export function inside(root, value) {
  const result = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), result);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the intended directory');
  return result;
}
export function git(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, env: proxyEnvironment(), encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (${r.status})`);
  return r.stdout.trimEnd();
}
export function proxyEnvironment(base = process.env) {
  // Build tools inherit the invoking terminal's network policy. Do not inject
  // a maintainer's proxy or read network settings from AI CLI credentials.
  return { ...base };
}
export function nativeEnvironment(base = process.env, jobs = defaultCargoJobs(), targetDir = path.join(ROOT, 'src-tauri', 'target')) {
  const env = proxyEnvironment(base);
  env.CARGO_TARGET_DIR = targetDir;
  // Scaled to the machine but capped so cold builds fit beside the running app.
  env.CARGO_BUILD_JOBS ??= jobs;
  return env;
}
export const VITEST_WORKER_BYTES = 1024 ** 3;
// jsdom workers are memory-heavy and more workers also lengthen cold lazy-module
// transforms, so the default follows both the core count and the memory that is
// free now. Test files and their deadlines are unchanged.
export function vitestWorkers(base = process.env, cpus = os.availableParallelism(), freeBytes = os.freemem()) {
  const value = base.CCGUI_VITEST_WORKERS ?? String(Math.min(8, Math.max(2, Math.min(Math.floor(cpus / 3), Math.floor(freeBytes / VITEST_WORKER_BYTES)))));
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 64) throw new Error('CCGUI_VITEST_WORKERS must be an integer from 1 to 64');
  return value;
}
// Cargo reports compile failures with exit code 101, the same as a failed test.
const COMPILE_FAILURE = /could not compile|failed to run custom build command|error: linking with/;
async function runLogged(label, exe, args, cwd, env, log, detectCompileFailure = false) {
  console.log(JSON.stringify({ stage: label, started: true }));
  log.write(`\n===== ${label} =====\n`);
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = data => {
      log.write(data);
      if (detectCompileFailure) tail = (tail + data).slice(-65536);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', code => {
      console.log(JSON.stringify({ stage: label, exit: code }));
      resolve({ code, compileFailed: code !== 0 && COMPILE_FAILURE.test(tail) });
    });
  });
}
async function run(label, exe, args, cwd, env, log) {
  const result = await runLogged(label, exe, args, cwd, env, log);
  if (result.code !== 0) throw new Error(`${label} failed; inspect the saved log`);
}
function checkedPath(root, value) {
  const result = inside(root, value);
  let current = result;
  while (current !== path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Maintenance paths must not use symbolic links or junctions');
      if (current !== result && !stat.isDirectory()) throw new Error('Maintenance path ancestors must be directories');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    current = path.dirname(current);
  }
  return result;
}
function paths(root = ROOT) {
  const artifacts = checkedPath(root, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  return artifacts;
}
// Name filters of the library tests verified before a release: Claude and quota,
// auto title, isolated title calls, single instance, startup modes, bundled skills
// and agents, relay transport, passive throughput, task control, host chat, Codex,
// plugin boundaries, Leader, update compatibility, history archive and deletion.
export const NATIVE_TEST_AREAS = ['claude', 'auto_title', 'engine::side_call::tests', 'single_instance::tests', 'startup::tests', 'creator_skill::tests', 'agent_catalog::tests', 'relay', 'reader::terminal_event_tests::throughput_', 'native_task_control', 'host_chat', 'engine::codex', 'plugin_caps', 'leader', 'live_update::', 'handoff::tests::', 'activation::tests::', 'history::reader::'];
// Verification is declarative: scopes decide when a passed stage may be reused,
// `phase: 'quick'` stages gate the parallel installer build in `release`, and
// `group` lets a compile failure skip the stages that would only repeat it.
export function checkStages(workers = vitestWorkers()) {
  const node = process.execPath;
  const cargo = (id, label, args) => ({ id, label, phase: 'full', scope: 'native', group: 'native', cargo: true, exe: 'cargo', args: ['test', '--quiet', ...args], cwd: 'src-tauri' });
  const vitest = ['node_modules/vitest/vitest.mjs', 'run'];
  return [
    { id: 'privacy-boundary', label: 'privacy boundary', phase: 'quick', scope: 'all', always: true, exe: node, args: ['--experimental-strip-types', '--test', 'tests/privacy-boundary.test.ts'] },
    { id: 'native-build-paths', label: 'native build paths', phase: 'quick', scope: 'all', always: true, exe: node, args: ['scripts/native-path-scan.mjs'] },
    { id: 'release-compiler', label: 'release compiler privacy', phase: 'quick', scope: 'scripts', exe: node, args: ['--test', 'scripts/release-compiler.test.mjs'] },
    { id: 'self-update-build', label: 'self-update build safety', phase: 'quick', scope: 'scripts', exe: node, args: ['--test', 'scripts/self-update-build.test.mjs', 'scripts/native-path-scan.test.mjs'] },
    { id: 'types', label: 'types', phase: 'quick', scope: 'frontend', exe: node, args: ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', 'artifacts/types.tsbuildinfo'] },
    // The database contract fails fastest here; an incompatible schema needs an
    // offline installation, so it must not surface only after packaging.
    cargo('native-schema-contract', 'native schema contract', ['task_worker::tests::schema_', '--lib']),
    // One process for the selected library tests: a Cargo invocation per area
    // cost about two seconds each and ran tests matching two areas twice.
    cargo('native-library', 'native library areas', ['--lib', '--', ...NATIVE_TEST_AREAS, '--skip', 'assistant_notices']),
    cargo('native-assistant-notices', 'native assistant notices', ['assistant_notices', '--lib', '--', '--test-threads=1']),
    cargo('native-send-path', 'native isolated send path', ['--features', 'test-harness', '--test', 'send_path']),
    // The worker count schedules the same tests; it must not invalidate a pass.
    { id: 'vitest', label: 'vitest', phase: 'full', scope: 'frontend', exe: node, args: [...vitest, '--maxWorkers', workers], keyArgs: vitest },
    // Node runs these files in parallel; tests inside one file run one after another.
    { id: 'maintenance', label: 'maintenance safety', phase: 'full', scope: 'tooling', exe: node, args: ['--test', 'scripts/custom-maintain.test.mjs', 'scripts/custom-maintain-install.test.mjs', 'scripts/custom-maintain-install-failures.test.mjs', 'scripts/check-stages.test.mjs', 'scripts/isolated-build.test.mjs'] },
  ];
}
// One cache per checkout; both phases of a release share it.
function verificationSession(context, head, fresh) {
  const cacheFile = path.join(paths(context.root), 'custom-check-stages.json');
  return { context, head, fresh, cacheFile, entries: headEntries(context.root), scopes: stageScopes(NATIVE_EMBEDDED_INPUTS), tools: toolVersions(), cache: loadStageCache(cacheFile) };
}
function verificationStageKey(session, stage, env = process.env) {
  return stageKey(stage, { entries: session.entries, scopes: session.scopes, tools: session.tools, env });
}
export function verificationStageReusable(session, stage, env = process.env) {
  return canReuseStage(stage, { cache: session.cache, fresh: session.fresh, key: verificationStageKey(session, stage, env) });
}
async function runPhase(session, stages, env, log) {
  const { context, head, fresh, cacheFile, cache } = session;
  return await runStages(stages, {
    cache, head, fresh,
    key: stage => verificationStageKey(session, stage),
    save: value => saveStageCache(cacheFile, value),
    emit: event => console.log(JSON.stringify(event)),
    execute: async stage => {
      const result = await runLogged(stage.label, stage.exe, stage.args, path.join(context.root, stage.cwd ?? '.'), env, log, stage.cargo);
      return result.code === 0 ? { ok: true } : { ok: false, compileFailed: result.compileFailed, message: `${stage.label} failed; inspect the saved log` };
    },
  });
}
function finishVerification(context, head, results, logPath) {
  const summary = summarizeResults(results);
  if (summary.failed.length) {
    console.log(JSON.stringify({ passed: false, ...summary, log: logPath }));
    throw new Error(`Verification failed: ${summary.failed.join(', ')}; inspect the saved log`);
  }
  git(['diff', '--check'], context.root);
  recordVerification(context, head, [...results.map(result => result.label), 'diff'], results);
  console.log(JSON.stringify({ passed: true, log: logPath, ran: summary.ran.length, reused: summary.reused.length }));
}
function cleanHead() {
  const head = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain=v1'])) throw new Error('Commit local work before verification');
  return head;
}
async function check({ fresh = false } = {}) {
  const checkedHead = cleanHead();
  const filename = path.join(paths(), 'custom-check.log');
  const log = fs.createWriteStream(filename);
  try {
    const session = verificationSession(production, checkedHead, fresh);
    finishVerification(production, checkedHead, await runPhase(session, checkStages(), nativeEnvironment(), log), filename);
  } finally { log.end(); }
}
// Cargo takes one lock per target directory, so a build and a test run sharing
// it would simply queue. The installer keeps its usual target; checks get their own.
export function splitJobs(total) {
  return { build: String(Math.max(1, Math.ceil(total / 2))), check: String(Math.max(1, Math.floor(total / 2))) };
}
export function releaseJobs(total, { parallel, session, stages, env = process.env }) {
  const nativeChecksPending = stages.some(stage => stage.phase === 'full' && stage.cargo && !verificationStageReusable(session, stage, env));
  return parallel && !env.CARGO_BUILD_JOBS && nativeChecksPending ? splitJobs(total) : { build: String(total), check: String(total) };
}
export function installerBuildConfig(root = ROOT, { typesVerified = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.custom/manifest.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, '.custom/tauri.json'), 'utf8'));
  const base = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  config.version = `${pkg.version}+protected.${manifest.patchRevision}`;
  // Standalone pnpm build retains its typecheck. Only verified installer builds
  // may reuse types from this release or from the current stage-cache key.
  // Preserve custom hooks or additional package build steps instead of bypassing them.
  const windowsConfig = path.join(root, 'src-tauri/tauri.windows.conf.json');
  const overlays = [...(fs.existsSync(windowsConfig) ? [JSON.parse(fs.readFileSync(windowsConfig, 'utf8'))] : []), config];
  let hook = base.build?.beforeBuildCommand;
  for (const overlay of overlays) if (Object.hasOwn(overlay.build ?? {}, 'beforeBuildCommand')) hook = overlay.build.beforeBuildCommand;
  const lifecycleHooks = Object.hasOwn(pkg.scripts ?? {}, 'prebuild') || Object.hasOwn(pkg.scripts ?? {}, 'postbuild');
  if (typesVerified && hook === 'npm run build' && pkg.scripts?.build === 'tsc --noEmit && vite build' && !lifecycleHooks) {
    config.build = { ...config.build, beforeBuildCommand: 'node node_modules/vite/bin/vite.js build' };
  }
  return config;
}
async function buildArtifacts(jobs, { typesVerified = false } = {}) {
  // Production only via tauri build (embeds frontendDist). Bare cargo build --release
  // leaves the WebView on build.devUrl (http://localhost:1420) and breaks without Vite.
  const artifacts = paths();
  const config = installerBuildConfig(ROOT, { typesVerified });
  const configPath = path.join(artifacts, 'custom-tauri.json');
  const configBytes = JSON.stringify(config, null, 2) + '\n';
  if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== configBytes) fs.writeFileSync(configPath, configBytes);
  const logPath = path.join(artifacts, 'custom-build.log');
  const log = fs.createWriteStream(logPath);
  try {
    const env = nativeEnvironment(process.env, jobs);
    // Ignored files can still be bundled by Vite/Tauri after verification.
    await run('package privacy', process.execPath, ['--experimental-strip-types', '--test', 'tests/privacy-boundary.test.ts'], ROOT, env, log);
    await run('package native paths', process.execPath, ['scripts/native-path-scan.mjs'], ROOT, env, log);
    assertNativeReleasePaths({ root: ROOT, env });
    const releaseEnv = prepareReleaseCompiler({ root: ROOT, artifacts, env });
    const startedAt = Date.now();
    await run('protected installer', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis', '--config', configPath], ROOT, releaseEnv, log);
    return { version: config.version, startedAt, logPath };
  } finally { log.end(); }
}
async function build() {
  const head = verifiedHead(ROOT);
  const session = verificationSession(production, head, false);
  const types = checkStages().find(stage => stage.id === 'types');
  const built = await buildArtifacts(undefined, { typesVerified: verificationStageReusable(session, types) });
  const report = recordBuild(production, built.version, built.startedAt);
  console.log(JSON.stringify({ built: true, version: built.version, commit: head, report: report.reportPath, log: built.logPath }));
}
// Verifies and builds one clean commit. The installer is only certified
// (custom-build.json) after every stage passed for this exact HEAD.
// Run in parallel, the quick stages gate the build and the rest of the checks
// share the machine with it; run in sequence, a build only starts once every
// check has passed.
export async function orchestrateRelease({ runQuick, runFull, startBuild, finish, record, parallel = true, announce = event => console.log(JSON.stringify(event)) }) {
  const quick = await runQuick();
  const buildOptions = { typesVerified: quick.some(stage => stage.id === 'types' && (stage.status === 'ran' || stage.status === 'reused')) };
  if (!parallel) {
    finish([...quick, ...await runFull()]);
    return record(await startBuild(buildOptions));
  }
  // A broken quick stage means the installer cannot be certified; do not spend
  // twenty minutes on it, but still report every other failure in this round.
  const building = quick.some(result => result.status === 'failed')
    ? null
    : startBuild(buildOptions).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  const full = await runFull();
  const built = building && await building;
  try {
    finish([...quick, ...full]);
  } catch (error) {
    if (built?.ok) announce({ installerVoided: true, reason: 'verification failed; this installer must not be installed' });
    throw error;
  }
  if (!built.ok) throw built.error;
  return record(built.value);
}
// A release-profile build of the whole application and the test builds of the
// checks each need several gigabytes at their peak. Sharing the machine is only
// safe with room for both, so the default depends on the memory free right now.
export const RELEASE_PARALLEL_MIN_FREE_BYTES = 12 * 1024 ** 3;
export function releaseParallelism(base = process.env, freeBytes = os.freemem()) {
  const forced = base.CCGUI_RELEASE_PARALLEL;
  if (forced !== undefined && forced !== '0' && forced !== '1') throw new Error('CCGUI_RELEASE_PARALLEL must be 0 or 1');
  if (forced !== undefined) return { parallel: forced === '1', reason: 'CCGUI_RELEASE_PARALLEL' };
  const enough = freeBytes >= RELEASE_PARALLEL_MIN_FREE_BYTES;
  return { parallel: enough, reason: enough ? 'enough free memory' : `less than ${RELEASE_PARALLEL_MIN_FREE_BYTES / 1024 ** 3} GiB of memory is free` };
}
async function release({ fresh = false } = {}) {
  const head = cleanHead();
  const artifacts = paths();
  const filename = path.join(artifacts, 'custom-check.log');
  const log = fs.createWriteStream(filename);
  try {
    const { parallel, reason } = releaseParallelism();
    const total = Number(nativeEnvironment().CARGO_BUILD_JOBS);
    const session = verificationSession(production, head, fresh);
    const stages = checkStages();
    const jobs = releaseJobs(total, { parallel, session, stages });
    console.log(JSON.stringify({ release: parallel ? 'parallel' : 'sequential', reason, buildJobs: jobs.build, checkJobs: jobs.check, freeMemoryGiB: Math.round(os.freemem() / 1024 ** 2 / 1024 * 10) / 10 }));
    // Only a parallel run needs a separate target directory; alone, checks keep the usual one.
    const checkEnv = parallel ? { ...nativeEnvironment(process.env, jobs.check, path.join(artifacts, 'check-target')), ...LEAN_TEST_BUILD } : nativeEnvironment(process.env, jobs.check);
    await orchestrateRelease({
      parallel,
      runQuick: () => runPhase(session, stages.filter(stage => stage.phase === 'quick'), checkEnv, log),
      runFull: () => runPhase(session, stages.filter(stage => stage.phase !== 'quick'), checkEnv, log),
      startBuild: options => buildArtifacts(jobs.build, options),
      finish: results => finishVerification(production, head, results, filename),
      record: built => {
        const report = recordBuild(production, built.version, built.startedAt);
        console.log(JSON.stringify({ built: true, version: built.version, commit: head, report: report.reportPath, log: built.logPath }));
      },
    });
  } finally { log.end(); }
}
function integrate(context, ref) {
  const { root } = context;
  safeRef(ref);
  if (git(['status', '--porcelain=v1'], root)) throw new Error('Commit local work first; the current checkout will not be changed');
  const manifest = JSON.parse(fs.readFileSync(checkedPath(root, '.custom/manifest.json'), 'utf8'));
  if (manifest.upstreamRemote !== context.upstream || git(['remote', 'get-url', 'upstream'], root) !== context.upstream) throw new Error('The upstream remote differs from the reviewed source');
  if (path.resolve(git(['remote', 'get-url', 'origin'], root)) !== path.resolve(context.backup)) throw new Error('The backup remote differs from the reviewed local repository');
  if (!Number.isSafeInteger(manifest.patchRevision) || manifest.patchRevision < 0) throw new Error('The patch revision is invalid');
  git(['fetch', '--quiet', '--no-recurse-submodules', 'upstream', '--tags'], root);
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], root);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (ancestor.status !== 0 && ancestor.status !== 1) throw new Error('Could not determine upstream ancestry');
  if (commit === manifest.upstreamReleaseCommit || ancestor.status === 0) return { status: 'already_integrated', upstream: commit };
  const label = `upstream-${ref.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60)}-${randomUUID()}`;
  const branch = `custom/integrate-${label}`;
  const parent = checkedPath(path.dirname(root), 'ccgui-integrations');
  const directory = checkedPath(parent, label);
  if (fs.existsSync(directory) || git(['branch', '--list', branch], root)) throw new Error('This integration already exists; inspect it instead of replacing it');
  fs.mkdirSync(parent, { recursive: true });
  git(['worktree', 'add', '--quiet', '-b', branch, directory, 'HEAD'], root);
  const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', commit], { cwd: directory, encoding: 'utf8', windowsHide: true });
  if (merge.status !== 0) {
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], directory).split('\n').filter(Boolean);
    return { status: conflicts.length ? 'conflicts' : 'merge_failed', directory, branch, conflicts };
  }
  manifest.upstreamRelease = ref;
  manifest.upstreamReleaseCommit = commit;
  manifest.patchRevision++;
  fs.writeFileSync(checkedPath(directory, '.custom/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(checkedPath(directory, 'src/version/distribution.ts'), `/** Maintained custom distribution. */\nexport const IS_CUSTOM_DISTRIBUTION = true;\nexport const CUSTOM_UPSTREAM_RELEASE = ${JSON.stringify(ref)};\n`);
  git(['add', '--', '.custom/manifest.json', 'src/version/distribution.ts'], directory);
  git(['commit', '--quiet', '-m', `chore(custom): record upstream integration ${ref}`], directory);
  git(['push', '--quiet', '--set-upstream', 'origin', branch], directory);
  return { status: 'merged_candidate', directory, branch, upstream: commit, next: ['pnpm install --frozen-lockfile', 'pnpm maint:check', 'pnpm maint:build'] };
}
function sha256(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
const RESOURCE_MAPPINGS = { 'resources/agent-catalogs': 'agent-catalogs', 'resources/skills': 'skills' };
function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) throw new Error('Maintenance inputs and destinations must be regular files');
  return stat;
}
function writableFile(filename) {
  const stat = regularFile(filename);
  if (stat.nlink !== 1) throw new Error('Install destinations must not have hard links');
  return stat;
}
function committedFile(root, relative) {
  const filename = checkedPath(root, relative);
  regularFile(filename);
  // hash-object applies the checkout's clean filters (including CRLF), so ignored,
  // untracked and skip-worktree changes cannot masquerade as verified resources.
  const expected = git(['rev-parse', '--verify', `HEAD:${relative}`], root);
  if (git(['hash-object', `--path=${relative}`, '--', filename], root) !== expected) throw new Error('Resource or configuration differs from committed HEAD');
  return filename;
}
function committedResources(root, resources) {
  const tracked = git(['ls-tree', '-r', '-z', 'HEAD', '--', ...Object.keys(RESOURCE_MAPPINGS).map(source => `src-tauri/${source}`)], root).split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Committed resources must be regular files');
    return { source: match[3], hash: match[2] };
  }).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  const actual = [...resources].sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
  if (JSON.stringify(tracked.map(item => item.source)) !== JSON.stringify(actual.map(item => item.source))) throw new Error('Resource files do not match committed HEAD');
  const hashes = spawnSync('git', ['hash-object', '--stdin-paths'], { cwd: root, input: actual.map(item => JSON.stringify(item.source)).join('\n') + '\n', encoding: 'utf8', windowsHide: true, env: proxyEnvironment() });
  if (hashes.status !== 0 || JSON.stringify(hashes.stdout.trim().split(/\r?\n/)) !== JSON.stringify(tracked.map(item => item.hash))) throw new Error('Resource bytes differ from committed HEAD');
}
function resourceManifest(root) {
  const config = JSON.parse(fs.readFileSync(committedFile(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const custom = JSON.parse(fs.readFileSync(committedFile(root, '.custom/tauri.json'), 'utf8'));
  // Fail closed if packaging gains a different mapping. Installation must never
  // silently omit a new mapping or interpret a glob differently from Tauri.
  const mappings = config.bundle?.resources;
  if (!mappings || Array.isArray(mappings) || JSON.stringify(Object.entries(mappings).sort()) !== JSON.stringify(Object.entries(RESOURCE_MAPPINGS).sort())) throw new Error('Unsupported Tauri resource mapping');
  const overlays = [custom];
  const windowsConfig = checkedPath(root, 'src-tauri/tauri.windows.conf.json');
  if (fs.existsSync(windowsConfig)) overlays.push(JSON.parse(fs.readFileSync(committedFile(root, 'src-tauri/tauri.windows.conf.json'), 'utf8')));
  if (overlays.some(overlay => overlay.bundle && Object.hasOwn(overlay.bundle, 'resources'))) throw new Error('Tauri resource mapping overrides require maintenance support');
  const resources = [];
  const seen = new Set();
  function walk(source, target) {
    const filename = checkedPath(root, source);
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) {
        if (!name || /[\\/:<>"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Unsafe resource path');
        walk(`${source}/${name}`, `${target}/${name}`);
      }
      return;
    }
    regularFile(filename);
    if (seen.has(target.toLowerCase())) throw new Error('Duplicate resource destination');
    seen.add(target.toLowerCase());
    resources.push({ source, path: target, size: stat.size, sha256: sha256(filename) });
  }
  for (const [source, target] of Object.entries(RESOURCE_MAPPINGS)) {
    const directory = checkedPath(root, `src-tauri/${source}`);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Resource mapping must name a directory');
    const before = resources.length;
    walk(`src-tauri/${source}`, target);
    if (before === resources.length) throw new Error('Resource mapping must not be empty');
  }
  committedResources(root, resources);
  return resources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function sameResources(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Resource manifest does not match verified bytes; run maint:check and maint:build again');
}
function verifyFile(filename, expected) {
  const stat = regularFile(filename);
  if (stat.size !== expected.size || sha256(filename) !== expected.sha256) throw new Error('Installed file checksum mismatch');
}
function assertNoLocalBuildPaths(filename, context) {
  const home = context.userProfile || os.homedir();
  const roots = [context.root, home, process.env.CARGO_HOME || path.join(home, '.cargo')];
  const normalize = value => value.toLowerCase().replace(/\\+/g, '/');
  const bytes = fs.readFileSync(filename);
  const contents = [normalize(bytes.toString('utf8')), normalize(bytes.toString('utf16le')), normalize(bytes.subarray(1).toString('utf16le'))];
  for (const root of roots) {
    if (!root || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) continue;
    if (contents.some(text => text.includes(normalize(root)))) {
      // Never include the detected private path in CLI diagnostics.
      throw new Error('The executable contains a local build path. Remove compiled source paths or remap compiler paths before distributing it.');
    }
  }
}
function recordVerification(context, checkedHead, checks, stages = []) {
  const { root } = context;
  if (git(['rev-parse', 'HEAD'], root) !== checkedHead || git(['status', '--porcelain=v1'], root)) {
    throw new Error('Source changed during verification; verify the final committed revision again');
  }
  const resources = resourceManifest(root);
  const report = { reportVersion: 2, head: checkedHead, clean: true, resources, checkedAt: new Date().toISOString(), checks, stages: stages.map(({ id, status, head }) => ({ id, status, ...(status === 'reused' ? { head } : {}) })) };
  fs.writeFileSync(path.join(paths(root), 'custom-verification.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
function verifiedHead(root) {
  const reportPath = checkedPath(root, 'artifacts/custom-verification.json');
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      throw new Error('No valid verification report. Run pnpm maint:check, then pnpm maint:build.');
    }
    throw error;
  }
  const head = git(['rev-parse', 'HEAD'], root);
  if (report?.clean !== true || report.head !== head || git(['status', '--porcelain=v1'], root)) throw new Error('Commit the source and run maint:check for this exact revision');
  if (report.reportVersion !== 2) throw new Error('Old verification report; run maint:check and maint:build again');
  sameResources(resourceManifest(root), report.resources);
  return head;
}
function recordBuild(context, version, startedAt) {
  const { root } = context;
  const head = verifiedHead(root);
  const exe = checkedPath(root, 'src-tauri/target/release/ccgui-next.exe');
  const bundle = checkedPath(root, 'src-tauri/target/release/bundle/nsis');
  if (!Number.isFinite(startedAt) || regularFile(exe).mtimeMs < startedAt - 1000) throw new Error('The executable is stale');
  const installers = fs.readdirSync(bundle).filter(name => name.endsWith('.exe')).map(name => checkedPath(bundle, name)).filter(filename => fs.statSync(filename).mtimeMs >= startedAt - 1000);
  if (installers.length !== 1) throw new Error('Expected exactly one fresh NSIS installer');
  assertNoLocalBuildPaths(exe, context);
  regularFile(installers[0]);
  const report = { reportVersion: 2, head, version, exe, sha256: sha256(exe), resources: resourceManifest(root), installer: installers[0], builtAt: new Date().toISOString() };
  const reportPath = path.join(paths(root), 'custom-build.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { ...report, reportPath };
}
const PROCESS_QUERY = `$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter "Name='ccgui-next.exe'").Count`;
const SHORTCUT_LAUNCH = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:CCGUI_PROTECTED_SHORTCUT -WindowStyle Hidden";
function powershell(script, env = process.env) {
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Windows maintenance operation failed');
  return result.stdout.trim();
}
function assertInstalledLauncherIsNewer(context, destination) {
  const runtime = checkedPath(context.userProfile, '.ccgui-next/runtime-updates');
  const statePath = checkedPath(runtime, 'state.json');
  let stateStat;
  try {
    stateStat = fs.lstatSync(statePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stateStat.isFile() || stateStat.size > 65536n) throw new Error('Invalid runtime update state');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state || Array.isArray(state) || state.stateVersion !== 1 || Object.keys(state).some(key => !['stateVersion', 'active', 'transaction'].includes(key))) throw new Error('Invalid runtime update state');
  // Only interpret the state needed for safe installation. Native startup still
  // validates the complete update contract and release contents.
  const transaction = state.transaction;
  if (transaction != null) {
    if (typeof transaction !== 'object' || Array.isArray(transaction) || !['Preparing', 'Ready', 'Activating', 'Committed', 'RolledBack', 'Failed'].includes(transaction.phase)) throw new Error('Invalid runtime update transaction');
    if (['Preparing', 'Ready', 'Activating'].includes(transaction.phase) || (transaction.phase === 'Failed' && transaction.failureReason === 'CandidateIdentityUnknown')) throw new Error('Recover the existing runtime update before installing');
  }
  if (state.active == null) return;
  const active = state.active;
  if (typeof active !== 'object' || Array.isArray(active) || typeof active.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(active.manifestSha256) || active.executable !== 'ccgui-next.exe') throw new Error('Invalid active runtime release path');
  const releases = checkedPath(runtime, 'releases');
  const release = checkedPath(releases, active.manifestSha256);
  const executable = checkedPath(release, active.executable);
  const activeStat = fs.statSync(executable, { bigint: true });
  if (!activeStat.isFile()) throw new Error('Invalid active runtime executable');
  const installedStat = fs.statSync(destination, { bigint: true });
  // Compare the actual filesystem precision, not rounded JavaScript milliseconds.
  if (installedStat.mtimeNs <= stateStat.mtimeNs || installedStat.mtimeNs <= activeStat.mtimeNs) throw new Error('Installed executable timestamp must be newer than runtime update state and active release; check the system clock before retrying');
}
function install(context) {
  const { root, userProfile } = context;
  if (!context.fixture && process.platform !== 'win32') throw new Error('Installation requires Windows');
  if (!userProfile || !path.isAbsolute(userProfile)) throw new Error('An absolute USERPROFILE is required');
  const head = verifiedHead(root);
  const report = JSON.parse(fs.readFileSync(checkedPath(root, 'artifacts/custom-build.json'), 'utf8'));
  const exe = checkedPath(root, 'src-tauri/target/release/ccgui-next.exe');
  const pkg = JSON.parse(fs.readFileSync(checkedPath(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(checkedPath(root, '.custom/manifest.json'), 'utf8'));
  const bundle = checkedPath(root, 'src-tauri/target/release/bundle/nsis');
  const installer = typeof report.installer === 'string' ? checkedPath(bundle, report.installer) : '';
  if (report.reportVersion !== 2 || report.head !== head || report.exe !== exe || report.version !== `${pkg.version}+protected.${manifest.patchRevision}` || !Number.isFinite(Date.parse(report.builtAt)) || !installer.endsWith('.exe') || !regularFile(installer).isFile() || !/^[a-f0-9]{64}$/.test(report.sha256) || !regularFile(exe).isFile() || sha256(exe) !== report.sha256) throw new Error('The build report or executable does not match the verified revision');
  sameResources(resourceManifest(root), report.resources);
  const destination = checkedPath(userProfile, 'AppData/Local/Programs/CCGUI/ccgui-next.exe');
  const installDirectory = path.dirname(destination);
  const shortcut = checkedPath(userProfile, 'Desktop/CC GUI（代理保护）.lnk');
  const normalShortcut = checkedPath(userProfile, 'Desktop/CC GUI.lnk');
  regularFile(shortcut);
  writableFile(destination);
  if (fs.existsSync(normalShortcut)) regularFile(normalShortcut);
  const candidates = report.resources.map(resource => ({ ...resource, source: checkedPath(root, resource.source), destination: checkedPath(installDirectory, resource.path) }));
  candidates.push({ path: 'ccgui-next.exe', source: exe, destination, size: regularFile(exe).size, sha256: report.sha256 });
  for (const candidate of candidates) {
    verifyFile(candidate.source, candidate);
    if (fs.existsSync(candidate.destination)) writableFile(candidate.destination);
  }
  const running = context.running ?? (() => powershell(PROCESS_QUERY));
  const assertStopped = () => {
    const count = String(running()).trim();
    if (!/^\d+$/.test(count)) throw new Error('Could not verify running client processes');
    if (Number(count) !== 0) throw new Error('Close every ccgui-next.exe client before installing; no process will be stopped automatically');
  };
  assertStopped();
  const backupDirectory = checkedPath(paths(root), `custom-install-${randomUUID()}`);
  fs.mkdirSync(backupDirectory);
  const backup = checkedPath(backupDirectory, 'ccgui-next.exe');
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.destination)) continue;
    const stat = writableFile(candidate.destination);
    candidate.previous = { size: stat.size, sha256: sha256(candidate.destination), atime: stat.atime, mtime: stat.mtime };
    candidate.backup = checkedPath(backupDirectory, candidate.path);
    fs.mkdirSync(path.dirname(candidate.backup), { recursive: true });
    fs.copyFileSync(candidate.destination, candidate.backup, fs.constants.COPYFILE_EXCL);
    verifyFile(candidate.backup, candidate.previous);
  }
  let shortcutPrevious;
  const savedShortcut = checkedPath(backupDirectory, 'CC GUI.lnk');
  if (fs.existsSync(normalShortcut)) {
    const stat = regularFile(checkedPath(userProfile, 'Desktop/CC GUI.lnk'));
    shortcutPrevious = { size: stat.size, sha256: sha256(normalShortcut), atime: stat.atime, mtime: stat.mtime };
    // The checkout's backup directory can be on another volume than Desktop.
    fs.copyFileSync(normalShortcut, savedShortcut, fs.constants.COPYFILE_EXCL);
    verifyFile(savedShortcut, shortcutPrevious);
  }
  const changed = [];
  const createdDirectories = [];
  let shortcutRemovalAttempted = false;
  try {
    if (verifiedHead(root) !== head) throw new Error('Source changed before installation');
    sameResources(resourceManifest(root), report.resources);
    assertStopped();
    for (const candidate of candidates) {
      // Recheck boundaries immediately before writing; never follow a newly
      // introduced link or overwrite an unexpected concurrent destination.
      checkedPath(installDirectory, candidate.path);
      if (candidate.previous) { writableFile(candidate.destination); verifyFile(candidate.destination, candidate.previous); }
      else if (fs.existsSync(candidate.destination)) throw new Error('Install destination appeared after backup');
      const missing = [];
      let directory = path.dirname(candidate.destination);
      while (!fs.existsSync(directory)) { missing.push(directory); directory = path.dirname(directory); }
      for (const item of missing.reverse()) { fs.mkdirSync(item); createdDirectories.push(item); }
      changed.push(candidate); // A failed copy can already have truncated its target.
      (context.copy ?? fs.copyFileSync)(checkedPath(root, path.relative(root, candidate.source)), candidate.destination);
      verifyFile(candidate.destination, candidate);
    }
    for (const candidate of candidates) verifyFile(checkedPath(installDirectory, candidate.path), candidate);
    // Windows copyFile preserves the source mtime. Stamp only the installed copy
    // with real installation time; never invent a future time to defeat routing.
    const installedAt = new Date(Date.now());
    fs.utimesSync(destination, fs.statSync(destination).atime, installedAt);
    assertInstalledLauncherIsNewer(context, destination);
    if (shortcutPrevious) {
      verifyFile(checkedPath(userProfile, 'Desktop/CC GUI.lnk'), shortcutPrevious);
      verifyFile(checkedPath(backupDirectory, 'CC GUI.lnk'), shortcutPrevious);
      shortcutRemovalAttempted = true;
      fs.unlinkSync(normalShortcut);
    }
  } catch (error) {
    const failures = [];
    const failedItems = [];
    for (const candidate of changed.reverse()) {
      try {
        checkedPath(installDirectory, candidate.path);
        if (candidate.previous) {
          verifyFile(checkedPath(backupDirectory, candidate.path), candidate.previous);
          if (fs.existsSync(candidate.destination)) writableFile(candidate.destination);
          fs.copyFileSync(candidate.backup, candidate.destination);
          verifyFile(candidate.destination, candidate.previous);
          fs.utimesSync(candidate.destination, candidate.previous.atime, candidate.previous.mtime);
        } else if (fs.existsSync(candidate.destination)) {
          regularFile(candidate.destination);
          fs.unlinkSync(candidate.destination);
        }
      } catch (restoreError) { failures.push(restoreError); failedItems.push(candidate.path); }
    }
    for (const directory of createdDirectories.reverse()) {
      try { checkedPath(installDirectory, path.relative(installDirectory, directory)); fs.rmdirSync(directory); }
      catch (restoreError) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(restoreError.code)) { failures.push(restoreError); failedItems.push(path.relative(installDirectory, directory)); }
      }
    }
    if (shortcutRemovalAttempted) {
      try {
        checkedPath(userProfile, 'Desktop/CC GUI.lnk');
        if (!fs.existsSync(normalShortcut)) {
          verifyFile(checkedPath(backupDirectory, 'CC GUI.lnk'), shortcutPrevious);
          fs.copyFileSync(savedShortcut, normalShortcut, fs.constants.COPYFILE_EXCL);
          fs.utimesSync(normalShortcut, shortcutPrevious.atime, shortcutPrevious.mtime);
        }
        verifyFile(normalShortcut, shortcutPrevious);
      } catch (restoreError) { failures.push(restoreError); failedItems.push('Desktop/CC GUI.lnk'); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], `Install failed and restore failed; recover from ${backupDirectory}; failed items: ${failedItems.join(', ')}`);
    throw error;
  }
  (context.launch ?? (filename => powershell(SHORTCUT_LAUNCH, { ...process.env, CCGUI_PROTECTED_SHORTCUT: filename })))(shortcut);
  return { installed: true, head, installedSHA: report.sha256, backup, shortcut };
}
// Local fixtures are deliberately unavailable to the CLI and confined to the OS temp tree.
export function fixtureMaintenance(root, hooks = {}) {
  root = fs.realpathSync(root);
  inside(fs.realpathSync(os.tmpdir()), root);
  if (root === ROOT) throw new Error('Fixtures must not use the production checkout');
  const upstream = fs.realpathSync(git(['remote', 'get-url', 'upstream'], root));
  inside(fs.realpathSync(os.tmpdir()), upstream);
  const backup = fs.realpathSync(git(['remote', 'get-url', 'origin'], root));
  inside(fs.realpathSync(os.tmpdir()), backup);
  const context = { root, upstream, backup, fixture: true, userProfile: checkedPath(root, 'profile'), running: hooks.running ?? (() => 0), launch: hooks.launch ?? (() => {}), copy: hooks.copy };
  return { integrate: ref => integrate(context, ref), recordVerification: head => recordVerification(context, head, ['fixture']), finishVerification: (head, results) => finishVerification(context, head, results, 'fixture.log'), recordBuild: (version, startedAt) => recordBuild(context, version, startedAt), install: () => install(context) };
}
const COMMAND_ARGUMENTS = {
  status: {}, integrate: { positional: 1 }, check: { flags: ['--fresh'] }, build: {}, release: { flags: ['--fresh'] }, install: {},
  isolated: { positional: 1, flags: ['--fresh'], values: ['--paths'] },
};
export function parseCommand(args) {
  const [command, ...rest] = args;
  const spec = Object.hasOwn(COMMAND_ARGUMENTS, command) ? COMMAND_ARGUMENTS[command] : undefined;
  if (!spec) throw new Error('Use status, integrate <upstream-tag>, check, build, release, install or isolated <check|build|release>');
  const parsed = { command, positional: [], flags: new Set(), values: {} };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (spec.flags?.includes(arg) && !parsed.flags.has(arg)) parsed.flags.add(arg);
    else if (spec.values?.includes(arg) && !Object.hasOwn(parsed.values, arg) && rest[index + 1] && !rest[index + 1].startsWith('-')) parsed.values[arg] = rest[++index];
    else if (!arg.startsWith('-')) parsed.positional.push(arg);
    else throw new Error('Use only the documented command arguments');
  }
  if (parsed.positional.length !== (spec.positional ?? 0)) throw new Error('Use only the documented command arguments');
  return parsed;
}
export async function main(args = process.argv.slice(2)) {
  const { command, positional, flags, values } = parseCommand(args);
  const fresh = flags.has('--fresh');
  switch (command) {
    case 'status': console.log(JSON.stringify({ root: ROOT, branch: git(['branch', '--show-current']), head: git(['rev-parse', 'HEAD']), upstream: git(['remote', 'get-url', 'upstream']), backup: git(['remote', 'get-url', 'origin']), dirty: !!git(['status', '--porcelain=v1']) }, null, 2)); break;
    case 'integrate': { const result = integrate(production, positional[0]); console.log(JSON.stringify(result)); if (result.status === 'conflicts' || result.status === 'merge_failed') process.exitCode = 1; break; }
    case 'check': await check({ fresh }); break;
    case 'build': await build(); break;
    case 'release': await release({ fresh }); break;
    case 'install': console.log(JSON.stringify(install(production))); break;
    case 'isolated': process.exitCode = await runIsolated({ repoRoot: ROOT, command: positional[0], fresh, paths: values['--paths']?.split(',') ?? null }); break;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
