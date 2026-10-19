import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageLocal, parseArgs, safeRelative, publishLocalDirectory } from './live-update-package.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'built.exe'); fs.writeFileSync(exe, 'local executable fixture');
  return { root, options: { exe, output: path.join(root, 'package'), releaseId: 'local-one', version: '1.1.1+protected.31', schemaHash: 'a'.repeat(64), mode: 'working-tree' } };
}

test('explicit working-tree package records honest provenance and independent digest', t => {
  const { root, options } = fixture(t);
  const resources = path.join(root, 'input-resources'); fs.mkdirSync(resources); fs.writeFileSync(path.join(resources, '中文.txt'), 'hello');
  const result = packageLocal({ ...options, resources });
  assert.equal(result.verified, false);
  const manifestBytes = fs.readFileSync(path.join(result.output, 'manifest.json'));
  assert.equal(result.manifestSha256, digest(manifestBytes));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.channel, 'protected-custom'); assert.equal(manifest.manifestVersion, 1);
  assert.ok(manifest.files.some(file => file.path === '中文.txt'));
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(result.output, file.path));
    assert.equal(file.bytes, bytes.length); assert.equal(file.sha256, digest(bytes));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.output, 'build-provenance.json'))).verified, false);
  assert.throws(() => packageLocal(options), /already exists/);
});

test('coordinated package includes every frozen revision in hashed provenance', t => {
  const { root, options } = fixture(t);
  const batch = { id: randomUUID(), phase: 'Building', sourceRoot: root,
    changes: [{ id: randomUUID(), sourceRoot: root, revision: 'verified-ui-r1' }, { id: randomUUID(), sourceRoot: root, revision: 'verified-fix-r2' }] };
  const batchFile = path.join(root, 'batch.json');
  fs.writeFileSync(batchFile, JSON.stringify({ startBuild: true, channel: { batch } }));
  const result = packageLocal({ ...options, batchFile });
  const proofBytes = fs.readFileSync(path.join(result.output, 'build-provenance.json'));
  assert.deepEqual(JSON.parse(proofBytes).updateBatch, { batchId: batch.id, sourceRoot: root, changes: batch.changes.map(({ id, revision }) => ({ id, revision })) });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  assert.equal(manifest.files.find(file => file.path === 'build-provenance.json').sha256, digest(proofBytes));
});

test('invalid or mixed-source batch cannot become package provenance', t => {
  const { root, options } = fixture(t); const batchFile = path.join(root, 'batch.json');
  const batch = { id: randomUUID(), phase: 'Building', sourceRoot: root,
    changes: [{ id: randomUUID(), sourceRoot: root, revision: 'r1' }] };
  for (const invalid of [{ ...batch, phase: 'Committed' }, { ...batch, changes: [] },
    { ...batch, changes: [batch.changes[0], batch.changes[0]] },
    { ...batch, changes: [{ ...batch.changes[0], sourceRoot: path.join(root, 'other') }] }]) {
    fs.writeFileSync(batchFile, JSON.stringify(invalid));
    assert.throws(() => packageLocal({ ...options, batchFile }), /batch/);
    assert.equal(fs.existsSync(options.output), false);
  }
});

test('external frontend and its exact native contract are covered by the release digest', t => {
  const { root, options } = fixture(t);
  const frontend = path.join(root, 'dist'); fs.mkdirSync(frontend);
  fs.writeFileSync(path.join(frontend, 'index.html'), '<html>新界面🙂</html>');
  fs.writeFileSync(path.join(frontend, 'cursor.html'), '<html>cursor</html>');
  const frontendFingerprint = 'b'.repeat(64);
  const result = packageLocal({ ...options, frontend, frontendFingerprint });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.output, 'manifest.json')));
  assert.equal(manifest.manifestVersion, 1, 'old hosts can stage the existing manifest contract');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.output, 'frontend-manifest.json'))), { formatVersion: 1, nativeFingerprint: frontendFingerprint });
  for (const relative of ['frontend-manifest.json', 'frontend/index.html', 'frontend/cursor.html']) {
    const entry = manifest.files.find(file => file.path === relative);
    const bytes = fs.readFileSync(path.join(result.output, relative));
    assert.equal(entry.sha256, digest(bytes)); assert.equal(entry.bytes, bytes.length);
  }
  assert.deepEqual(parseArgs(['--frontend', frontend, '--frontend-fingerprint', frontendFingerprint]), { frontend, frontendFingerprint });
});

test('external frontend rejects incomplete contract, old installer attestations and missing entry points', t => {
  const { root, options } = fixture(t);
  const frontend = path.join(root, 'dist'); fs.mkdirSync(frontend);
  const frontendFingerprint = 'b'.repeat(64);
  for (const extra of [{ frontend }, { frontendFingerprint }, { frontend, frontendFingerprint: 'bad' }]) {
    assert.throws(() => packageLocal({ ...options, ...extra }), /explicit directory and native fingerprint/);
  }
  assert.throws(() => packageLocal({ ...options, frontend, frontendFingerprint, mode: 'verified-head' }), /installer reports/);
  fs.writeFileSync(path.join(frontend, 'index.html'), 'index');
  assert.throws(() => packageLocal({ ...options, frontend, frontendFingerprint }), /index.html and cursor.html/);
  assert.equal(fs.existsSync(options.output), false);
});

test('resources cannot supply or merge a frontend contract or frontend tree', t => {
  const { root, options } = fixture(t);
  const resources = path.join(root, 'resources'); fs.mkdirSync(resources);
  fs.writeFileSync(path.join(resources, 'frontend-manifest.json'), '{}');
  assert.throws(() => packageLocal({ ...options, resources }), /reserved package path/);
  fs.unlinkSync(path.join(resources, 'frontend-manifest.json'));
  fs.mkdirSync(path.join(resources, 'FrontEnd'));
  fs.writeFileSync(path.join(resources, 'FrontEnd', 'extra.js'), 'wrong tree');
  assert.throws(() => packageLocal({ ...options, resources }), /explicit frontend input/);
  assert.equal(fs.existsSync(options.output), false);
});

test('external frontend refuses junction inputs and counts its metadata in the file budget', t => {
  const { root, options } = fixture(t);
  const frontend = path.join(root, 'dist'); fs.mkdirSync(frontend);
  fs.writeFileSync(path.join(frontend, 'index.html'), 'index');
  fs.writeFileSync(path.join(frontend, 'cursor.html'), 'cursor');
  const frontendFingerprint = 'b'.repeat(64);
  assert.throws(() => packageLocal({ ...options, frontend, frontendFingerprint, limits: { maxFiles: 4 } }), /limit/);
  const alias = path.join(root, 'alias');
  try { fs.symlinkSync(frontend, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create symlink fixture'); return; } throw error; }
  assert.throws(() => packageLocal({ ...options, frontend: alias, frontendFingerprint }), /symlinks or junctions/);
});

test('arguments and unsafe Windows-compatible paths fail before output creation', t => {
  const { options } = fixture(t);
  for (const value of ['../x', '/x', 'a\\b', 'C:/x', 'CON.txt', 'a/NUL', 'a.', 'a:stream', 'a//b']) assert.throws(() => safeRelative(value));
  assert.throws(() => parseArgs(['--exe', 'a', '--exe', 'b']), /repeated/);
  assert.throws(() => parseArgs(['--unknown', 'a']), /Unknown/);
  assert.throws(() => packageLocal({ ...options, mode: undefined }), /Explicit --mode/);
  assert.throws(() => packageLocal({ ...options, mode: 'verified-head' }), /requires/);
  assert.throws(() => packageLocal({ ...options, verificationReport: 'fake' }), /cannot claim/);
  assert.equal(fs.existsSync(options.output), false);
});

test('file and byte limits include provenance', t => {
  const { options } = fixture(t);
  assert.throws(() => packageLocal({ ...options, limits: { maxFiles: 1 } }), /limit/);
  assert.throws(() => packageLocal({ ...options, limits: { maxBytes: 1 } }), /limit/);
  const exeBytes = fs.statSync(options.exe).size;
  assert.throws(() => packageLocal({ ...options, limits: { maxBytes: exeBytes } }), /limit/);
  assert.equal(fs.existsSync(options.output), false);
});

test('resource junction or symlink is rejected', t => {
  const { root, options } = fixture(t);
  const target = path.join(root, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'resource'), 'x');
  const alias = path.join(root, 'alias');
  try { fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create symlink fixture'); return; } throw error; }
  assert.throws(() => packageLocal({ ...options, resources: alias }), /symlinks or junctions/);
  assert.equal(fs.existsSync(options.output), false);
});

test('verified-head requires matching clean commit and executable report', t => {
  const { root, options } = fixture(t);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  function git(...args) { const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'source'), 'source'); git('add', 'source'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const verificationReport = path.join(root, 'verification.json'); const buildReport = path.join(root, 'build.json');
  fs.writeFileSync(verificationReport, JSON.stringify({ head, clean: true, checks: ['fixture only'], checkedAt: new Date().toISOString() }));
  const build = { head, version: options.version, exe: options.exe, sha256: digest(fs.readFileSync(options.exe)), builtAt: new Date().toISOString() };
  fs.writeFileSync(buildReport, JSON.stringify({ ...build, sha256: '0'.repeat(64) }));
  const verified = { ...options, mode: 'verified-head', sourceRoot: repo, verificationReport, buildReport };
  assert.throws(() => packageLocal(verified), /do not attest/);
  fs.writeFileSync(buildReport, JSON.stringify(build));
  fs.writeFileSync(path.join(repo, 'source'), 'dirty'); assert.throws(() => packageLocal(verified), /do not attest/);
  fs.writeFileSync(path.join(repo, 'source'), 'source');
  const result = packageLocal(verified); assert.equal(result.verified, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.output, 'build-provenance.json'))).head, head);
});

test('Windows publication retries the identical rename after transient refusal', t => {
  const { root } = fixture(t);
  const staging = path.join(root, 'staged'); const output = path.join(root, 'published');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'manifest.json'), 'unchanged');
  const calls = []; const sleeps = [];
  publishLocalDirectory(staging, output, {
    platform: 'win32', sleep: milliseconds => sleeps.push(milliseconds),
    rename: (from, to) => {
      calls.push([from, to]);
      if (calls.length < 3) throw Object.assign(new Error('transient publication refusal'), { code: calls.length === 1 ? 'EPERM' : 'EBUSY' });
      fs.renameSync(from, to);
    },
  });
  assert.deepEqual(calls, [[staging, output], [staging, output], [staging, output]]);
  assert.deepEqual(sleeps, [100, 100]);
  assert.equal(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(staging), false);
});

test('permanent Windows publication failure is bounded and preserves the original error and staging', t => {
  const { root } = fixture(t);
  const staging = path.join(root, 'staged'); const output = path.join(root, 'published');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'manifest.json'), 'retained');
  const original = Object.assign(new Error('original access denied'), { code: 'EACCES' });
  let calls = 0; let totalWait = 0;
  assert.throws(() => publishLocalDirectory(staging, output, {
    platform: 'win32', now: () => totalWait, sleep: milliseconds => { totalWait += milliseconds; },
    rename: () => { calls++; throw calls === 1 ? original : Object.assign(new Error('later refusal'), { code: 'EPERM' }); },
  }), error => error === original);
  assert.equal(calls, 30);
  assert.equal(totalWait, 3_000);
  assert.equal(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'), 'retained');
  assert.equal(fs.existsSync(output), false);
});

test('an output appearing during publication retry is never replaced', t => {
  const { root } = fixture(t);
  const staging = path.join(root, 'staged'); const output = path.join(root, 'published');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'manifest.json'), 'candidate');
  let calls = 0;
  assert.throws(() => publishLocalDirectory(staging, output, {
    platform: 'win32',
    rename: () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
    sleep: () => { fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'owner.txt'), 'other publisher'); },
  }), /will not overwrite/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(output, 'owner.txt'), 'utf8'), 'other publisher');
  assert.equal(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'), 'candidate');
});

test('non-Windows and non-transient publication errors are not retried', t => {
  const { root } = fixture(t);
  const staging = path.join(root, 'staged'); const output = path.join(root, 'published');
  fs.mkdirSync(staging);
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
    const original = Object.assign(new Error('non-retryable'), { code });
    let calls = 0;
    assert.throws(() => publishLocalDirectory(staging, output, {
      platform, rename: () => { calls++; throw original; }, sleep: () => assert.fail('must not wait'),
    }), error => error === original);
    assert.equal(calls, 1);
  }
});
