import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, preparedBuild, runtimeState, write } from './custom-maintain-fixture.mjs';

// Installation that succeeds, and how it reads the runtime update state.
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
test('install refreshes only the copied binary timestamp beyond old source, state and active release', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  const r = runtimeState(f);
  const past = Date.now() - 60_000;
  for (const [file, time] of [[b.exe, past], [r.state, past + 10_000], [r.exe, past + 20_000]]) fs.utimesSync(file, new Date(time), new Date(time));
  const sourceTime = fs.statSync(b.exe, { bigint: true }).mtimeNs;
  const before = Date.now();
  f.api.install();
  const installed = fs.statSync(b.destination, { bigint: true }).mtimeNs;
  assert.ok(installed >= BigInt(before) * 1_000_000n);
  assert.ok(installed <= BigInt(Date.now()) * 1_000_000n);
  assert.ok(installed > fs.statSync(r.state, { bigint: true }).mtimeNs);
  assert.ok(installed > fs.statSync(r.exe, { bigint: true }).mtimeNs);
  assert.equal(fs.statSync(b.exe, { bigint: true }).mtimeNs, sourceTime);
  assert.equal(createHash('sha256').update(fs.readFileSync(b.destination)).digest('hex'), b.report.sha256);
});
for (const blocker of ['state', 'exe']) {
  for (const offset of [0, 60_000]) {
    test(`install rolls back the whole batch when ${blocker} timestamp is ${offset ? 'future' : 'equal'}`, t => {
      const launched = [];
      const f = fixture(t, { launch: filename => launched.push(filename) });
      const b = preparedBuild(f);
      const r = runtimeState(f);
      const now = Date.now();
      for (const file of [r.state, r.exe]) fs.utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
      fs.utimesSync(r[blocker], new Date(now + offset), new Date(now + offset));
      t.mock.method(Date, 'now', () => now);
      assert.throws(() => f.api.install(), /timestamp/);
      // The comparison runs after every resource was copied; all of them are restored.
      const directory = path.dirname(b.destination);
      assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
      assert.equal(fs.readFileSync(path.join(directory, 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
      assert.equal(fs.existsSync(path.join(directory, 'agent-catalogs')), false);
      assert.equal(fs.existsSync(path.join(directory, 'skills/creator/references')), false);
      assert.equal(fs.existsSync(b.normalShortcut), true);
      assert.deepEqual(launched, []);
    });
  }
}
test('state without active release needs no invented release path or timestamp comparison', t => {
  const f = fixture(t);
  preparedBuild(f);
  const r = runtimeState(f, false);
  fs.utimesSync(r.state, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  assert.equal(f.api.install().installed, true);
});
test('invalid runtime state and unsafe or missing active paths reject and restore without launching', t => {
  const launched = [];
  const f = fixture(t, { launch: filename => launched.push(filename) });
  const b = preparedBuild(f);
  const r = runtimeState(f);
  for (const state of ['{broken', 'null', { stateVersion: 2 }, { stateVersion: 1, active: { ...r.identity, manifestSha256: '../outside' } }, { stateVersion: 1, active: { ...r.identity, executable: '../outside.exe' } }, { stateVersion: 1, active: { ...r.identity, manifestSha256: 'c'.repeat(64) } }]) {
    fs.writeFileSync(r.state, typeof state === 'string' ? state : JSON.stringify(state));
    assert.throws(() => f.api.install());
    assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
    assert.equal(fs.existsSync(b.normalShortcut), true);
    assert.deepEqual(launched, []);
  }
});
test('pending and identity-unknown updates require recovery before offline installation', t => {
  const launched = [];
  const f = fixture(t, { launch: filename => launched.push(filename) });
  const b = preparedBuild(f);
  const r = runtimeState(f, false);
  for (const phase of ['Preparing', 'Ready', 'Activating', 'Failed']) {
    fs.writeFileSync(r.state, JSON.stringify({ stateVersion: 1, active: null, transaction: { phase, failureReason: phase === 'Failed' ? 'CandidateIdentityUnknown' : null } }));
    assert.throws(() => f.api.install(), /Recover the existing runtime update/);
    assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
    assert.equal(fs.existsSync(b.normalShortcut), true);
    assert.deepEqual(launched, []);
  }
});
test('terminal runtime transactions retain offline installation behavior', t => {
  const f = fixture(t);
  preparedBuild(f);
  const r = runtimeState(f);
  for (const phase of ['Committed', 'RolledBack', 'Failed']) {
    const transaction = { id: '00000000-0000-4000-8000-000000000001', phase, candidate: r.identity, previous: r.identity, failureReason: phase === 'Failed' ? 'CandidateExited' : null };
    fs.writeFileSync(r.state, JSON.stringify({ stateVersion: 1, active: r.identity, transaction }));
    for (const file of [r.state, r.exe]) fs.utimesSync(file, new Date(0), new Date(0));
    assert.equal(f.api.install().installed, true);
  }
});
test('all resources are verified before EXE, mtime validation and protected launch; unknown resources survive', t => {
  const events = [];
  let b;
  const f = fixture(t, {
    copy: (source, target) => { events.push(path.basename(target)); fs.copyFileSync(source, target); },
    launch: file => {
      assert.equal(file, b.shortcut);
      for (const resource of b.report.resources) assert.equal(fs.readFileSync(path.join(path.dirname(b.destination), resource.path), 'utf8'), fs.readFileSync(path.join(f.root, resource.source), 'utf8'));
      events.push('launch');
    },
  });
  b = preparedBuild(f);
  const unknown = write(path.dirname(b.destination), 'skills/user-owned.txt', 'preserve me');
  const result = f.api.install();
  assert.equal(result.installed, true);
  assert.deepEqual(events, ['catalog.json', 'SKILL.md', 'sdk-api.md', 'ccgui-next.exe', 'launch']);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve me');
  assert.equal(fs.readFileSync(path.join(path.dirname(result.backup), 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
});
test('shortcut archival works when a cross-volume rename would fail with EXDEV', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('cross-volume rename'), { code: 'EXDEV' }); });
  const result = f.api.install();
  assert.equal(fs.existsSync(b.normalShortcut), false);
  assert.equal(fs.readFileSync(path.join(path.dirname(result.backup), 'CC GUI.lnk'), 'utf8'), 'normal shortcut');
});
