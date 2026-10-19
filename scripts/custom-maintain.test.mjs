import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeRef, inside, proxyEnvironment, nativeEnvironment, fixtureMaintenance, git, main, ROOT } from './custom-maintain.mjs';
test('untrusted refs and paths cannot escape the maintenance workspace', () => {
  for (const ref of ['--force', '../main', 'a//b', 'v1; whoami', 'main/', 'v1.', 'refs/.hidden', 'refs/tag.lock', 'v1@{0}']) assert.throws(() => safeRef(ref));
  assert.equal(safeRef('v1.1.0'), 'v1.1.0');
  assert.throws(() => inside('C:/workspace', '../outside'));
  assert.throws(() => inside('C:/workspace', '.'));
  assert.throws(() => inside('C:/workspace', '../workspace-evil/file'));
  assert.match(inside('C:/workspace', 'integration'), /integration$/);
});

function write(root, filename, contents) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}
function commit(root, message) {
  git(['add', '--all'], root);
  git(['commit', '--quiet', '-m', message], root);
  return git(['rev-parse', 'HEAD'], root);
}
function fixture(t, hooks = {}) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-maintenance-'));
  // This exact directory was created by this test; never clean a computed parent.
  t.after(() => { inside(os.tmpdir(), container); fs.rmSync(container, { recursive: true, force: true }); });
  const upstream = path.join(container, 'upstream');
  const root = path.join(container, 'source');
  const backup = path.join(container, 'backup.git');
  fs.mkdirSync(upstream);
  git(['init', '--quiet', '--initial-branch=main'], upstream);
  git(['config', 'user.name', 'Maintenance Fixture'], upstream);
  git(['config', 'user.email', 'fixture@example.invalid'], upstream);
  git(['config', 'core.autocrlf', 'false'], upstream);
  write(upstream, '.gitignore', 'artifacts/\nprofile/\nsrc-tauri/target/\n');
  write(upstream, '.custom/manifest.json', JSON.stringify({ upstreamRemote: upstream, upstreamReleaseCommit: '', upstreamRelease: 'v1', patchRevision: 1 }));
  write(upstream, 'src/version/distribution.ts', 'export const IS_CUSTOM_DISTRIBUTION = true;\n');
  write(upstream, 'package.json', JSON.stringify({ version: '1.1.1' }));
  write(upstream, 'shared.txt', 'base\n');
  const base = commit(upstream, 'baseline');
  git(['tag', 'v1'], upstream);
  git(['clone', '--quiet', upstream, root], container);
  git(['config', 'user.name', 'Maintenance Fixture'], root);
  git(['config', 'user.email', 'fixture@example.invalid'], root);
  git(['config', 'core.autocrlf', 'false'], root);
  git(['remote', 'rename', 'origin', 'upstream'], root);
  git(['init', '--quiet', '--bare', backup], container);
  git(['remote', 'add', 'origin', backup], root);
  const manifest = { upstreamRemote: upstream, upstreamReleaseCommit: base, upstreamRelease: 'v1', patchRevision: 1 };
  write(root, '.custom/manifest.json', JSON.stringify(manifest));
  commit(root, 'custom baseline');
  const api = fixtureMaintenance(root, hooks);
  return { container, upstream, root, backup, base, manifest, api };
}
function nextRelease(f, contents = 'new upstream\n') {
  write(f.upstream, 'upstream.txt', contents);
  const head = commit(f.upstream, 'upstream release');
  git(['tag', 'v2'], f.upstream);
  return head;
}
function snapshot(root) {
  const filename = path.join(root, 'shared.txt');
  return { head: git(['rev-parse', 'HEAD'], root), branch: git(['branch', '--show-current'], root), status: git(['status', '--porcelain=v1'], root), content: fs.readFileSync(filename, 'utf8'), timestamp: fs.statSync(filename).mtimeMs, manifest: fs.readFileSync(path.join(root, '.custom/manifest.json'), 'utf8') };
}
test('integration creates a merged candidate, records revision and pushes only its local backup', t => {
  const f = fixture(t);
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
  const f = fixture(t);
  const before = snapshot(f.root);
  assert.equal(f.api.integrate('v1').status, 'already_integrated');
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
  assert.equal(git(['worktree', 'list', '--porcelain'], f.root).match(/^worktree /gm).length, 1);
});
test('already reachable upstream is a no-op even when the recorded release differs', t => {
  const f = fixture(t);
  nextRelease(f);
  git(['fetch', '--quiet', 'upstream', '--tags'], f.root);
  git(['merge', '--quiet', '--no-edit', 'v2'], f.root);
  const before = snapshot(f.root);
  assert.equal(f.api.integrate('v2').status, 'already_integrated');
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
});
test('integration retains conflict worktree and leaves source and backup unchanged', t => {
  const f = fixture(t);
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
  const f = fixture(t);
  write(f.root, 'shared.txt', 'uncommitted');
  assert.throws(() => f.api.integrate('v1'), /Commit local work/);
  commit(f.root, 'local change');
  write(f.root, '.custom/manifest.json', JSON.stringify({ ...f.manifest, upstreamRemote: 'https://unreviewed.invalid/repo' }));
  commit(f.root, 'bad remote record');
  assert.throws(() => f.api.integrate('v1'), /reviewed source/);
  assert.equal(fs.existsSync(path.join(f.container, 'ccgui-integrations')), false);
});
test('unsafe and nonexistent integration refs preserve the source checkout', t => {
  const f = fixture(t);
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

function preparedBuild(f) {
  const head = git(['rev-parse', 'HEAD'], f.root);
  write(f.root, 'artifacts/custom-verification.json', JSON.stringify({ head, clean: true }));
  const exe = write(f.root, 'src-tauri/target/release/ccgui-next.exe', 'new binary fixture');
  const installer = write(f.root, 'src-tauri/target/release/bundle/nsis/CCGUI-setup.exe', 'installer fixture');
  const destination = write(f.root, 'profile/AppData/Local/Programs/CCGUI/ccgui-next.exe', 'old binary fixture');
  const shortcut = write(f.root, 'profile/Desktop/CC GUI（代理保护）.lnk', 'protected shortcut');
  const script = write(f.root, 'profile/protected-launch.ps1', 'protected script');
  const normalShortcut = write(f.root, 'profile/Desktop/CC GUI.lnk', 'normal shortcut');
  const report = f.api.recordBuild('1.1.1+protected.1', Date.now());
  return { head, exe, installer, destination, shortcut, script, normalShortcut, report };
}
test('successful build report binds clean verified HEAD, binary hash and installer', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  assert.equal(b.report.head, b.head);
  assert.equal(b.report.exe, b.exe);
  assert.equal(b.report.installer, b.installer);
  assert.match(b.report.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(b.report.builtAt)));
});
test('build report rejects dirty, unverified or stale artifacts', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  write(f.root, 'shared.txt', 'dirty');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /exact revision/);
  commit(f.root, 'new revision');
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /exact revision/);
  write(f.root, 'artifacts/custom-verification.json', JSON.stringify({ head: git(['rev-parse', 'HEAD'], f.root), clean: true }));
  fs.utimesSync(b.exe, new Date(0), new Date(0));
  assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), /stale/);
});
test('install backs up, verifies copy, archives ordinary shortcut and launches exact protected link', t => {
  const launched = [];
  const f = fixture(t, { launch: filename => launched.push(filename) });
  const b = preparedBuild(f);
  const shortcutTime = fs.statSync(b.shortcut).mtimeMs;
  const result = f.api.install();
  assert.equal(result.installedSHA, b.report.sha256);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'old binary fixture');
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'new binary fixture');
  assert.equal(fs.existsSync(b.normalShortcut), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(result.backup), 'CC GUI.lnk'), 'utf8'), 'normal shortcut');
  assert.deepEqual(launched, [b.shortcut]);
  assert.equal(fs.readFileSync(b.shortcut, 'utf8'), 'protected shortcut');
  assert.equal(fs.statSync(b.shortcut).mtimeMs, shortcutTime);
  assert.equal(fs.readFileSync(b.script, 'utf8'), 'protected script');
  const again = f.api.install();
  assert.notEqual(again.backup, result.backup);
});
test('running clients prevent install without copying or launching', t => {
  let launched = false;
  const f = fixture(t, { running: () => 1, launch: () => { launched = true; } });
  const b = preparedBuild(f);
  assert.throws(() => f.api.install(), /Close every/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  assert.equal(fs.existsSync(b.normalShortcut), true);
  assert.equal(launched, false);
  assert.equal(fs.readdirSync(path.join(f.root, 'artifacts')).filter(name => name.startsWith('custom-install-')).length, 0);
});
test('process query failure or a client starting after backup prevents copying', t => {
  let calls = 0;
  const f = fixture(t, { running: () => calls++ === 0 ? 0 : 1 });
  const b = preparedBuild(f);
  assert.throws(() => f.api.install(), /Close every/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  const invalid = fixtureMaintenance(f.root, { running: () => 'unknown' });
  assert.throws(() => invalid.install(), /Could not verify/);
});
test('checksum mismatch restores existing binary and preserves both shortcuts', t => {
  let launched = false;
  const f = fixture(t, { copy: (_source, target) => fs.writeFileSync(target, 'corrupt'), launch: () => { launched = true; } });
  const b = preparedBuild(f);
  assert.throws(() => f.api.install(), /checksum mismatch/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  assert.equal(fs.existsSync(b.normalShortcut), true);
  assert.equal(fs.readFileSync(b.shortcut, 'utf8'), 'protected shortcut');
  assert.equal(launched, false);
});
test('binary tampering, build path tampering, and verification HEAD mismatch prevent install', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  fs.writeFileSync(b.exe, 'tampered');
  assert.throws(() => f.api.install(), /verified revision/);
  fs.writeFileSync(b.exe, 'new binary fixture');
  write(f.root, 'artifacts/custom-build.json', JSON.stringify({ ...b.report, exe: b.destination }));
  assert.throws(() => f.api.install(), /verified revision/);
  write(f.root, 'artifacts/custom-build.json', JSON.stringify({ ...b.report, installer: path.join(f.container, 'outside.exe') }));
  assert.throws(() => f.api.install(), /outside the intended/);
  write(f.root, 'artifacts/custom-build.json', JSON.stringify(b.report));
  write(f.root, 'artifacts/custom-verification.json', JSON.stringify({ head: 'different', clean: true }));
  assert.throws(() => f.api.install(), /exact revision/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
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
  assert.equal(nativeEnvironment({}).CARGO_BUILD_JOBS, '2');
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
  const b = preparedBuild(f);
  for (const [localPath, encoding, oddOffset] of [
    [f.root, 'utf8', false],
    [f.root.replaceAll(path.sep, '/').toUpperCase(), 'utf8', false],
    [path.join(f.root, 'profile'), 'utf16le', false],
    [f.root, 'utf16le', true],
  ]) {
    const encoded = Buffer.from(`fixture ${localPath} fixture`, encoding);
    fs.writeFileSync(b.exe, oddOffset ? Buffer.concat([Buffer.from([0]), encoded]) : encoded);
    assert.throws(() => f.api.recordBuild('1.1.1+protected.1', Date.now()), error => {
      assert.match(error.message, /contains a local build path/);
      assert.equal(error.message.includes(localPath), false);
      return true;
    });
  }
});
