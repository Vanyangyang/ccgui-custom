import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageLocal, publishLocalDirectory } from './live-update-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
// Exclude only known generated/dependency locations while collecting source.
// An asset named public/dist/x.js or public/target/x.json is a real input.
// Artifact and resource inventories must include EVERY file, without filters.
function excludedSource(relative) {
  return relative === 'src-tauri/target'
    || /^packages\/[^/]+\/(?:node_modules|\.git)$/.test(relative)
    || /^(?:src-tauri\/)?\.cargo\/credentials(?:\.toml)?$/.test(relative);
}
// Production Rust include_str!/include_bytes! dependencies outside the ordinary
// native-source scope (resources otherwise belong to packaging). Keep this list
// explicit; the regression audit flags new includes that need classification.
export const NATIVE_EMBEDDED_INPUTS = [
  'src/i18n/native-startup.json',
  'src/features/interactive-answer/capability-instructions.txt',
  'packages/plugin-sdk/spec/permissions.json',
  'deploy/worker/src/index.js',
  'src-tauri/resources/engine-models/agy.json',
];
export const pathIdentity = (filename, platform = process.platform) => platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);

function plain(filename, missing = false) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink or junction paths are forbidden'); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
function canonicalBuildDirectory(filename) {
  // Check the supplied path before resolving it so junctions cannot bypass plain().
  // Windows aliases must reach rustc with the same spelling, including extern paths.
  plain(filename);
  return fs.realpathSync.native(path.resolve(filename));
}
function fresh(filename) {
  plain(filename, true);
  try { fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output already exists; immutable directories are never overwritten');
}
function within(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes its allowed root');
}
function tree(directory, prefix = '', exclude = () => false) {
  plain(directory);
  const result = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (exclude(relative)) continue;
    const filename = path.join(directory, name);
    plain(filename);
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) result.push(...tree(filename, relative, exclude));
    else if (stat.isFile()) result.push({ path: relative, bytes: stat.size, sha256: digest(fs.readFileSync(filename)) });
    else throw new Error('Non-regular build input');
  }
  return result;
}
export function inputInventory(root) {
  const directories = ['src', 'src-tauri', 'packages', 'scripts', 'public', '.custom', '.cargo', 'patches'];
  const names = fs.readdirSync(root).filter(name => /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|index\.html|.*\.(?:config\.[cm]?[jt]s|config\.json)|tsconfig.*\.json|rust-toolchain(?:\.toml)?|\.npmrc)$/.test(name));
  if (fs.readdirSync(root).some(name => /^\.env(?:\.|$)/.test(name))) throw new Error('Build rejected: repository-root .env or .env.* exists; Vite ambient env files are unsupported. No file contents were read. Use explicit VITE_* build environment variables.');
  const entries = [];
  for (const name of [...directories, ...names].sort()) {
    const filename = path.join(root, name);
    if (!fs.existsSync(filename)) { plain(filename, true); continue; }
    plain(filename);
    if (fs.statSync(filename).isDirectory()) entries.push(...tree(filename, name, excludedSource));
    else entries.push({ path: name, bytes: fs.statSync(filename).size, sha256: digest(fs.readFileSync(filename)) });
  }
  for (const relative of NATIVE_EMBEDDED_INPUTS) {
    if (entries.some(entry => entry.path === relative)) continue;
    const filename = path.join(root, relative);
    plain(filename, true);
    if (fs.existsSync(filename)) entries.push({ path: relative, bytes: fs.statSync(filename).size, sha256: digest(fs.readFileSync(filename)) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function batchSnapshot(filename, root) {
  plain(filename);
  if (fs.statSync(filename).size > 1024 * 1024) throw new Error('Invalid batch file');
  const value = json(filename);
  const batch = value.channel?.batch ?? value.batch ?? value;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(batch.id) || batch.phase !== 'Building' || !path.isAbsolute(batch.sourceRoot ?? '') || pathIdentity(canonicalBuildDirectory(batch.sourceRoot)) !== pathIdentity(root)
    || !Array.isArray(batch.changes) || !batch.changes.length || batch.changes.length > 128) throw new Error('A frozen Building batch for this source root is required');
  const seen = new Set();
  for (const change of batch.changes) {
    if (!uuid(change.id) || seen.has(change.id) || change.sourceRoot !== batch.sourceRoot || typeof change.revision !== 'string' || !change.revision || change.revision.length > 256 || /[\x00-\x1f\x7f]/.test(change.revision)) throw new Error('Invalid frozen batch change');
    seen.add(change.id);
  }
  return digest(JSON.stringify(value));
}
export function buildEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp|userprofile|home|localappdata|appdata|programfiles(?:\(x86\))?|programdata|number_of_processors|processor_architecture|cargo_home|rustup_home|rustup_toolchain|rustflags|cargo_encoded_rustflags|cc|cxx|ar|cflags|cxxflags|ldflags|include|lib|libpath|vctoolsinstalldir|vsinstalldir|windowssdkdir|windowssdkversion|perl|source_date_epoch|vite_[a-z0-9_]+|(?:http|https|all|no)_proxy|cargo_http_proxy)$/i.test(key)) env[key] = value;
  }
  // The native graph is large; bound simultaneous rustc processes while each
  // crate can still use the self-update profile's parallel codegen units.
  const jobs = base.CARGO_BUILD_JOBS ?? '2';
  if (!/^[1-9][0-9]*$/.test(jobs) || Number(jobs) > 64) throw new Error('CARGO_BUILD_JOBS must be an integer from 1 to 64');
  env.CARGO_BUILD_JOBS = jobs;
  return env;
}
function cargoConfiguration(root, env) {
  // Cargo discovers ancestor/user configuration even with a sanitized process
  // environment. Hash only these build config files, never credentials files.
  const directories = new Set();
  for (let directory = path.join(root, 'src-tauri'); ; directory = path.dirname(directory)) {
    directories.add(path.join(directory, '.cargo'));
    if (path.dirname(directory) === directory) break;
  }
  const home = env.CARGO_HOME ?? (env.USERPROFILE || env.HOME ? path.join(env.USERPROFILE ?? env.HOME, '.cargo') : undefined);
  if (home) directories.add(path.resolve(home));
  const result = [];
  for (const directory of [...directories].sort()) {
    for (const name of ['config', 'config.toml']) {
      const filename = path.join(directory, name);
      plain(filename, true);
      if (fs.existsSync(filename)) result.push({ pathHash: digest(filename), sha256: digest(fs.readFileSync(filename)) });
    }
  }
  return result;
}
function dependencyInstallation(root) {
  // Installed resolution metadata is an input in addition to the source lock.
  // Package-store bytes are trusted package-manager inputs; this is not an
  // integrity audit of the entire node_modules store on every cache lookup.
  return ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'].map(relative => {
    const filename = path.join(root, relative);
    plain(filename, true);
    return { path: relative, sha256: fs.existsSync(filename) ? digest(fs.readFileSync(filename)) : null };
  });
}
async function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const { logFile, capture = false, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', overflow = false;
    child.stdout.on('data', value => {
      if (logFile) fs.appendFileSync(logFile, value);
      if (capture) { stdout += value; if (stdout.length > 1024 * 1024) { stdout = ''; overflow = true; child.kill(); } }
    });
    child.stderr.on('data', value => { if (logFile) fs.appendFileSync(logFile, value); });
    child.on('error', reject);
    child.on('close', code => code === 0 && !overflow ? resolve(stdout.trim()) : reject(new Error(`Build command ${path.basename(command)} failed (${code}${overflow ? ', captured output limit exceeded' : ''}); see build log ${logFile ?? '(unavailable)'}`)));
  });
}
function validateProbe(probe, fingerprint) {
  if (probe.protocol !== 1 || probe.checkpointSchema !== 1 || !/^[a-f0-9]{64}$/.test(probe.schemaHash ?? '') || probe.capabilities?.launchProtection !== 1
    || probe.capabilities?.frontendAssets !== 1 || probe.capabilities?.frontendFingerprint !== fingerprint
    || probe.capabilities?.eventReplay !== true || probe.capabilities?.commandDeduplication !== true || probe.capabilities?.hostChat !== true) throw new Error('Candidate compatibility probe rejected');
}
function copyTree(source, destination) {
  const entries = tree(source);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, entry.path), target, fs.constants.COPYFILE_EXCL);
    if (digest(fs.readFileSync(target)) !== entry.sha256) throw new Error('Resource changed during copying');
  }
}
function syncTree(source, destination) {
  const entries = tree(source);
  fs.mkdirSync(destination, { recursive: true });
  const expectedPaths = new Set(entries.map(entry => entry.path));
  for (const existing of tree(destination)) {
    if (!expectedPaths.has(existing.path)) {
      fs.unlinkSync(path.join(destination, existing.path));
    }
  }
  for (const entry of entries) {
    const sourceFile = path.join(source, entry.path);
    const targetFile = path.join(destination, entry.path);
    if (fs.existsSync(targetFile)) {
      plain(targetFile);
      const stat = fs.statSync(targetFile);
      if (stat.isFile() && stat.size === entry.bytes && digest(fs.readFileSync(targetFile)) === entry.sha256) {
        continue;
      }
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    const sourceStat = fs.statSync(sourceFile);
    fs.copyFileSync(sourceFile, targetFile);
    fs.utimesSync(targetFile, sourceStat.atime, sourceStat.mtime);
    if (digest(fs.readFileSync(targetFile)) !== entry.sha256) throw new Error('Resource changed during copying');
  }
}
export function createSourceSnapshot(root, destination, expectedEntries = inputInventory(root)) {
  plain(destination, true);
  fs.mkdirSync(destination, { recursive: true });
  const expectedByPath = new Map(expectedEntries.map(entry => [entry.path, entry]));
  for (const existing of inputInventory(destination)) {
    if (!expectedByPath.has(existing.path)) {
      fs.unlinkSync(path.join(destination, existing.path));
    }
  }
  for (const entry of expectedEntries) {
    const sourceFile = path.join(root, entry.path);
    const targetFile = path.join(destination, entry.path);
    plain(sourceFile);
    if (fs.existsSync(targetFile)) {
      plain(targetFile);
      const targetStat = fs.statSync(targetFile);
      if (targetStat.isFile() && targetStat.size === entry.bytes && digest(fs.readFileSync(targetFile)) === entry.sha256) {
        continue;
      }
    }
    const sourceStat = fs.statSync(sourceFile);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
    fs.utimesSync(targetFile, sourceStat.atime, sourceStat.mtime);
    if (digest(fs.readFileSync(targetFile)) !== entry.sha256) {
      throw new Error('Build inputs changed while capturing source snapshot');
    }
  }
  const testFixtures = path.join(root, 'tests/fixtures');
  if (fs.existsSync(testFixtures)) {
    syncTree(testFixtures, path.join(destination, 'tests/fixtures'));
  }
  const actual = inputInventory(destination);
  if (JSON.stringify(actual) !== JSON.stringify(expectedEntries)) {
    throw new Error('Captured source snapshot differs from expected build inputs');
  }
  const rootNodeModules = path.join(root, 'node_modules');
  const linkedNodeModules = path.join(destination, 'node_modules');
  if (fs.existsSync(rootNodeModules) && !fs.existsSync(linkedNodeModules)) {
    fs.symlinkSync(rootNodeModules, linkedNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return actual;
}

/** Hooks are module-only test seams; the CLI accepts no executable or shell override. */
export async function buildSelfUpdate(options, hooks = {}) {
  const started = performance.now();
  const root = canonicalBuildDirectory(options.sourceRoot ?? ROOT);
  const directory = path.join(root, '.artifacts/self-update-cache');
  plain(directory, true);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'build.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Self-update build already locked; inspect the owner before removing a stale build.lock');
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const logs = path.join(directory, 'logs');
    plain(logs, true); fs.mkdirSync(logs, { recursive: true });
    const logFile = path.join(logs, `${randomUUID()}.log`);
    fs.writeFileSync(logFile, '', { flag: 'wx' });
    try { return await buildLocked({ ...options, sourceRoot: root }, { ...hooks, logFile, started }); }
    catch (error) { fs.appendFileSync(logFile, `\nBuild rejected: ${error.message}\n`); throw error; }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function buildLocked(options, hooks) {
  const root = options.sourceRoot;
  plain(root);
  if (options.mode !== 'working-tree') throw new Error('Explicit --mode working-tree is required');
  const profile = options.profile ?? 'self-update';
  if (!['self-update', 'release'].includes(profile)) throw new Error('Invalid build profile');
  if (!options.batchFile || !options.output || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(options.releaseId ?? '')) throw new Error('batch-file, fresh output and release-id are required');
  // The parent already has to exist. Resolve it too (e.g. Windows 8.3 aliases)
  // before checking containment against the canonical source root.
  const requestedOutput = path.resolve(options.output);
  const output = path.join(canonicalBuildDirectory(path.dirname(requestedOutput)), path.basename(requestedOutput));
  within(root, output);
  if (!['.artifacts', 'artifacts', '.tmp'].includes(path.relative(root, output).split(path.sep)[0])) throw new Error('Output must be under a repository artifact directory');
  fresh(output);
  fresh(`${output}.build-report.json`);
  plain(path.dirname(output));
  const batchFile = path.resolve(options.batchFile);
  const frozenBatch = batchSnapshot(batchFile, root);
  const manifest = json(path.join(root, '.custom/manifest.json'));
  if (!Number.isSafeInteger(manifest.patchRevision) || manifest.patchRevision < 0) throw new Error('Invalid custom patch revision');
  const version = `${json(path.join(root, 'package.json')).version}+protected.${manifest.patchRevision}`;
  const env = buildEnvironment(hooks.env ?? process.env);
  const run = hooks.run ?? execute;
  const timings = { typecheck: 0, frontend: 0, native: 0, probe: 0, verifyProbe: 0, package: 0, cacheValidation: 0 };
  const stage = async (name, callback) => {
    const start = performance.now(); fs.appendFileSync(hooks.logFile, `\n[${name}] ${new Date().toISOString()}\n`);
    try { return await callback(); } finally { timings[name] = Math.round(performance.now() - start); fs.appendFileSync(hooks.logFile, `[${name}] ${timings[name]}ms\n`); }
  };
  const command = (exe, args, commandEnv = env) => run(exe, args, { cwd: root, env: commandEnv, logFile: hooks.logFile, capture: args.includes('--version') || args.includes('-vV') || args.includes('--task-worker-probe') });
  const tools = hooks.toolVersions ?? {
    node: process.version,
    cargo: await command('cargo', ['--version']), rustc: await command('rustc', ['-vV']),
    tauri: json(path.join(root, 'node_modules/@tauri-apps/cli/package.json')).version,
    typescript: json(path.join(root, 'node_modules/typescript/package.json')).version,
    vite: json(path.join(root, 'node_modules/vite/package.json')).version,
  };
  const config = json(path.join(root, '.custom/tauri.json'));
  config.version = `${json(path.join(root, 'package.json')).version}+self-update`;
  // FrontendDist is an untagged URL-or-path enum. On Windows an absolute drive
  // path can become a file:// URL and bypass the verified runtime asset provider.
  // This path is relative to the project's src-tauri configuration directory.
  config.build = { ...config.build, beforeBuildCommand: '', frontendDist: '../scripts/self-update-shell' };
  const metadata = { format: 2, profile, config, tools, platform: process.platform, arch: process.arch, environmentHash: digest(JSON.stringify(Object.entries(env).sort())) };
  const externalInputs = () => ({ cargoConfiguration: cargoConfiguration(root, env), dependencyInstallation: dependencyInstallation(root) });
  const cacheRoot = path.join(root, '.artifacts/self-update-cache');
  plain(cacheRoot, true);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const snapshotSource = options.snapshotDir ? canonicalBuildDirectory(options.snapshotDir) : null;
  const effectiveSource = snapshotSource ?? root;
  const inputs = inputInventory(effectiveSource);
  let snapshotDir = snapshotSource;
  if (!snapshotDir && options.captureSnapshot) {
    // Deterministic snapshot path preserves CARGO_MANIFEST_DIR and unchanged file
    // mtimes across builds so Cargo/rustc incremental caches remain valid.
    snapshotDir = path.join(cacheRoot, 'source-snapshot');
    createSourceSnapshot(root, snapshotDir, inputs);
    snapshotDir = canonicalBuildDirectory(snapshotDir);
  }
  const checkSource = snapshotDir ?? effectiveSource;
  const compileCommand = (exe, args, commandEnv = env) => run(exe, args, { cwd: checkSource, env: commandEnv, logFile: hooks.logFile, capture: args.includes('--version') || args.includes('-vV') || args.includes('--task-worker-probe') });
  const fingerprint = () => digest(JSON.stringify({ ...metadata, ...externalInputs(), files: inputInventory(checkSource) }));
  const key = digest(JSON.stringify({ ...metadata, ...externalInputs(), files: inputs }));
  const frozenBatchFile = path.join(cacheRoot, `.batch-${randomUUID()}.json`);
  fs.copyFileSync(batchFile, frozenBatchFile, fs.constants.COPYFILE_EXCL);
  if (batchSnapshot(frozenBatchFile, root) !== frozenBatch) throw new Error('Frozen batch changed while capturing build snapshot');
  const nativeInputs = inputs.filter(file => (file.path.startsWith('src-tauri/') && !file.path.startsWith('src-tauri/resources/'))
    || NATIVE_EMBEDDED_INPUTS.includes(file.path) || file.path.startsWith('.cargo/') || file.path.startsWith('scripts/self-update-shell/') || file.path === 'scripts/self-update-build.mjs' || file.path.startsWith('rust-toolchain'));
  const nativeFingerprint = digest(JSON.stringify({ ...metadata, ...externalInputs(), files: nativeInputs }));
  // Exclude unit test files and non-shell maintenance scripts from frontend cache invalidation.
  const nonFrontendInput = relative => relative.startsWith('src-tauri/') || relative.startsWith('.cargo/')
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
    || (relative.startsWith('scripts/') && !relative.startsWith('scripts/self-update-shell/') && relative !== 'scripts/self-update-build.mjs');
  const frontendFingerprint = digest(JSON.stringify({ ...metadata, dependencyInstallation: dependencyInstallation(root), files: inputs.filter(file => !nonFrontendInput(file.path)) }));
  const unchanged = () => {
    if (fingerprint() !== key || batchSnapshot(frozenBatchFile, root) !== frozenBatch) throw new Error('Build inputs or frozen batch changed during build');
  };
  const pending = [];
  function verifyArtifact(directory, cacheKey) {
    const start = performance.now();
    try {
    plain(directory);
    plain(path.join(directory, 'record.json'));
    const record = json(path.join(directory, 'record.json'));
    if (record.key !== cacheKey || JSON.stringify(tree(path.join(directory, 'payload'))) !== JSON.stringify(record.files)) throw new Error('Cached artifact integrity check failed; retained without overwrite');
    } finally { timings.cacheValidation += performance.now() - start; }
  }
  async function cached(kind, cacheKey, build) {
    const destination = path.join(cacheRoot, `${kind}-${cacheKey}`);
    if (!options.force && fs.existsSync(destination)) {
      verifyArtifact(destination, cacheKey);
      return { directory: destination, hit: true };
    }
    const staging = path.join(cacheRoot, `.building-${kind}-${randomUUID()}`);
    fs.mkdirSync(staging);
    const payload = path.join(staging, 'payload');
    fs.mkdirSync(payload);
    await build(payload);
    unchanged();
    writeJson(path.join(staging, 'record.json'), { key: cacheKey, metadata, files: tree(payload), builtAt: new Date().toISOString(), timings });
    pending.push({ staging, destination: fs.existsSync(destination) ? `${destination}-${randomUUID()}` : destination });
    return { directory: staging, hit: false };
  }
  const tsBuildInfo = path.join(cacheRoot, 'tsc.tsbuildinfo');
  const [frontend, native] = await Promise.all([
    cached('frontend', frontendFingerprint, async payload => {
      // Typecheck and Vite production bundle read the same immutable inputs; run concurrently.
      await Promise.all([
        stage('typecheck', () => compileCommand(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--incremental', '--tsBuildInfoFile', tsBuildInfo, '--project', path.join(checkSource, 'tsconfig.json')])),
        stage('frontend', () => compileCommand(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', checkSource, '--outDir', payload])),
      ]);
      if (!fs.existsSync(path.join(payload, 'index.html'))) throw new Error('Frontend build did not produce index.html');
    }),
    cached('native', nativeFingerprint, async payload => {
      // Stable path/content prevents the CLI config itself invalidating Cargo on
      // every full-cache miss. The exclusive build lock below serializes writers.
      const configPath = path.join(cacheRoot, `tauri-${profile}.json`);
      plain(configPath, true);
      const bytes = `${JSON.stringify(config, null, 2)}\n`;
      if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== bytes) fs.writeFileSync(configPath, bytes);
      const targetDir = path.join(root, 'src-tauri/target');
      const nativeEnv = { ...env, CCGUI_FRONTEND_FINGERPRINT: nativeFingerprint, CARGO_TARGET_DIR: targetDir };
      await stage('native', () => compileCommand(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle', '--config', configPath, '--', '--profile', profile], nativeEnv));
      const executable = path.join(targetDir, profile, 'ccgui-next.exe');
      plain(executable);
      fs.copyFileSync(executable, path.join(payload, 'ccgui-next.exe'), fs.constants.COPYFILE_EXCL);
      validateProbe(JSON.parse(await stage('probe', () => command(path.join(payload, 'ccgui-next.exe'), ['--task-worker-probe']))), nativeFingerprint);
    }),
  ]);
  const executable = path.join(native.directory, 'payload/ccgui-next.exe');
  const probe = JSON.parse(await stage('verifyProbe', () => command(executable, ['--task-worker-probe'])));
  validateProbe(probe, nativeFingerprint);
  unchanged();
  verifyArtifact(native.directory, nativeFingerprint);
  verifyArtifact(frontend.directory, frontendFingerprint);
  const resources = path.join(cacheRoot, `.resources-${randomUUID()}`);
  fs.mkdirSync(resources);
  copyTree(path.join(checkSource, 'src-tauri/resources'), resources);
  const result = await stage('package', () => packageLocal({ mode: 'working-tree', exe: executable, resources, frontend: path.join(frontend.directory, 'payload'), frontendFingerprint: nativeFingerprint, output, releaseId: options.releaseId, version, schemaHash: probe.schemaHash, batchFile: frozenBatchFile }));
  unchanged();
  verifyArtifact(native.directory, nativeFingerprint);
  verifyArtifact(frontend.directory, frontendFingerprint);
  // Nothing is reusable until the whole candidate and frozen-batch package pass.
  for (const item of pending) publishLocalDirectory(item.staging, item.destination);
  timings.cacheValidation = Math.round(timings.cacheValidation);
  const report = { packageRoot: output, version, profile, cacheHit: native.hit && frontend.hit, nativeCacheHit: native.hit, frontendCacheHit: frontend.hit, inputFingerprint: key, nativeFingerprint, frontendFingerprint, exeSha256: digest(fs.readFileSync(path.join(output, 'ccgui-next.exe'))), logFile: hooks.logFile, totalMs: Math.round(performance.now() - hooks.started), timings, package: result, ...(snapshotDir ? { snapshotDir } : {}) };
  writeJson(path.join(path.dirname(output), `${path.basename(output)}.build-report.json`), report);
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  const flags = { '--mode': 'mode', '--batch-file': 'batchFile', '--output': 'output', '--release-id': 'releaseId', '--profile': 'profile', '--snapshot-dir': 'snapshotDir' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--force' && !options.force) { options.force = true; continue; }
    if (args[index] === '--capture-snapshot' && !options.captureSnapshot) { options.captureSnapshot = true; continue; }
    const key = flags[args[index]];
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
    options[key] = args[++index];
  }
  console.log(JSON.stringify(await buildSelfUpdate(options), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
