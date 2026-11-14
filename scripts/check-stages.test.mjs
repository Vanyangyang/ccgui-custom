import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NATIVE_EMBEDDED_INPUTS } from './self-update-build.mjs';
import { checkStages, installerBuildConfig, NATIVE_TEST_AREAS, orchestrateRelease, parseCommand, RELEASE_PARALLEL_MIN_FREE_BYTES, releaseJobs, releaseParallelism, splitJobs, verificationStageReusable, vitestWorkers } from './custom-maintain.mjs';
import { headEntries, keyEnvironment, loadStageCache, runStages, saveStageCache, stageKey, stageScopes, summarizeResults, toolVersions } from './check-stages.mjs';

const scopes = stageScopes(NATIVE_EMBEDDED_INPUTS);
const tools = { node: 'v1', cargo: 'c1', rustc: 'r1' };
const entries = (...files) => files.map(([file, blob = 'a'.repeat(40), mode = '100644']) => ({ path: file, blob, mode }));
const base = entries(['src/App.tsx'], ['src-tauri/src/lib.rs'], ['src-tauri/resources/skills/a/SKILL.md'], ['scripts/custom-maintain.mjs'], ['docs/readme.md'], ['package.json'], ['src/i18n/native-startup.json']);
const stage = (scope, extra = {}) => ({ id: `s-${scope}`, label: scope, scope, exe: 'node', args: ['x'], ...extra });
const key = (s, files = base, env = {}) => stageKey(s, { entries: files, scopes, tools, env });
const withBlob = (files, file, blob) => files.map(entry => (entry.path === file ? { ...entry, blob } : entry));

test('a stage is invalidated only by files in its scope', () => {
  const kinds = ['frontend', 'native', 'tooling', 'scripts', 'all'];
  const stages = Object.fromEntries(kinds.map(kind => [kind, stage(kind)]));
  const keys = Object.fromEntries(kinds.map(kind => [kind, key(stages[kind])]));
  const changed = file => Object.fromEntries(kinds.map(kind => [kind, key(stages[kind], withBlob(base, file, 'b'.repeat(40))) !== keys[kind]]));
  const expect = (file, ...invalidated) => assert.deepEqual(changed(file), Object.fromEntries(kinds.map(kind => [kind, invalidated.includes(kind)])), file);
  expect('src/App.tsx', 'frontend', 'all');
  expect('src-tauri/src/lib.rs', 'native', 'scripts', 'all');
  // Resources are read by Vitest (generated skill documents), Rust and packaging tests alike.
  expect('src-tauri/resources/skills/a/SKILL.md', 'frontend', 'native', 'scripts', 'all');
  expect('scripts/custom-maintain.mjs', 'tooling', 'scripts', 'all');
  expect('package.json', 'frontend', 'tooling', 'scripts', 'all');
  // include_str! inputs outside src-tauri are Rust inputs.
  expect('src/i18n/native-startup.json', 'frontend', 'native', 'scripts', 'all');
  expect('docs/readme.md', 'all');
});

test('every embedded Rust input and Cargo or toolchain file belongs to the native scope', () => {
  for (const file of [...NATIVE_EMBEDDED_INPUTS, 'src-tauri/Cargo.lock', 'src-tauri/build.rs', '.cargo/config.toml', 'rust-toolchain.toml', 'Cargo.toml']) assert.equal(scopes.native(file), true, file);
  for (const file of ['src-tauri/src/lib.rs', 'src-tauri/tests/send_path.rs', 'src-tauri/Cargo.toml', 'src-tauri/build.rs']) assert.equal(scopes.frontend(file), false, file);
  for (const file of ['src-tauri/resources/skills/x', 'src-tauri/tauri.conf.json', 'src/App.tsx', 'scripts/build-plugin-skill-docs.ts', 'scripts/self-update-shell/index.html']) assert.equal(scopes.frontend(file), true, file);
  for (const file of ['scripts/custom-maintain.mjs', 'scripts/isolated-build.test.mjs', 'scripts/release-rustc-wrapper.rs', 'docs/a.md', 'README.md']) assert.equal(scopes.frontend(file), false, file);
});

test('keys change with command, tools, mode bits and relevant environment but not with parallelism', () => {
  const s = stage('native');
  const reference = key(s);
  assert.equal(key({ ...s }), reference);
  assert.notEqual(key({ ...s, args: ['y'] }), reference);
  assert.notEqual(key({ ...s, cwd: 'src-tauri' }), reference);
  assert.notEqual(stageKey(s, { entries: base, scopes, tools: { ...tools, rustc: 'r2' }, env: {} }), reference);
  assert.notEqual(key(s, base.map(entry => (entry.path === 'src-tauri/src/lib.rs' ? { ...entry, mode: '100755' } : entry))), reference);
  assert.notEqual(key(s, base, { RUSTFLAGS: '-C debuginfo=0' }), reference);
  assert.notEqual(key(s, base, { CCGUI_FRONTEND_FINGERPRINT: 'a'.repeat(64) }), reference);
  for (const environment of [{ CARGO_BUILD_JOBS: '4' }, { CARGO_TARGET_DIR: 'elsewhere' }, { CCGUI_VITEST_WORKERS: '3' }, { CCGUI_SOURCE_SNAPSHOT: '1' }, { CCGUI_RELEASE_PARALLEL: '1' }, { CCGUI_ISOLATED_ROOT: 'x' }, { PATH: 'x' }, { USERPROFILE: 'y' }]) assert.equal(key(s, base, environment), reference, Object.keys(environment)[0]);
  assert.deepEqual(keyEnvironment({ Rustflags: 'a', CARGO_HOME: 'h', CARGO_BUILD_JOBS: '2', OTHER: 'z' }).map(([name]) => name), ['CARGO_HOME', 'Rustflags']);
  assert.throws(() => key(stage('nowhere')), /Unknown stage scope/);
});

test('the Vitest worker count is scheduling and does not enter the key', () => {
  const [few, many] = [checkStages('2'), checkStages('8')].map(stages => stages.find(item => item.id === 'vitest'));
  assert.notDeepEqual(few.args, many.args);
  assert.equal(key(few), key(many));
  assert.ok(few.args.includes('--maxWorkers') && !few.keyArgs.includes('--maxWorkers'));
});

test('a damaged or foreign stage cache is ignored and saving is atomic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-stages-'));
  try {
    const file = path.join(directory, 'stages.json');
    assert.deepEqual(loadStageCache(file).stages, {});
    for (const text of ['{broken', '[]', '{"version":99,"stages":{}}', '{"version":1,"stages":[]}', 'null']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(loadStageCache(file).stages, {}, text);
    }
    saveStageCache(file, { version: 1, stages: { a: { key: 'k' } } });
    assert.equal(loadStageCache(file).stages.a.key, 'k');
    assert.deepEqual(fs.readdirSync(directory), ['stages.json']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function harness({ cache = { version: 1, stages: {} }, outcomes = {}, fresh = false, keys = {} } = {}) {
  const ran = [], events = [], saved = [];
  const stages = [stage('all', { id: 'a', label: 'a' }), stage('all', { id: 'b', label: 'b' }), stage('all', { id: 'c', label: 'c', always: true })];
  const run = list => runStages(list ?? stages, {
    cache, head: 'H2', fresh,
    key: item => keys[item.id] ?? `key-${item.id}`,
    execute: async item => { ran.push(item.id); return outcomes[item.id] ?? { ok: true }; },
    save: value => saved.push(JSON.stringify(value)),
    emit: event => events.push(event),
    now: (() => { let time = 1000; return () => (time += 5); })(),
  });
  return { run, ran, events, saved, cache };
}

test('every stage runs once, a failure does not stop later stages and failed stages are not cached', async () => {
  const h = harness({ outcomes: { a: { ok: false, message: 'a failed' } } });
  const results = await h.run();
  assert.deepEqual(h.ran, ['a', 'b', 'c']);
  assert.deepEqual(results.map(item => item.status), ['failed', 'ran', 'ran']);
  assert.equal(results[0].message, 'a failed');
  assert.deepEqual(Object.keys(h.cache.stages).sort(), ['b', 'c']);
  assert.deepEqual(summarizeResults(results), { failed: ['a'], skipped: [], reused: [], ran: ['b', 'c'] });
  assert.equal(h.cache.stages.b.head, 'H2');
});

test('the cache is saved after each pass so an interrupted run keeps its passes', async () => {
  const h = harness({ outcomes: { b: { ok: false } } });
  await h.run();
  assert.equal(h.saved.length, 3); // after a's pass, b's failure and c's pass
  assert.deepEqual(Object.keys(JSON.parse(h.saved[0]).stages), ['a']);
});

test('unchanged passed stages are reused, always-run stages are not, and a changed key reruns', async () => {
  const cache = { version: 1, stages: { a: { key: 'key-a', head: 'H1' }, b: { key: 'old', head: 'H1' }, c: { key: 'key-c', head: 'H1' } } };
  const h = harness({ cache });
  const results = await h.run();
  assert.deepEqual(h.ran, ['b', 'c']);
  assert.deepEqual(results.map(item => item.status), ['reused', 'ran', 'ran']);
  assert.equal(results[0].head, 'H1');
  assert.deepEqual(h.events, [{ stage: 'a', reused: true, head: 'H1' }]);
  assert.equal(h.cache.stages.b.key, 'key-b');
  assert.equal(h.cache.stages.a.head, 'H1');
});

test('--fresh reruns everything and refreshes the cache', async () => {
  const cache = { version: 1, stages: { a: { key: 'key-a', head: 'H1' }, b: { key: 'key-b', head: 'H1' } } };
  const h = harness({ cache, fresh: true });
  await h.run();
  assert.deepEqual(h.ran, ['a', 'b', 'c']);
  assert.equal(h.cache.stages.a.head, 'H2');
});

test('a fixed failing stage reruns alone on the next round', async () => {
  const cache = { version: 1, stages: {} };
  const first = harness({ cache, outcomes: { b: { ok: false } } });
  await first.run();
  const second = harness({ cache });
  const results = await second.run();
  assert.deepEqual(second.ran, ['b', 'c']);
  assert.deepEqual(results.map(item => item.status), ['reused', 'ran', 'ran']);
});

test('a compile failure skips the rest of its group but not other groups', async () => {
  const native = id => stage('native', { id, label: id, group: 'native' });
  const list = [native('n1'), native('n2'), stage('frontend', { id: 'v', label: 'v' }), native('n3')];
  const h = harness();
  const results = await runStages(list, { cache: h.cache, head: 'H', key: item => item.id, execute: async item => { h.ran.push(item.id); return item.id === 'n1' ? { ok: false, compileFailed: true } : { ok: true }; }, emit: event => h.events.push(event) });
  assert.deepEqual(h.ran, ['n1', 'v']);
  assert.deepEqual(results.map(item => item.status), ['failed', 'skipped', 'ran', 'skipped']);
  assert.deepEqual(h.events.map(event => event.skipped), ['n1 did not compile', 'n1 did not compile']);
  // An ordinary test failure leaves the group running.
  const second = harness();
  await runStages(list, { cache: second.cache, head: 'H', key: item => item.id, execute: async item => { second.ran.push(item.id); return item.id === 'n1' ? { ok: false } : { ok: true }; } });
  assert.deepEqual(second.ran, ['n1', 'n2', 'v', 'n3']);
});

test('an exception while running a stage is a failure of that stage only', async () => {
  const h = harness();
  const results = await runStages([stage('all', { id: 'x', label: 'x' }), stage('all', { id: 'y', label: 'y' })], { cache: h.cache, head: 'H', key: item => item.id, execute: async item => { if (item.id === 'x') throw new Error('spawn failed'); return { ok: true }; } });
  assert.deepEqual(results.map(item => [item.status, item.message]), [['failed', 'spawn failed'], ['ran', undefined]]);
});

test('the declared verification stages are consistent', () => {
  const stages = checkStages('2');
  assert.equal(new Set(stages.map(item => item.id)).size, stages.length);
  assert.equal(new Set(stages.map(item => item.label)).size, stages.length);
  for (const item of stages) {
    assert.ok(scopes[item.scope], item.id);
    assert.ok(['quick', 'full'].includes(item.phase), item.id);
    assert.ok(path.isAbsolute(item.exe) || item.exe === 'cargo', item.id);
  }
  // Quick stages gate the parallel installer build; Rust stages never do.
  assert.ok(stages.filter(item => item.phase === 'quick').every(item => !item.cargo));
  assert.deepEqual(stages.filter(item => item.always).map(item => item.id), ['privacy-boundary', 'native-build-paths']);
  // The database contract is the first Rust stage so an incompatible schema fails first.
  assert.equal(stages.find(item => item.cargo).id, 'native-schema-contract');
  const schemaTests = stages.filter(item => item.args.some(arg => arg.includes('schema_')));
  assert.deepEqual(schemaTests.map(item => item.id), ['native-schema-contract']);
  // Library areas share one process; assistant notices stay single-threaded and run nowhere else.
  const library = stages.find(item => item.id === 'native-library');
  assert.deepEqual(library.args.slice(library.args.indexOf('--') + 1), [...NATIVE_TEST_AREAS, '--skip', 'assistant_notices']);
  assert.deepEqual(stages.find(item => item.id === 'native-assistant-notices').args.slice(2), ['assistant_notices', '--lib', '--', '--test-threads=1']);
  // Every test file the verification relies on is executed by some stage.
  const executed = stages.flatMap(item => item.args).filter(arg => /^(?:scripts|tests)\/.*\.test\.(?:mjs|ts)$/.test(arg));
  const maintenanceTests = fs.readdirSync(path.dirname(fileURLToPath(import.meta.url))).filter(name => /^custom-maintain.*\.test\.mjs$/.test(name)).map(name => `scripts/${name}`);
  for (const file of [...maintenanceTests, 'scripts/self-update-build.test.mjs', 'scripts/release-compiler.test.mjs', 'scripts/check-stages.test.mjs', 'scripts/isolated-build.test.mjs', 'scripts/native-path-scan.test.mjs', 'tests/privacy-boundary.test.ts']) assert.ok(executed.includes(file), file);
});

test('scheduling defaults scale with the machine and respect explicit settings', () => {
  assert.equal(vitestWorkers({}, 24, 32 * 1024 ** 3), '8');
  assert.equal(vitestWorkers({}, 24, 7 * 1024 ** 3), '7');
  assert.equal(vitestWorkers({}, 24, 1024 ** 3), '2');
  assert.equal(vitestWorkers({}, 4, 32 * 1024 ** 3), '2');
  assert.equal(vitestWorkers({}, 12, 32 * 1024 ** 3), '4');
  assert.equal(vitestWorkers({ CCGUI_VITEST_WORKERS: '3' }, 24, 1024 ** 3), '3');
  for (const value of ['0', '65', '2.5', '-1', 'x', '']) assert.throws(() => vitestWorkers({ CCGUI_VITEST_WORKERS: value }), /integer from 1 to 64/);
  assert.deepEqual(splitJobs(12), { build: '6', check: '6' });
  assert.deepEqual(splitJobs(7), { build: '4', check: '3' });
  assert.deepEqual(splitJobs(1), { build: '1', check: '1' });
});

function cachedVerification(stages, env = {}) {
  return {
    entries: base, scopes, tools, fresh: false,
    cache: { version: 1, stages: Object.fromEntries(stages.map(item => [item.id, { key: key(item, base, env), head: 'previous-head' }])) },
  };
}

test('installer typecheck reuse requires the current input, command, tool and environment key', () => {
  const types = checkStages('2').find(item => item.id === 'types');
  const session = cachedVerification([types]);
  assert.equal(verificationStageReusable(session, types, {}), true);
  assert.equal(verificationStageReusable({ ...session, entries: withBlob(base, 'src-tauri/src/lib.rs', 'b') }, types, {}), true);
  assert.equal(verificationStageReusable({ ...session, entries: withBlob(base, 'src/App.tsx', 'b') }, types, {}), false);
  assert.equal(verificationStageReusable({ ...session, tools: { ...tools, node: 'v2' } }, types, {}), false);
  assert.equal(verificationStageReusable(session, types, { NODE_OPTIONS: '--conditions=custom' }), false);
  assert.equal(verificationStageReusable(session, { ...types, args: [...types.args, '--strict'] }, {}), false);
  assert.equal(verificationStageReusable({ ...session, fresh: true }, types, {}), false);
  delete session.cache.stages.types;
  assert.equal(verificationStageReusable(session, types, {}), false);
});

test('release gives the build its full Cargo budget only when no Cargo verification will run', () => {
  const stages = checkStages('2');
  const native = stages.filter(item => item.phase === 'full' && item.cargo);
  const plan = (session, extra = {}) => releaseJobs(12, { parallel: true, session, stages, env: {}, ...extra });
  assert.deepEqual(plan(cachedVerification(native)), { build: '12', check: '12' });
  for (const item of native) {
    const missing = cachedVerification(native);
    delete missing.cache.stages[item.id];
    assert.deepEqual(plan(missing), { build: '6', check: '6' }, item.id);
  }
  const stale = cachedVerification(native);
  stale.cache.stages[native[0].id].key = 'outdated';
  assert.deepEqual(plan(stale), { build: '6', check: '6' });
  assert.deepEqual(plan({ ...cachedVerification(native), fresh: true }), { build: '6', check: '6' });
  assert.deepEqual(plan(cachedVerification(native), { stages: stages.map(item => item.id === native[0].id ? { ...item, always: true } : item) }), { build: '6', check: '6' });
  assert.deepEqual(plan(stale, { parallel: false }), { build: '12', check: '12' });
  for (const session of [cachedVerification(native), stale, { ...cachedVerification(native), fresh: true }]) {
    assert.deepEqual(releaseJobs(7, { parallel: true, session, stages, env: { CARGO_BUILD_JOBS: '7' } }), { build: '7', check: '7' });
  }
});

test('installer config skips only the standard duplicate typecheck and preserves custom build steps', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-installer-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '.custom'));
  fs.mkdirSync(path.join(directory, 'src-tauri'));
  const pkg = { version: '1.1.1', scripts: { build: 'tsc --noEmit && vite build' } };
  const config = { bundle: { targets: ['nsis'] }, build: { frontendDist: '../dist', beforeDevCommand: 'custom dev' } };
  const write = (file, value) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  write('package.json', pkg);
  write('.custom/manifest.json', { patchRevision: 42 });
  write('.custom/tauri.json', config);
  write('src-tauri/tauri.conf.json', { build: { beforeBuildCommand: 'npm run build' } });
  assert.deepEqual(installerBuildConfig(directory), { ...config, version: '1.1.1+protected.42' });
  assert.deepEqual(installerBuildConfig(directory, { typesVerified: true }), {
    ...config, version: '1.1.1+protected.42', build: { ...config.build, beforeBuildCommand: 'node node_modules/vite/bin/vite.js build' },
  });
  for (const hook of ['node custom-build.mjs', null]) {
    write('.custom/tauri.json', { ...config, build: { ...config.build, beforeBuildCommand: hook } });
    assert.equal(installerBuildConfig(directory, { typesVerified: true }).build.beforeBuildCommand, hook);
  }
  write('.custom/tauri.json', config);
  for (const hook of ['node windows-build.mjs', { script: 'npm run build', cwd: 'custom' }, null]) {
    write('src-tauri/tauri.windows.conf.json', { build: { beforeBuildCommand: hook } });
    assert.equal(installerBuildConfig(directory, { typesVerified: true }).build.beforeBuildCommand, undefined);
  }
  write('src-tauri/tauri.windows.conf.json', { build: { beforeBuildCommand: 'npm run build' } });
  for (const name of ['prebuild', 'postbuild']) {
    write('package.json', { ...pkg, scripts: { ...pkg.scripts, [name]: 'node lifecycle-step.mjs' } });
    assert.equal(installerBuildConfig(directory, { typesVerified: true }).build.beforeBuildCommand, undefined);
  }
  write('package.json', { ...pkg, scripts: { build: `${pkg.scripts.build} && node extra-step.mjs` } });
  assert.equal(installerBuildConfig(directory, { typesVerified: true }).build.beforeBuildCommand, undefined);
});

test('commands accept only their documented arguments', () => {
  assert.deepEqual([...parseCommand(['check', '--fresh']).flags], ['--fresh']);
  assert.equal(parseCommand(['isolated', 'release', '--paths', 'a,b']).values['--paths'], 'a,b');
  assert.equal(parseCommand(['integrate', 'v1']).positional[0], 'v1');
  for (const bad of [['install', '--fresh'], ['build', '--fresh'], ['check', 'x'], ['check', '--fresh', '--fresh'], ['isolated'], ['isolated', 'check', 'extra'], ['isolated', 'check', '--paths'], ['isolated', 'check', '--paths', '--fresh'], ['isolated', 'check', '--paths', 'a', '--paths', 'b'], ['integrate', 'v1', '--token=x'], ['status', 'x'], ['__proto__'], ['constructor']]) assert.throws(() => parseCommand(bad), /Use /, bad.join(' '));
});

const result = (id, status) => ({ id, label: id, status });
function releaseHarness({ quick = [result('q', 'ran')], full = [result('f', 'ran')], buildError, finishError } = {}) {
  const calls = [], events = [], buildOptions = [];
  return {
    calls, events, buildOptions,
    run: () => orchestrateRelease({
      runQuick: async () => { calls.push('quick'); return quick; },
      runFull: async () => { calls.push('full'); return full; },
      startBuild: async options => { calls.push('build'); buildOptions.push(options); if (buildError) throw new Error(buildError); return { version: 'v' }; },
      finish: results => { calls.push(`finish:${results.map(item => item.id).join(',')}`); if (finishError) throw new Error(finishError); },
      record: built => { calls.push('record'); return built; },
      announce: event => events.push(event),
    }),
  };
}

test('release starts the installer after the quick stages and records it only after full verification', async () => {
  const h = releaseHarness();
  assert.deepEqual(await h.run(), { version: 'v' });
  assert.deepEqual(h.calls, ['quick', 'build', 'full', 'finish:q,f', 'record']);
});

test('the installer reuses only a successful types stage from this release', async () => {
  for (const status of ['ran', 'reused']) {
    const h = releaseHarness({ quick: [result('types', status)] });
    await h.run();
    assert.deepEqual(h.buildOptions, [{ typesVerified: true }]);
  }
  const missing = releaseHarness();
  await missing.run();
  assert.deepEqual(missing.buildOptions, [{ typesVerified: false }]);
});

test('release does not build when a quick stage fails but still reports the other stages', async () => {
  const h = releaseHarness({ quick: [result('q', 'failed')], finishError: 'Verification failed: q' });
  await assert.rejects(h.run(), /Verification failed: q/);
  assert.deepEqual(h.calls, ['quick', 'full', 'finish:q,f']);
  assert.deepEqual(h.events, []);
});

test('release voids and never records the installer when a later stage fails', async () => {
  const h = releaseHarness({ full: [result('f', 'failed')], finishError: 'Verification failed: f' });
  await assert.rejects(h.run(), /Verification failed: f/);
  assert.deepEqual(h.calls, ['quick', 'build', 'full', 'finish:q,f']);
  assert.equal(h.events[0].installerVoided, true);
});

test('release surfaces a build failure after verification passed without recording', async () => {
  const h = releaseHarness({ buildError: 'tauri failed' });
  await assert.rejects(h.run(), /tauri failed/);
  assert.deepEqual(h.calls, ['quick', 'build', 'full', 'finish:q,f']);
});

test('a sequential release builds only after every check passed', async () => {
  const run = (finishError) => {
    const calls = [];
    const outcome = orchestrateRelease({
      parallel: false,
      runQuick: async () => { calls.push('quick'); return [result('q', 'ran')]; },
      runFull: async () => { calls.push('full'); return [result('f', 'ran')]; },
      startBuild: async () => { calls.push('build'); return { version: 'v' }; },
      finish: () => { calls.push('finish'); if (finishError) throw new Error(finishError); },
      record: built => { calls.push('record'); return built; },
      announce: event => calls.push(`announce:${event.installerVoided}`),
    });
    return { calls, outcome };
  };
  const passing = run();
  assert.deepEqual(await passing.outcome, { version: 'v' });
  assert.deepEqual(passing.calls, ['quick', 'full', 'finish', 'build', 'record']);
  const failing = run('Verification failed: f');
  await assert.rejects(failing.outcome, /Verification failed: f/);
  assert.deepEqual(failing.calls, ['quick', 'full', 'finish']);
});

test('release parallelism follows free memory unless it is set explicitly', () => {
  const gib = value => value * 1024 ** 3;
  assert.equal(releaseParallelism({}, gib(32)).parallel, true);
  assert.equal(releaseParallelism({}, RELEASE_PARALLEL_MIN_FREE_BYTES).parallel, true);
  const tight = releaseParallelism({}, gib(8));
  assert.equal(tight.parallel, false);
  assert.match(tight.reason, /12 GiB/);
  assert.equal(releaseParallelism({ CCGUI_RELEASE_PARALLEL: '1' }, gib(1)).parallel, true);
  assert.equal(releaseParallelism({ CCGUI_RELEASE_PARALLEL: '0' }, gib(64)).parallel, false);
  for (const value of ['', 'true', '2']) assert.throws(() => releaseParallelism({ CCGUI_RELEASE_PARALLEL: value }), /must be 0 or 1/);
});

test('release does not leave an unhandled rejection when the build fails while checks still run', async () => {
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const h = releaseHarness({ buildError: 'early build failure' });
    await assert.rejects(h.run(), /early build failure/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('head entries of a committed tree carry mode and blob id and tool versions degrade safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-entries-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    git('init', '--quiet');
    fs.mkdirSync(path.join(directory, 'sub dir'));
    fs.writeFileSync(path.join(directory, 'sub dir', 'a b.txt'), 'x');
    fs.writeFileSync(path.join(directory, 'b.txt'), 'y');
    git('add', '--all');
    git('-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '--quiet', '-m', 'm');
    const found = headEntries(directory);
    assert.deepEqual(found.map(entry => entry.path).sort(), ['b.txt', 'sub dir/a b.txt']);
    assert.ok(found.every(entry => entry.mode === '100644' && /^[a-f0-9]{40,64}$/.test(entry.blob)));
    assert.throws(() => headEntries(os.tmpdir()), /committed tree/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assert.deepEqual(toolVersions(() => ({ status: 1, stdout: '' })), { node: process.version, cargo: 'unavailable', rustc: 'unavailable' });
  assert.deepEqual(toolVersions(() => { throw new Error('ENOENT'); }).cargo, 'unavailable');
  assert.equal(toolVersions(() => ({ status: 0, stdout: ' cargo 1.0 \n' })).cargo, 'cargo 1.0');
});
