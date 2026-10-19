import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';

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
  const env = { ...base };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'CARGO_HTTP_PROXY']) env[key] = 'http://127.0.0.1:7897';
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  return env;
}
function nativeEnvironment() {
  const env = proxyEnvironment();
  delete env.CARGO_TARGET_DIR;
  return env;
}
async function run(label, exe, args, cwd, env, log) {
  console.log(JSON.stringify({ stage: label, started: true }));
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => log.write(data));
    child.stderr.on('data', data => log.write(data));
    child.on('error', reject);
    child.on('exit', code => {
      console.log(JSON.stringify({ stage: label, exit: code }));
      code === 0 ? resolve() : reject(new Error(`${label} failed; inspect the saved log`));
    });
  });
}
function checkedPath(root, value) {
  const result = inside(root, value);
  let current = result;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Maintenance paths must not use symbolic links or junctions');
    current = path.dirname(current);
  }
  return result;
}
function paths(root = ROOT) {
  const artifacts = checkedPath(root, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  return artifacts;
}
async function check() {
  const checkedHead = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain=v1'])) throw new Error('Commit local work before verification');
  const artifacts = paths();
  const filename = path.join(artifacts, 'custom-check.log');
  const log = fs.createWriteStream(filename);
  try {
    const env = nativeEnvironment();
    await run('maintenance safety', process.execPath, ['--test', 'scripts/custom-maintain.test.mjs'], ROOT, env, log);
    await run('privacy boundary', process.execPath, ['--experimental-strip-types', '--test', 'tests/privacy-boundary.test.ts'], ROOT, env, log);
    await run('types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], ROOT, env, log);
    // Bound cold lazy-UI transforms while native work runs in other checkouts.
    // Keep all tests and their existing deadlines; only reduce contention.
    await run('vitest', process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers', '2'], ROOT, env, log);
    await run('native Claude and quota', 'cargo', ['test', '--quiet', 'claude', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native auto title', 'cargo', ['test', '--quiet', 'auto_title', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native isolated title calls', 'cargo', ['test', '--quiet', 'engine::side_call::tests', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native single instance', 'cargo', ['test', '--quiet', 'single_instance::tests', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native startup modes', 'cargo', ['test', '--quiet', 'startup::tests', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native relay transport', 'cargo', ['test', '--quiet', 'relay', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native passive throughput', 'cargo', ['test', '--quiet', 'reader::terminal_event_tests::throughput_', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native task control', 'cargo', ['test', '--quiet', 'native_task_control', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native host chat', 'cargo', ['test', '--quiet', 'host_chat', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native Codex', 'cargo', ['test', '--quiet', 'engine::codex', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native assistant notices', 'cargo', ['test', '--quiet', 'assistant_notices', '--lib', '--', '--test-threads=1'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native plugin boundaries', 'cargo', ['test', '--quiet', 'plugin_caps', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native Leader', 'cargo', ['test', '--quiet', 'leader', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native history archive and deletion', 'cargo', ['test', '--quiet', 'history::reader::', '--lib'], path.join(ROOT, 'src-tauri'), env, log);
    await run('native isolated send path', 'cargo', ['test', '--quiet', '--features', 'test-harness', '--test', 'send_path'], path.join(ROOT, 'src-tauri'), env, log);
    git(['diff', '--check']);
    recordVerification(production, checkedHead, ['maintenance safety', 'privacy boundary', 'types', 'vitest', 'native quota', 'native auto title', 'native isolated title calls', 'native single instance', 'native startup modes', 'native relay transport', 'native passive throughput', 'native task control', 'native host chat', 'native Codex', 'native assistant notices', 'native plugin boundaries', 'native Leader', 'native history archive and deletion', 'native isolated send path', 'diff']);
    console.log(JSON.stringify({ passed: true, log: filename }));
  } finally { log.end(); }
}
async function build() {
  // Production only via tauri build (embeds frontendDist). Bare cargo build --release
  // leaves the WebView on build.devUrl (http://localhost:1420) and breaks without Vite.
  const artifacts = paths();
  const report = { head: verifiedHead(ROOT) };
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.custom/manifest.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.custom/tauri.json'), 'utf8'));
  config.version = `${pkg.version}+protected.${manifest.patchRevision}`;
  const configPath = path.join(artifacts, 'custom-tauri.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const logPath = path.join(artifacts, 'custom-build.log');
  const log = fs.createWriteStream(logPath);
  try {
    const startedAt = Date.now();
    await run('protected installer', process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis', '--config', configPath], ROOT, nativeEnvironment(), log);
    const built = recordBuild(production, config.version, startedAt);
    console.log(JSON.stringify({ built: true, version: config.version, commit: report.head, report: built.reportPath, log: logPath }));
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
  git(['-c', 'http.proxy=http://127.0.0.1:7897', 'fetch', '--quiet', '--no-recurse-submodules', 'upstream', '--tags'], root);
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
function recordVerification(context, checkedHead, checks) {
  const { root } = context;
  if (git(['rev-parse', 'HEAD'], root) !== checkedHead || git(['status', '--porcelain=v1'], root)) {
    throw new Error('Source changed during verification; verify the final committed revision again');
  }
  const report = { head: checkedHead, clean: true, checkedAt: new Date().toISOString(), checks };
  fs.writeFileSync(path.join(paths(root), 'custom-verification.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
function verifiedHead(root) {
  const report = JSON.parse(fs.readFileSync(checkedPath(root, 'artifacts/custom-verification.json'), 'utf8'));
  const head = git(['rev-parse', 'HEAD'], root);
  if (report.clean !== true || report.head !== head || git(['status', '--porcelain=v1'], root)) throw new Error('Commit the source and run maint:check for this exact revision');
  return head;
}
function recordBuild(context, version, startedAt) {
  const { root } = context;
  const head = verifiedHead(root);
  const exe = checkedPath(root, 'src-tauri/target/release/ccgui-next.exe');
  const bundle = checkedPath(root, 'src-tauri/target/release/bundle/nsis');
  if (!Number.isFinite(startedAt) || !fs.statSync(exe).isFile() || fs.statSync(exe).mtimeMs < startedAt - 1000) throw new Error('The executable is stale');
  const installers = fs.readdirSync(bundle).filter(name => name.endsWith('.exe')).map(name => checkedPath(bundle, name)).filter(filename => fs.statSync(filename).mtimeMs >= startedAt - 1000);
  if (installers.length !== 1) throw new Error('Expected exactly one fresh NSIS installer');
  const report = { head, version, exe, sha256: sha256(exe), installer: installers[0], builtAt: new Date().toISOString() };
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
  if (report.head !== head || report.exe !== exe || report.version !== `${pkg.version}+protected.${manifest.patchRevision}` || !Number.isFinite(Date.parse(report.builtAt)) || !installer.endsWith('.exe') || !fs.statSync(installer).isFile() || !/^[a-f0-9]{64}$/.test(report.sha256) || sha256(exe) !== report.sha256) throw new Error('The build report or executable does not match the verified revision');
  const destination = checkedPath(userProfile, 'AppData/Local/Programs/CCGUI/ccgui-next.exe');
  const shortcut = checkedPath(userProfile, 'Desktop/CC GUI（代理保护）.lnk');
  const normalShortcut = checkedPath(userProfile, 'Desktop/CC GUI.lnk');
  if (!fs.statSync(shortcut).isFile() || !fs.statSync(destination).isFile()) throw new Error('The installed executable and protected shortcut must already exist');
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
  fs.copyFileSync(destination, backup, fs.constants.COPYFILE_EXCL);
  const previousSHA = sha256(backup);
  assertStopped();
  try {
    (context.copy ?? fs.copyFileSync)(exe, destination);
    if (sha256(destination) !== report.sha256) throw new Error('Installed executable checksum mismatch');
  } catch (error) {
    fs.copyFileSync(backup, destination);
    if (sha256(destination) !== previousSHA) throw new Error(`Install failed and restore failed; recover from ${backup}`);
    throw error;
  }
  if (fs.existsSync(normalShortcut)) {
    const savedShortcut = checkedPath(backupDirectory, 'CC GUI.lnk');
    if (fs.existsSync(savedShortcut)) throw new Error('Shortcut backup already exists');
    fs.renameSync(normalShortcut, savedShortcut);
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
  return { integrate: ref => integrate(context, ref), recordVerification: head => recordVerification(context, head, ['fixture']), recordBuild: (version, startedAt) => recordBuild(context, version, startedAt), install: () => install(context) };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length !== (args[0] === 'integrate' ? 2 : 1)) throw new Error('Use only the documented command arguments');
  switch (args[0]) {
    case 'status': console.log(JSON.stringify({ root: ROOT, branch: git(['branch', '--show-current']), head: git(['rev-parse', 'HEAD']), upstream: git(['remote', 'get-url', 'upstream']), backup: git(['remote', 'get-url', 'origin']), dirty: !!git(['status', '--porcelain=v1']) }, null, 2)); break;
    case 'integrate': { const result = integrate(production, args[1]); console.log(JSON.stringify(result)); if (result.status === 'conflicts' || result.status === 'merge_failed') process.exitCode = 1; break; }
    case 'check': await check(); break;
    case 'build': await build(); break;
    case 'install': console.log(JSON.stringify(install(production))); break;
    default: throw new Error('Use status, integrate <upstream-tag>, check, build or install');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
