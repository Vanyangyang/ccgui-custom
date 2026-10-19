/** Hidden Windows WebView fixture for external frontend launches (not handoff/rollback).
 * node scripts/test-self-update-frontend.mjs --exe <trusted-debug.exe> --frontend <dist> --artifacts <repo-owned-directory>
 * Build the executable separately with test-harness, custom-protocol and CCGUI_FRONTEND_FINGERPRINT.
 * No build, model request, real profile access, or update-state fabrication occurs here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageLocal } from './live-update-package.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function check(value, message) { if (!value) throw new Error(message); }
export function parseArgs(argv) {
  const result = {};
  const keys = new Map([['--exe', 'exe'], ['--frontend', 'frontend'], ['--artifacts', 'artifacts']]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' && argv.length === 1) return { help: true };
    const key = keys.get(argv[i]);
    check(key && !Object.hasOwn(result, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown, duplicate or missing argument');
    result[key] = argv[++i];
  }
  check(result.exe && result.frontend && result.artifacts, '--exe, --frontend and --artifacts are required');
  return result;
}
export function assertInside(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Path must be strictly within the repository fixture root');
  return filename;
}
function ordinary(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'Fixture input must be an ordinary file/directory');
}
function noLinkedAncestors(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) check(!fs.lstatSync(current).isSymbolicLink(), 'Linked path ancestors are forbidden');
    if (path.dirname(current) === current) break;
  }
}
function jsonFile(filename) {
  if (!fs.existsSync(filename)) return null;
  ordinary(filename);
  check(fs.statSync(filename).size < 8 * 1024 * 1024, 'Fixture JSON exceeds size bound');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function environment(root, profile) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  check(systemRoot && path.isAbsolute(systemRoot), 'Windows SystemRoot is required');
  const system32 = path.join(systemRoot, 'System32');
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(system32, 'cmd.exe'),
    PATH: [path.join(root, 'bin'), system32, path.join(system32, 'WindowsPowerShell/v1.0')].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1', HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(profile, 'engine-home/.claude'), CODEX_HOME: path.join(profile, 'engine-home/.codex'),
    PI_CODING_AGENT_DIR: path.join(profile, 'engine-home/.pi'), OMP_CODING_AGENT_DIR: path.join(profile, 'engine-home/.omp'),
    KIMI_CODE_HOME: path.join(profile, 'engine-home/.kimi-code'), GROK_HOME: path.join(profile, 'engine-home/.grok'),
    CCGUI_RUNTIME_FIXTURE: '1', CCGUI_RUNTIME_FIXTURE_COMMANDS: '1',
  };
  for (const key of ['SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
function start(exe, args, env, root, label) {
  const stdout = fs.openSync(path.join(root, `${label}.stdout.log`), 'wx');
  const stderr = fs.openSync(path.join(root, `${label}.stderr.log`), 'wx');
  let child;
  try { child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', stdout, stderr] }); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  const state = { child, done: false, code: null, signal: null, error: null };
  state.closed = new Promise(resolve => {
    child.once('error', error => { state.error = error.message; });
    child.once('close', (code, signal) => { Object.assign(state, { done: true, code, signal }); resolve(); });
  });
  return state;
}
async function waitFor(inspect, label, timeout = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await inspect();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
async function evaluate(directory, state, expression, timeout = 15_000) {
  const id = randomUUID();
  const temporary = path.join(directory, 'inbox', `${id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ id, expression }), { flag: 'wx' });
  fs.renameSync(temporary, path.join(directory, 'inbox', `${id}.json`));
  return waitFor(() => {
    check(!state.done, 'Fixture host exited during evaluation');
    const filename = path.join(directory, 'outbox', `${id}.json`);
    const result = jsonFile(filename);
    if (!result) return null;
    fs.unlinkSync(filename);
    check(!result.error, `Fixture evaluation failed: ${result.error}`);
    return { value: result.value };
  }, 'WebView evaluation', timeout).then(result => result.value);
}

export async function runSmoke(options) {
  check(process.platform === 'win32', 'This fixture requires Windows WebView2');
  const exe = path.resolve(options.exe), frontend = path.resolve(options.frontend);
  noLinkedAncestors(exe); noLinkedAncestors(frontend);
  ordinary(exe); ordinary(frontend, true);
  const artifacts = assertInside(PROJECT, path.resolve(options.artifacts));
  noLinkedAncestors(artifacts);
  fs.mkdirSync(artifacts, { recursive: true });
  assertInside(fs.realpathSync.native(PROJECT), fs.realpathSync.native(artifacts));
  const root = fs.mkdtempSync(path.join(artifacts, 'frontend-smoke-'));
  const profile = path.join(root, 'profile');
  const env = environment(root, profile);
  for (const directory of [profile, env.APPDATA, env.LOCALAPPDATA, env.TEMP, path.join(root, 'bin')]) fs.mkdirSync(directory, { recursive: true });
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), fixtureRoot: root,
    scope: 'Hidden fixture WebView external assets and fail-closed launch only; not production candidate, real-user upgrade, handoff or rollback.',
    inputs: { exe, frontend }, results: [], cleanup: { complete: false } };
  const reportPath = path.join(root, 'report.json');
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const children = new Set();
  let interrupted = false;
  const interrupt = () => { interrupted = true; for (const state of children) if (!state.done) state.child.kill(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const launch = (executable, args, label) => { check(!interrupted, 'Fixture interrupted'); const state = start(executable, args, env, root, label); children.add(state); return state; };
  const stop = async state => {
    if (!state.done) state.child.kill(); // Exact ChildProcess handle; never process-name or broad tree termination.
    await waitFor(() => state.done, 'owned child exit', 15_000);
  };
  // Read-only inventory: WebView normally exits with its owning host. Never kill a discovered PID.
  const waitWebViews = async () => {
    const ps = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const quoted = root.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${quoted}',[StringComparison]::OrdinalIgnoreCase) -ge 0 }); [Console]::Out.Write($items.Count)`;
    let attempt = 0;
    await waitFor(async () => {
      const label = `webview-inventory-${attempt++}-${randomUUID()}`;
      const state = launch(ps, ['-NoProfile', '-NonInteractive', '-Command', script], label);
      try { await waitFor(() => state.done, 'read-only WebView inventory', 15_000); }
      finally { await stop(state); }
      check(state.code === 0, 'Could not verify fixture WebView cleanup');
      return fs.readFileSync(path.join(root, `${label}.stdout.log`), 'utf8').trim() === '0';
    }, 'fixture WebViews to exit', 30_000);
  };
  save();
  try {
    const probeChild = launch(exe, ['--task-worker-probe', '--dev-profile', profile], 'probe');
    await waitFor(() => probeChild.done, 'worker capability probe', 30_000);
    check(probeChild.code === 0, 'Trusted executable probe failed');
    const probe = JSON.parse(fs.readFileSync(path.join(root, 'probe.stdout.log'), 'utf8').trim());
    check(probe.protocol === 1 && validHash(probe.schemaHash) && probe.capabilities?.frontendAssets === 1 && validHash(probe.capabilities.frontendFingerprint), 'Executable lacks compatible external frontend fingerprint capability');
    report.probe = probe;
    const copy = path.join(root, 'frontend-b');
    // Validate and package A before copying: packageLocal rejects linked frontend trees.
    const common = { exe, frontend, schemaHash: probe.schemaHash, frontendFingerprint: probe.capabilities.frontendFingerprint, mode: 'working-tree' };
    const stage = (name, overrides = {}) => {
      const packaged = packageLocal({ ...common, releaseId: `frontend-smoke-${name}`, version: `1.1.1+frontend-smoke.${name}`, output: path.join(root, `package-${name}`), ...overrides });
      const destination = path.join(profile, 'runtime-updates/releases', packaged.manifestSha256);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(packaged.output, destination);
      return { name, directory: destination, exe: path.join(destination, 'ccgui-next.exe'), manifestSha256: packaged.manifestSha256, version: `1.1.1+frontend-smoke.${name}` };
    };
    const a = stage('a');
    fs.cpSync(frontend, copy, { recursive: true, errorOnExist: true, force: false });
    const index = path.join(copy, 'index.html');
    const html = fs.readFileSync(index, 'utf8');
    check(/<head\b[^>]*>/i.test(html), 'Frontend index has no head');
    fs.writeFileSync(index, html.replace(/<head\b[^>]*>/i, '$&\n<meta name="ccgui-frontend-smoke" content="b">'));
    const b = stage('b', { frontend: copy });
    check(hash(fs.readFileSync(a.exe)) === hash(fs.readFileSync(b.exe)), 'A/B executable hashes differ');
    report.executableSha256 = hash(fs.readFileSync(a.exe));
    const successful = async release => {
      const state = launch(release.exe, ['--dev-profile', profile], release.name);
      try {
        const bridge = path.join(profile, 'runtime-fixture-bridge', String(state.child.pid));
        await waitFor(() => { check(!state.done, 'Host exited before bridge ready'); const ready = jsonFile(path.join(bridge, 'ready.json')); return ready?.pid === state.child.pid && ready.bridgeVersion === 1; }, 'fixture bridge');
        const result = await waitFor(async () => {
          let value;
          try {
            value = await evaluate(bridge, state, `(async()=>({mounted:document.documentElement.dataset.appMounted==='1',rootChildren:document.getElementById('root')?.children.length??0,bootFailure:!!document.querySelector('.boot-failure'),crashReport:!!localStorage.getItem('ccgui:last-crash'),url:location.href,version:await window.__TAURI_INTERNALS__.invoke('plugin:app|version'),marker:document.querySelector('meta[name="ccgui-frontend-smoke"]')?.content??null,styles:[...document.styleSheets].filter(s=>s.href&&s.cssRules.length>0).length,scripts:performance.getEntriesByType('resource').filter(e=>/\\.js(?:$|[?#])/.test(e.name)).length}))()`, 3_000);
          } catch (error) {
            // Native bridge creation precedes WebView navigation. An eval sent
            // before initialization can disappear with the initial document.
            // Retry this read-only observation inside the existing boot deadline;
            // explicit page errors and host exits remain immediate failures.
            if (error.message === 'Timed out: WebView evaluation' && !state.done) return null;
            throw error;
          }
          check(!value.bootFailure && !value.crashReport, 'WebView reported a boot or React crash');
          return value.mounted && value.rootChildren > 0 ? value : null;
        }, 'React mount');
        const url = new URL(result.url);
        check((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'tauri.localhost' && !url.port, 'WebView did not use packaged application origin');
        check(result.version === release.version && result.styles > 0 && result.scripts > 0, 'Manifest version or frontend JS/CSS load mismatch');
        check(result.marker === (release.name === 'b' ? 'b' : null), 'External frontend identity mismatch');
        report.results.push({ scenario: release.name, passed: true, manifestSha256: release.manifestSha256, ...result }); save();
      } finally { await stop(state); await waitWebViews(); }
    };
    await successful(a); await successful(b);
    const rejected = async (release, label) => {
      const state = launch(release.exe, ['--dev-profile', profile], label);
      try {
        await waitFor(() => state.done, 'invalid frontend rejection', 30_000);
        check(!state.error && Number.isInteger(state.code) && state.code !== 0, 'Invalid frontend must exit nonzero itself');
        check(!fs.existsSync(path.join(profile, 'runtime-fixture-bridge', String(state.child.pid), 'ready.json')), 'Invalid frontend created a ready bridge');
        report.results.push({ scenario: label, passed: true, exitCode: state.code }); save();
      } finally { await stop(state); await waitWebViews(); }
    };
    fs.appendFileSync(path.join(a.directory, 'frontend/index.html'), '\n<!-- tampered fixture -->');
    await rejected(a, 'tampered');
    const wrong = probe.capabilities.frontendFingerprint === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await rejected(stage('mismatch', { frontendFingerprint: wrong }), 'fingerprint-mismatch');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = String(error?.message ?? error); }
  finally {
    try { for (const state of children) await stop(state); await waitWebViews(); report.cleanup.complete = true; }
    catch (error) { report.cleanup.error = String(error.message); report.status = 'failed'; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ event: 'self-update-frontend-smoke', status: report.status, reportPath }));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/test-self-update-frontend.mjs --exe <trusted-debug.exe> --frontend <dist> --artifacts <repo-owned-directory>');
    else if ((await runSmoke(options)).status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(String(error.message)); process.exitCode = 1; }
}
