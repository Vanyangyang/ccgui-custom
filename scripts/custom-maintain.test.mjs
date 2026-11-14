import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRef, inside, proxyEnvironment, nativeEnvironment, git, main, ROOT } from './custom-maintain.mjs';
import { defaultCargoJobs } from './self-update-build.mjs';
import { commit, fixture, nextRelease, preparedBuild, snapshot, write } from './custom-maintain-fixture.mjs';

// Upstream integration, verification and build reports. Installation is covered
// by custom-maintain-install*.test.mjs so the files run in parallel.
test('untrusted refs and paths cannot escape the maintenance workspace', () => {
  for (const ref of ['--force', '../main', 'a//b', 'v1; whoami', 'main/', 'v1.', 'refs/.hidden', 'refs/tag.lock', 'v1@{0}']) assert.throws(() => safeRef(ref));
  assert.equal(safeRef('v1.1.0'), 'v1.1.0');
  assert.throws(() => inside('C:/workspace', '../outside'));
  assert.throws(() => inside('C:/workspace', '.'));
  assert.throws(() => inside('C:/workspace', '../workspace-evil/file'));
  assert.match(inside('C:/workspace', 'integration'), /integration$/);
});

const ownRemotes = { ownRemotes: true };
test('integration creates a merged candidate, records revision and pushes only its local backup', t => {
  const f = fixture(t, {}, ownRemotes);
  const upstreamHead = nextRelease(f);
  const before = snapshot(f.root);
  const existing = write(f.container, 'ccgui-integrations/existing/keep.txt', 'keep');
  const result = f.api.integrate('v2');
  assert.equal(result.status, 'merged_candidate');
  assert.equal(result.upstream, upstreamHead);
  assert.equal(path.dirname(result.directory), path.join(f.container, 'ccgui-integrations'));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, '.custom/manifest.json'), 'utf8'));
  assert.equal(manifest.patchRevision, 2);
  assert.equal(manifest.upstreamReleaseCommit, upstreamHead);
  assert.equal(git(['status', '--porcelain=v1'], result.directory), '');
  assert.equal(git(['rev-parse', result.branch], f.backup), git(['rev-parse', 'HEAD'], result.directory));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');
  const second = f.api.integrate('v2');
  assert.notEqual(second.directory, result.directory);
  assert.notEqual(second.branch, result.branch);
});
test('recorded release is a no-op without worktree or revision changes', t => {
  const f = fixture(t, {}, ownRemotes);
  const before = snapshot(f.root);
  assert.equal(f.api.integrate('v1').status, 'already_integrated');
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
  assert.equal(git(['worktree', 'list', '--porcelain'], f.root).match(/^worktree /gm).length, 1);
});
test('already reachable upstream is a no-op even when the recorded release differs', t => {
  const f = fixture(t, {}, ownRemotes);
  nextRelease(f);
  git(['fetch', '--quiet', 'upstream', '--tags'], f.root);
  git(['merge', '--quiet', '--no-edit', 'v2'], f.root);
  const before = snapshot(f.root);
  assert.equal(f.api.integrate('v2').status, 'already_integrated');
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
});
test('integration retains conflict worktree and leaves source and backup unchanged', t => {
  const f = fixture(t, {}, ownRemotes);
  write(f.root, 'shared.txt', 'custom\n');
  commit(f.root, 'custom edit');
  write(f.upstream, 'shared.txt', 'upstream\n');
  commit(f.upstream, 'upstream edit');
  git(['tag', 'v2'], f.upstream);
  const before = snapshot(f.root);
  const result = f.api.integrate('v2');
  assert.equal(result.status, 'conflicts');
  assert.deepEqual(result.conflicts, ['shared.txt']);
  assert.match(fs.readFileSync(path.join(result.directory, 'shared.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, '.custom/manifest.json'), 'utf8')).patchRevision, 1);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(git(['branch', '--list', result.branch], f.backup), '');
});
test('dirty source and changed reviewed upstream are rejected before creating candidates', t => {
  const f = fixture(t, {}, ownRemotes);
  write(f.root, 'shared.txt', 'uncommitted');
  assert.throws(() => f.api.integrate('v1'), /Commit local work/);
  commit(f.root, 'local change');
  write(f.root, '.custom/manifest.json', JSON.stringify({ ...f.manifest, upstreamRemote: 'https://unreviewed.invalid/repo' }));
  commit(f.root, 'bad remote record');
  assert.throws(() => f.api.integrate('v1'), /reviewed source/);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
});
test('unsafe and nonexistent integration refs preserve the source checkout', t => {
  const f = fixture(t, {}, ownRemotes);
  const before = snapshot(f.root);
  assert.throws(() => f.api.integrate('../escape'), /safe upstream/);
  assert.throws(() => f.api.integrate('missing-release'), /rev-parse failed/);
  assert.deepEqual(snapshot(f.root), before);
});
test('CLI rejects arbitrary install paths and extra parameters before any operations', async () => {
  await assert.rejects(main(['install', 'C:/outside.exe']), /documented command arguments/);
  await assert.rejects(main(['integrate', 'v1', '--token=secret']), /documented command arguments/);
});

test('verification cannot certify a commit or uncommitted edit introduced while checks ran', t => {
  const f = fixture(t);
  const checkedHead = git(['rev-parse', 'HEAD'], f.root);
  assert.equal(f.api.recordVerification(checkedHead).head, checkedHead);
  const filename = path.join(f.root, 'artifacts/custom-verification.json');
  const before = fs.readFileSync(filename, 'utf8');
  write(f.root, 'shared.txt', 'changed during checks\n');
  assert.throws(() => f.api.recordVerification(checkedHead), /Source changed during verification/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  const nextHead = commit(f.root, 'concurrent change');
  assert.throws(() => f.api.recordVerification(checkedHead), /Source changed during verification/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  assert.equal(f.api.recordVerification(nextHead).head, nextHead);
});

test('successful build report binds clean verified HEAD, binary hash and installer', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  assert.equal(b.report.head, b.head);
  assert.equal(b.report.exe, b.exe);
  assert.equal(b.report.installer, b.installer);
  assert.match(b.report.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(b.report.builtAt)));
  assert.equal(b.report.reportVersion, 2);
  assert.deepEqual(b.report.resources.map(item => item.path), ['agent-catalogs/catalog.json', 'skills/creator/SKILL.md', 'skills/creator/references/sdk-api.md']);
  for (const item of b.report.resources) {
    const bytes = fs.readFileSync(path.join(f.root, item.source));
    assert.equal(item.size, bytes.length);
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});
test('build report rejects dirty, unverified or stale artifacts', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  write(f.root, 'shared.txt', 'dirty');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /exact revision/);
  commit(f.root, 'new revision');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /exact revision/);
  f.api.recordVerification(git(['rev-parse', 'HEAD'], f.root));
  fs.utimesSync(b.exe, new Date(0), new Date(0));
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /stale/);
});
test('maintenance leaves direct access and user proxy policy unchanged', () => {
  assert.deepEqual(proxyEnvironment({}), {}, 'a fresh user must not need a maintainer proxy');
  const base = {
    HTTP_PROXY: 'http://proxy.fixture:8080',
    HTTPS_PROXY: 'http://tls-proxy.fixture:8081',
    ALL_PROXY: 'socks5://proxy.fixture:1080',
    http_proxy: 'http://lowercase.fixture:8082',
    https_proxy: '',
    all_proxy: 'socks5://lowercase.fixture:1081',
    CARGO_HTTP_PROXY: 'http://cargo.fixture:8083',
    NO_PROXY: '*',
    no_proxy: 'localhost,.fixture',
    PATH: 'fixture-path',
  };
  const env = proxyEnvironment(base);
  assert.deepEqual(env, base);
  assert.notEqual(env, base);
  env.HTTPS_PROXY = 'changed';
  assert.equal(base.HTTPS_PROXY, 'http://tls-proxy.fixture:8081');
});

test('native builds default to bounded concurrency and retain an explicit user setting', () => {
  assert.equal(nativeEnvironment({}).CARGO_BUILD_JOBS, defaultCargoJobs());
  assert.equal(nativeEnvironment({}, '5').CARGO_BUILD_JOBS, '5');
  assert.equal(nativeEnvironment({}, '5', path.join(ROOT, 'artifacts', 'check-target')).CARGO_TARGET_DIR, path.join(ROOT, 'artifacts', 'check-target'));
  const base = { CARGO_BUILD_JOBS: '4', CARGO_TARGET_DIR: 'outside-fixture', HTTPS_PROXY: 'http://proxy.fixture:8080' };
  const env = nativeEnvironment(base);
  assert.equal(env.CARGO_BUILD_JOBS, '4');
  assert.equal(env.CARGO_TARGET_DIR, path.join(ROOT, 'src-tauri', 'target'));
  assert.equal(env.HTTPS_PROXY, base.HTTPS_PROXY);
  assert.equal(base.CARGO_TARGET_DIR, 'outside-fixture');
});

test('fresh or damaged verification reports give an actionable error without certifying a build', t => {
  const f = fixture(t);
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /Run pnpm maint:check, then pnpm maint:build/);
  write(f.root, 'artifacts/custom-verification.json', '{invalid-json');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /Run pnpm maint:check, then pnpm maint:build/);
  write(f.root, 'artifacts/custom-verification.json', 'null');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /exact revision/);
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts/custom-build.json')), false);
});

test('build reports reject embedded local checkout or profile paths without echoing them', t => {
  const f = fixture(t);
  const startedAt = Date.now();
  const b = preparedBuild(f);
  for (const [localPath, encoding, oddOffset] of [
    [f.root, 'utf8', false],
    [f.root.replaceAll(path.sep, '/').toUpperCase(), 'utf8', false],
    [path.join(f.root, 'profile'), 'utf16le', false],
    [f.root, 'utf16le', true],
  ]) {
    const encoded = Buffer.from(`fixture ${localPath} fixture`, encoding);
    fs.writeFileSync(b.exe, oddOffset ? Buffer.concat([Buffer.from([0]), encoded]) : encoded);
    assert.throws(() => f.api.recordBuild('1.1.1+protected.1', startedAt), error => {
      assert.match(error.message, /contains a local build path/);
      assert.equal(error.message.includes(localPath), false);
      return true;
    });
  }
});

test('ignored additions and skip-worktree changes cannot be certified as committed resources', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  const source = b.report.resources[0].source;
  git(['update-index', '--skip-worktree', source], f.root);
  fs.writeFileSync(path.join(f.root, source), 'mutable catalog');
  assert.equal(git(['status', '--porcelain=v1'], f.root), '');
  assert.throws(() => f.api.recordVerification(b.head), /committed HEAD/);
  assert.throws(() => f.api.install(), /committed HEAD/);
  fs.writeFileSync(path.join(f.root, source), 'new catalog');
  write(f.root, '.git/info/exclude', 'src-tauri/resources/skills/ignored.md\n');
  write(f.root, 'src-tauri/resources/skills/ignored.md', 'uncertified bytes');
  assert.equal(git(['status', '--porcelain=v1'], f.root), '');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /committed HEAD/);
  fs.unlinkSync(path.join(f.root, 'src-tauri/resources/skills/ignored.md'));
  fs.unlinkSync(path.join(f.root, source));
  assert.throws(() => f.api.install(), /empty|committed HEAD/);
});

test('resource mappings must match the supported Tauri configuration', t => {
  const f = fixture(t);
  preparedBuild(f);
  write(f.root, '.custom/tauri.json', JSON.stringify({ bundle: { resources: { 'resources/skills': 'other' } } }));
  const head = commit(f.root, 'unsupported override');
  assert.throws(() => f.api.recordVerification(head), /mapping overrides/);
  write(f.root, '.custom/tauri.json', '{}');
  write(f.root, 'src-tauri/tauri.conf.json', JSON.stringify({ bundle: { resources: ['resources/skills'] } }));
  assert.throws(() => f.api.recordVerification(commit(f.root, 'unsupported array')), /Unsupported Tauri resource mapping/);
});

test('a verification report records which stages ran and which were reused, and a failed stage certifies nothing', t => {
  const f = fixture(t);
  const head = git(['rev-parse', 'HEAD'], f.root);
  const results = [{ id: 'types', label: 'types', status: 'ran' }, { id: 'vitest', label: 'vitest', status: 'reused', head: 'a'.repeat(40) }];
  f.api.finishVerification(head, results);
  const report = JSON.parse(fs.readFileSync(path.join(f.root, 'artifacts/custom-verification.json'), 'utf8'));
  assert.deepEqual(report.checks, ['types', 'vitest', 'diff']);
  assert.deepEqual(report.stages, [{ id: 'types', status: 'ran' }, { id: 'vitest', status: 'reused', head: 'a'.repeat(40) }]);
  assert.equal(report.head, head);
  fs.rmSync(path.join(f.root, 'artifacts/custom-verification.json'));
  const quiet = console.log;
  console.log = () => {};
  try {
    assert.throws(() => f.api.finishVerification(head, [results[0], { id: 'vitest', label: 'vitest', status: 'failed' }, { id: 'n', label: 'n', status: 'skipped', reason: 'n did not compile' }]), /Verification failed: vitest; inspect/);
  } finally { console.log = quiet; }
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts/custom-verification.json')), false);
});
