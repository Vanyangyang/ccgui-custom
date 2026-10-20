import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildEnvironment, buildSelfUpdate, createSourceSnapshot, inputInventory, main, pathIdentity, NATIVE_EMBEDDED_INPUTS } from './self-update-build.mjs';

test('build tools use the configured environment without a sibling project dependency', () => {
  const env = buildEnvironment({ Path: 'C:/tools/bin', PERL: 'C:/tools/perl.exe', SPELLCAST_STATE_FILE: 'private.sqlite' });
  assert.equal(env.Path, 'C:/tools/bin');
  assert.equal(env.PERL, 'C:/tools/perl.exe');
  assert.equal(env.SPELLCAST_STATE_FILE, undefined);
  assert.equal(buildEnvironment({}).PERL, undefined);
});

test('build proxy inheritance preserves absence, empty values and case without copying private configuration', () => {
  assert.deepEqual(buildEnvironment({}), { CARGO_BUILD_JOBS: '2' });
  const proxies = {
    HTTP_PROXY: 'http://fixture-user:fixture-password@proxy.example.invalid:8080',
    http_proxy: '', HTTPS_PROXY: '', https_proxy: 'http://secure.example.invalid:8081',
    ALL_PROXY: 'socks5://all.example.invalid:1080', all_proxy: '',
    NO_PROXY: '*.example.invalid', no_proxy: '', Http_Proxy: 'http://mixed.example.invalid:8082',
    CARGO_HTTP_PROXY: '', cargo_http_proxy: 'http://cargo.example.invalid:8083',
  };
  assert.deepEqual(buildEnvironment({ ...proxies, ANTHROPIC_AUTH_TOKEN: 'fixture-secret',
    CLAUDE_CONFIG_DIR: 'fixture-private-config', CCGUI_HOST_CHAT_TOKEN: 'fixture-host-secret',
    CUSTOM_AUTH: 'fixture-auth', CARGO_REGISTRIES_CRATES_IO_TOKEN: 'fixture-registry-secret',
  }), { ...proxies, CARGO_BUILD_JOBS: '2' });
});

test('build job limits retain their default and explicit bounds', () => {
  assert.equal(buildEnvironment({}).CARGO_BUILD_JOBS, '2');
  for (const jobs of ['1', '64']) assert.equal(buildEnvironment({ CARGO_BUILD_JOBS: jobs }).CARGO_BUILD_JOBS, jobs);
  for (const jobs of ['', '0', '65', '-1', '1.5', 'auto']) {
    assert.throws(() => buildEnvironment({ CARGO_BUILD_JOBS: jobs }), /integer from 1 to 64/);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, value) => { const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value)); return filename; };
  put('package.json', { version: '1.2.3' });
  put('.custom/manifest.json', { patchRevision: 9 });
  put('.custom/tauri.json', {});
  put('src/app.ts', 'hello');
  put('src-tauri/src/main.rs', 'native');
  put('src-tauri/resources/agent-catalogs/a.json', '{}');
  put('src-tauri/resources/skills/a.md', 'skill');
  put('src-tauri/resources/engine-models/a.json', '{}');
  put('pnpm-lock.yaml', 'lock');
  const batchFile = put('.tmp/batch.json', { id: randomUUID(), phase: 'Building', sourceRoot: root, changes: [{ id: randomUUID(), revision: 'dirty', sourceRoot: root }] });
  const calls = [];
  let nativeFingerprint;
  const hooks = { toolVersions: { fixture: '1' }, env: {}, run: async (command, args, options) => {
    calls.push([command, args]);
    if (args[0] === '--task-worker-probe') return JSON.stringify({ protocol: 1, checkpointSchema: 1, schemaHash: 'a'.repeat(64), capabilities: { launchProtection: 1, frontendAssets: 1, frontendFingerprint: nativeFingerprint, eventReplay: true, commandDeduplication: true, hostChat: true } });
    if (args.includes('--no-bundle')) { nativeFingerprint = options.env.CCGUI_FRONTEND_FINGERPRINT; put('src-tauri/target/self-update/ccgui-next.exe', 'fixture executable'); }
    if (args[0].endsWith('vite.js')) {
      const destination = args[args.indexOf('--outDir') + 1];
      assert.ok(path.isAbsolute(destination)); assert.ok(pathIdentity(destination).startsWith(pathIdentity(path.join(fs.realpathSync.native(root), '.artifacts/self-update-cache/.building-frontend-'))));
      fs.writeFileSync(path.join(destination, 'index.html'), '<html>fixture</html>');
      fs.writeFileSync(path.join(destination, 'cursor.html'), '<html>cursor</html>');
      put('dist/index.html', '<html>unrelated concurrent build</html>');
    }
    return '';
  } };
  let count = 0;
  const options = () => ({ sourceRoot: root, mode: 'working-tree', batchFile, output: path.join(root, '.tmp', `package-${++count}`), releaseId: `test-${count}` });
  return { root, put, calls, hooks, options, batchFile };
}
test('build metadata hashes inherited proxies without persisting their values', async t => {
  const f = fixture(t);
  const proxy = 'http://fixture-user:fixture-password@proxy.example.invalid:8080';
  f.hooks.env = { HTTPS_PROXY: proxy };
  const run = f.hooks.run;
  f.hooks.run = async (command, args, options) => {
    assert.equal(options.env.HTTPS_PROXY, proxy);
    return run(command, args, options);
  };
  const result = await buildSelfUpdate(f.options(), f.hooks);
  for (const key of [`native-${result.nativeFingerprint}`, `frontend-${result.frontendFingerprint}`]) {
    const raw = fs.readFileSync(path.join(f.root, '.artifacts/self-update-cache', key, 'record.json'), 'utf8');
    const metadata = JSON.parse(raw).metadata;
    assert.match(metadata.environmentHash, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(metadata, 'env'), false);
    assert.equal(Object.hasOwn(metadata, 'environment'), false);
    assert.equal(raw.includes(proxy), false);
    assert.equal(raw.includes('fixture-password'), false);
  }
  const report = fs.readFileSync(`${result.packageRoot}.build-report.json`, 'utf8');
  const provenance = fs.readFileSync(path.join(result.packageRoot, 'build-provenance.json'), 'utf8');
  assert.equal((report + provenance).includes(proxy), false);
  assert.equal((report + provenance).includes('fixture-password'), false);
});

test('verified cache reuses bytes but records the current frozen batch', async t => {
  const f = fixture(t);
  const first = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(first.cacheHit, false);
  const batch = JSON.parse(fs.readFileSync(f.batchFile)); batch.id = randomUUID(); f.put('.tmp/batch.json', batch);
  const second = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(second.cacheHit, true);
  assert.equal(f.calls.filter(([, args]) => args.includes('--no-bundle')).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.packageRoot, 'build-provenance.json'))).updateBatch.batchId, batch.id);
  assert.equal(first.exeSha256, second.exeSha256);
  assert.equal(fs.readFileSync(path.join(second.packageRoot, 'engine-models/a.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(second.packageRoot, 'frontend/index.html'), 'utf8'), '<html>fixture</html>');
  assert.ok(fs.existsSync(second.logFile));
  assert.ok(second.totalMs >= 0); assert.ok(second.timings.cacheValidation >= 0);
  assert.equal(second.timings.native, 0); assert.equal(second.timings.frontend, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.artifacts/self-update-cache/tauri-self-update.json'))).build.frontendDist, '../scripts/self-update-shell');
});
test('content changes, new untracked files, deletions and tool versions invalidate cache', async t => {
  const f = fixture(t);
  const keys = new Set();
  for (const change of [() => {}, () => f.put('src/app.ts', 'changed'), () => f.put('src/untracked.ts', 'new'), () => fs.unlinkSync(path.join(f.root, 'src/untracked.ts')), () => { f.hooks.toolVersions.fixture = '2'; }]) {
    change(); const result = await buildSelfUpdate(f.options(), f.hooks); keys.add(result.inputFingerprint);
  }
  // Deleting the new file returns to the already validated content snapshot.
  assert.equal(keys.size, 4);
});
test('tampered cache is rejected and force builds without replacing it', async t => {
  const f = fixture(t);
  const result = await buildSelfUpdate(f.options(), f.hooks);
  const exe = f.put(`.artifacts/self-update-cache/native-${result.nativeFingerprint}/payload/ccgui-next.exe`, 'tampered');
  await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /integrity/);
  await buildSelfUpdate({ ...f.options(), force: true }, f.hooks);
  assert.equal(fs.readFileSync(exe, 'utf8'), 'tampered');
});
test('cache integrity includes added and modified files under otherwise common generated names', async t => {
  for (const relative of ['dist/extra.js', 'target/extra.json', 'file.tsbuildinfo']) {
    const f = fixture(t);
    const run = f.hooks.run;
    f.hooks.run = async (command, args, options) => {
      const result = await run(command, args, options);
      if (args[0].endsWith('vite.js')) {
        const output = args[args.indexOf('--outDir') + 1];
        const filename = path.join(output, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, 'original');
      }
      return result;
    };
    const first = await buildSelfUpdate(f.options(), f.hooks);
    const payload = `.artifacts/self-update-cache/frontend-${first.frontendFingerprint}/payload`;
    f.put(`${payload}/${relative}`, 'tampered');
    await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /integrity/, relative);
    f.put(`${payload}/${relative}`, 'original');
    f.put(`${payload}/artifacts/new.js`, 'unrecorded addition');
    await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /integrity/, relative);
  }
});
test('public generated-looking assets participate in add, edit and deletion fingerprints', async t => {
  const f = fixture(t);
  const original = await buildSelfUpdate(f.options(), f.hooks);
  for (const relative of ['public/dist/widget.js', 'public/target/data.json', 'public/foo.tsbuildinfo']) {
    f.put(relative, 'first');
    const added = await buildSelfUpdate(f.options(), f.hooks);
    assert.notEqual(added.inputFingerprint, original.inputFingerprint, relative);
    assert.equal(added.frontendCacheHit, false); assert.equal(added.nativeCacheHit, true);
    f.put(relative, 'changed');
    const changed = await buildSelfUpdate(f.options(), f.hooks);
    assert.notEqual(changed.frontendFingerprint, added.frontendFingerprint, relative);
    assert.equal(changed.frontendCacheHit, false); assert.equal(changed.nativeCacheHit, true);
    fs.unlinkSync(path.join(f.root, relative));
    const removed = await buildSelfUpdate(f.options(), f.hooks);
    assert.equal(removed.inputFingerprint, original.inputFingerprint);
    assert.equal(removed.cacheHit, true);
  }
});
test('source changes during build and build failure never publish success cache', async t => {
  for (const mutate of [true, false]) {
    const f = fixture(t); const original = f.hooks.run;
    f.hooks.run = async (command, args, options) => { if (args.includes('--no-bundle')) { if (mutate) f.put('src/app.ts', 'late change'); else throw new Error('fixture failure'); } return original(command, args, options); };
    await assert.rejects(buildSelfUpdate(f.options(), f.hooks), mutate ? /changed during build/ : /fixture failure/);
    assert.ok(!fs.readdirSync(path.join(f.root, '.artifacts/self-update-cache')).some(name => /^(native|frontend)-/.test(name)));
  }
});
test('rejects wrong batch phase/source, output traversal and overwrite', async t => {
  const f = fixture(t);
  await assert.rejects(buildSelfUpdate({ ...f.options(), output: path.join(f.root, '../escape') }, f.hooks), /escapes/);
  await assert.rejects(buildSelfUpdate({ ...f.options(), output: path.join(f.root, 'src/new') }, f.hooks), /artifact/);
  const result = await buildSelfUpdate(f.options(), f.hooks);
  await assert.rejects(buildSelfUpdate({ ...f.options(), output: result.packageRoot }, f.hooks), /already exists/);
  const batch = JSON.parse(fs.readFileSync(f.batchFile)); batch.phase = 'Queued'; f.put('.tmp/batch.json', batch);
  await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /frozen Building/);
  batch.phase = 'Building'; batch.sourceRoot = path.dirname(f.root); f.put('.tmp/batch.json', batch);
  await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /frozen Building/);
});
test('rejects source and output junctions', async t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'src-tauri'), path.join(f.root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inputInventory(f.root), /Symlink/);
  fs.unlinkSync(path.join(f.root, 'src/linked'));
  fs.symlinkSync(path.join(f.root, 'src'), path.join(f.root, '.tmp/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildSelfUpdate({ ...f.options(), output: path.join(f.root, '.tmp/linked/package') }, f.hooks), /Symlink/);
});
test('CLI refuses runner injection and implicit mode', async t => {
  await assert.rejects(main(['--runner', 'evil']), /Invalid argument/);
  const f = fixture(t); await assert.rejects(buildSelfUpdate({ ...f.options(), mode: undefined }, f.hooks), /Explicit/);
});
test('UI-only changes reuse native; native changes reuse frontend', async t => {
  const f = fixture(t);
  const first = await buildSelfUpdate(f.options(), f.hooks);
  f.put('src/app.ts', 'ui edit');
  const ui = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(ui.nativeCacheHit, true); assert.equal(ui.frontendCacheHit, false);
  assert.equal(ui.nativeFingerprint, first.nativeFingerprint);
  f.put('src-tauri/src/main.rs', 'native edit');
  const native = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(native.nativeCacheHit, false); assert.equal(native.frontendCacheHit, true);
  f.put('.custom/manifest.json', { patchRevision: 10 });
  const revision = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(revision.nativeCacheHit, true); assert.equal(revision.version, '1.2.3+protected.10');
});
test('force bypasses both stages, incompatible probe never publishes cache', async t => {
  const f = fixture(t);
  await buildSelfUpdate(f.options(), f.hooks);
  const force = await buildSelfUpdate({ ...f.options(), force: true }, f.hooks);
  assert.equal(force.nativeCacheHit, false); assert.equal(force.frontendCacheHit, false);
  const g = fixture(t); const original = g.hooks.run;
  g.hooks.run = async (command, args, options) => args[0] === '--task-worker-probe' ? '{}' : original(command, args, options);
  await assert.rejects(buildSelfUpdate(g.options(), g.hooks), /probe rejected/);
  assert.ok(!fs.readdirSync(path.join(g.root, '.artifacts/self-update-cache')).some(name => /^(native|frontend)-/.test(name)));
});
test('installed pnpm resolution and Cargo config changes invalidate relevant caches', async t => {
  const f = fixture(t);
  const first = await buildSelfUpdate(f.options(), f.hooks);
  f.put('node_modules/.modules.yaml', 'layoutVersion: 5');
  const installation = await buildSelfUpdate(f.options(), f.hooks);
  assert.notEqual(installation.nativeFingerprint, first.nativeFingerprint);
  assert.equal(installation.frontendCacheHit, false);
  f.put('src-tauri/.cargo/config.toml', '[build]\njobs = 2');
  const cargo = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(cargo.nativeCacheHit, false); assert.equal(cargo.frontendCacheHit, true);
  f.put('.cargo/credentials.toml', 'private fixture content');
  const credentials = await buildSelfUpdate(f.options(), f.hooks);
  assert.equal(credentials.cacheHit, true);
});
test('ambient env files reject without exposing their content', async t => {
  const f = fixture(t); f.put('.env.local', 'PRIVATE=not-for-report');
  await assert.rejects(buildSelfUpdate(f.options(), f.hooks), error => /No file contents were read/.test(error.message) && !error.message.includes('not-for-report'));
});
test('Windows source roots compare case-insensitively; other platforms preserve case', async t => {
  assert.equal(pathIdentity('C:/Example/Source', 'win32'), pathIdentity('C:/example/source', 'win32'));
  assert.notEqual(pathIdentity('/Example/Source', 'linux'), pathIdentity('/example/source', 'linux'));
  if (process.platform === 'win32') {
    const f = fixture(t); const batch = JSON.parse(fs.readFileSync(f.batchFile));
    batch.sourceRoot = batch.sourceRoot.toLowerCase(); batch.changes[0].sourceRoot = batch.sourceRoot;
    f.put('.tmp/batch.json', batch);
    assert.equal((await buildSelfUpdate(f.options(), f.hooks)).cacheHit, false);
  }
});
test('Windows root and snapshot spelling cannot change native build paths or fingerprints', { skip: process.platform !== 'win32' }, async t => {
  for (const mode of ['working-tree', 'capture', 'provided-snapshot']) {
    const f = fixture(t);
    const canonicalRoot = fs.realpathSync.native(f.root);
    const batch = JSON.parse(fs.readFileSync(f.batchFile));
    batch.sourceRoot = f.root.toUpperCase();
    batch.changes[0].sourceRoot = batch.sourceRoot;
    f.put('.tmp/batch.json', batch);
    f.put('.cargo/config.toml', '[build]\njobs = 2');
    const providedSnapshot = path.join(f.root, '.tmp/SourceSnapshot');
    if (mode === 'provided-snapshot') {
      createSourceSnapshot(f.root, providedSnapshot);
    }
    const nativeCalls = [];
    const run = f.hooks.run;
    f.hooks.run = async (command, args, options) => {
      if (args.includes('--no-bundle')) {
        nativeCalls.push({
          command, args, cwd: options.cwd, target: options.env.CARGO_TARGET_DIR,
          fingerprint: options.env.CCGUI_FRONTEND_FINGERPRINT,
        });
      }
      return run(command, args, options);
    };
    const build = (sourceRoot, snapshotDir, force = false) => {
      const options = f.options();
      return buildSelfUpdate({
        ...options, sourceRoot, force,
        output: path.join(path.dirname(options.output).toUpperCase(), path.basename(options.output)),
        captureSnapshot: mode === 'capture',
        ...(mode === 'provided-snapshot' ? { snapshotDir } : {}),
      }, f.hooks);
    };
    const first = await build(f.root.toLowerCase(), providedSnapshot.toLowerCase());
    const second = await build(f.root.toUpperCase(), providedSnapshot.toUpperCase(), true);
    assert.equal(first.nativeFingerprint, second.nativeFingerprint, mode);
    assert.equal(first.frontendFingerprint, second.frontendFingerprint, mode);
    assert.equal(first.snapshotDir, second.snapshotDir, mode);
    assert.equal(nativeCalls.length, 2, mode);
    assert.deepEqual(nativeCalls[0], nativeCalls[1], mode);
    const expectedCwd = mode === 'capture' ? path.join(canonicalRoot, '.artifacts/self-update-cache/source-snapshot')
      : mode === 'provided-snapshot' ? fs.realpathSync.native(providedSnapshot) : canonicalRoot;
    assert.equal(nativeCalls[0].cwd, expectedCwd, mode);
    assert.equal(nativeCalls[0].target, path.join(canonicalRoot, 'src-tauri/target'), mode);
    const cached = await build(f.root.toLowerCase(), providedSnapshot.toLowerCase());
    assert.equal(cached.cacheHit, true, mode);
    assert.equal(nativeCalls.length, 2, mode);
  }
});
test('root and explicit snapshot junctions are rejected before resolving their targets', async t => {
  const f = fixture(t);
  const alias = path.join(f.root, '.tmp/alias');
  fs.symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildSelfUpdate({ ...f.options(), sourceRoot: alias }, f.hooks), /Symlink/);
  await assert.rejects(buildSelfUpdate({ ...f.options(), snapshotDir: alias }, f.hooks), /Symlink/);
  assert.equal(f.calls.length, 0);
});
test('handoff capability regression is rejected', async t => {
  const f = fixture(t); const original = f.hooks.run;
  f.hooks.run = async (command, args, options) => {
    const result = await original(command, args, options);
    if (args[0] !== '--task-worker-probe') return result;
    const probe = JSON.parse(result); probe.capabilities.eventReplay = false; return JSON.stringify(probe);
  };
  await assert.rejects(buildSelfUpdate(f.options(), f.hooks), /probe rejected/);
});
test('every production Rust embedded external input invalidates native and full fingerprints', async t => {
  const f = fixture(t);
  for (const relative of NATIVE_EMBEDDED_INPUTS) f.put(relative, '{}');
  let previous = await buildSelfUpdate(f.options(), f.hooks);
  for (const relative of NATIVE_EMBEDDED_INPUTS) {
    f.put(relative, '{"changed":true}');
    const next = await buildSelfUpdate(f.options(), f.hooks);
    assert.equal(next.nativeCacheHit, false, relative);
    assert.notEqual(next.nativeFingerprint, previous.nativeFingerprint, relative);
    assert.notEqual(next.inputFingerprint, previous.inputFingerprint, relative);
    previous = next;
  }
  f.put('src/app.ts', 'ordinary UI edit');
  assert.equal((await buildSelfUpdate(f.options(), f.hooks)).nativeCacheHit, true);
});
test('test-only embedded skill changes invalidate the package while reusing production builds', async t => {
  const f = fixture(t);
  const relative = 'src-tauri/resources/skills/ccgui-collab/SKILL.md';
  f.put(relative, 'original collaboration skill');
  const first = await buildSelfUpdate(f.options(), f.hooks);
  f.put(relative, 'updated collaboration skill');
  const next = await buildSelfUpdate(f.options(), f.hooks);
  assert.notEqual(next.inputFingerprint, first.inputFingerprint);
  assert.equal(next.nativeCacheHit, true);
  assert.equal(next.frontendCacheHit, true);
  assert.equal(next.nativeFingerprint, first.nativeFingerprint);
  assert.equal(next.frontendFingerprint, first.frontendFingerprint);
  assert.equal(fs.readFileSync(path.join(next.packageRoot, 'skills/ccgui-collab/SKILL.md'), 'utf8'), 'updated collaboration skill');
});
test('Rust include audit requires explicit classification outside native source tree', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // host_chat.rs includes this module under #[cfg(test)]. Scope the exception
  // to its importer so a future production include still requires classification.
  const testOnly = new Set([
    'src-tauri/src/host_chat/tests.rs:src-tauri/resources/skills/ccgui-collab/SKILL.md',
  ]);
  const seenTestOnly = new Set();
  const seen = new Set();
  function audit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['target', 'node_modules', '.git'].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { audit(filename); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.rs')) continue;
      const source = fs.readFileSync(filename, 'utf8');
      for (const match of source.matchAll(/\binclude(?:_str|_bytes)?!\s*\(\s*([^)]*)\)/g)) {
        const literal = /^"([^"\\]+)"\s*,?\s*$/.exec(match[1]);
        assert.ok(literal, `Review dynamic/concat Rust include in ${filename}`);
        const relative = path.relative(root, path.resolve(path.dirname(filename), literal[1])).split(path.sep).join('/');
        const importer = path.relative(root, filename).split(path.sep).join('/');
        const testOnlyPair = `${importer}:${relative}`;
        if (testOnly.has(testOnlyPair)) seenTestOnly.add(testOnlyPair);
        seen.add(relative);
        const ordinaryNative = relative.startsWith('src-tauri/') && !relative.startsWith('src-tauri/resources/');
        assert.ok(ordinaryNative || NATIVE_EMBEDDED_INPUTS.includes(relative) || testOnly.has(testOnlyPair), `Classify native embedded dependency: ${relative}`);
      }
    }
  }
  audit(path.join(root, 'src-tauri'));
  for (const relative of NATIVE_EMBEDDED_INPUTS) assert.ok(seen.has(relative), `Remove stale embedded dependency: ${relative}`);
  for (const pair of testOnly) assert.ok(seenTestOnly.has(pair), `Remove stale test-only embedded dependency: ${pair}`);
});
test('captureSnapshot isolates the frozen batch build from later working-tree edits and preserves unchanged mtimes', async t => {
  const f = fixture(t);
  const original = f.hooks.run;
  const cwds = [];
  f.hooks.run = async (command, args, options) => {
    if (args.includes('--no-bundle') || args[0].endsWith('vite.js') || args[0].endsWith('tsc')) {
      cwds.push(options.cwd);
    }
    if (args.includes('--no-bundle')) {
      // Simulate task D editing the live working tree while the current batch is building.
      f.put('src/app.ts', 'task-d next-batch edit');
      f.put('src-tauri/resources/skills/a.md', 'task-d modified skill');
    }
    return original(command, args, options);
  };
  const result = await buildSelfUpdate({ ...f.options(), captureSnapshot: true }, f.hooks);
  assert.equal(result.snapshotDir, path.join(fs.realpathSync.native(f.root), '.artifacts/self-update-cache/source-snapshot'));
  assert.ok(cwds.length >= 3);
  for (const cwd of cwds) assert.equal(cwd, result.snapshotDir);
  assert.equal(fs.readFileSync(path.join(result.packageRoot, 'skills/a.md'), 'utf8'), 'skill');

  // Restore original run hook; check that unchanged files in source-snapshot keep their mtime
  // and unit-test-only edits do not invalidate frontendFingerprint.
  f.hooks.run = original;
  f.put('src/app.ts', 'hello');
  f.put('src-tauri/resources/skills/a.md', 'skill');
  const mainRsSnap = path.join(result.snapshotDir, 'src-tauri/src/main.rs');
  const mtimeBefore = fs.statSync(mainRsSnap).mtimeMs;
  f.put('src/app.test.ts', 'unit test edit only');
  const second = await buildSelfUpdate({ ...f.options(), captureSnapshot: true }, f.hooks);
  assert.equal(second.snapshotDir, result.snapshotDir);
  assert.equal(fs.statSync(mainRsSnap).mtimeMs, mtimeBefore);
  assert.equal(second.frontendCacheHit, true);
  assert.equal(second.nativeCacheHit, true);
});
