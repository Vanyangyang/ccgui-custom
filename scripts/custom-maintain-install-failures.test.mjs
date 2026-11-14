import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureMaintenance, git } from './custom-maintain.mjs';
import { fixture, preparedBuild, write } from './custom-maintain-fixture.mjs';

// Installation that is refused or fails part-way, and what it restores.
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
test('old reports and altered, missing, unordered or escaping resource manifests cannot install', t => {
  const launched = [];
  const f = fixture(t, { launch: file => launched.push(file) });
  const b = preparedBuild(f);
  const filename = path.join(f.root, 'artifacts/custom-build.json');
  const resources = b.report.resources;
  for (const report of [
    { ...b.report, reportVersion: undefined },
    { ...b.report, resources: undefined },
    { ...b.report, resources: resources.slice(1) },
    { ...b.report, resources: [...resources].reverse() },
    ...['path', 'source', 'size', 'sha256'].map(key => ({ ...b.report, resources: [{ ...resources[0], [key]: key === 'size' ? 0 : '../outside' }, ...resources.slice(1)] })),
  ]) {
    fs.writeFileSync(filename, JSON.stringify(report));
    assert.throws(() => f.api.install(), /verified revision|Resource manifest/);
  }
  fs.writeFileSync(filename, JSON.stringify(b.report));
  write(f.root, 'artifacts/custom-verification.json', JSON.stringify({ head: b.head, clean: true }));
  assert.throws(() => f.api.install(), /Old verification report/);
  assert.deepEqual(launched, []);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
});
test('directories, junctions and dangling junctions cannot replace resource files or ancestors', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  const installRoot = path.dirname(b.destination);
  const target = path.join(installRoot, 'agent-catalogs');
  const outside = path.join(f.container, 'outside');
  fs.mkdirSync(outside);
  for (const linkTarget of [outside, path.join(f.container, 'missing')]) {
    fs.symlinkSync(linkTarget, target, 'junction');
    assert.throws(() => f.api.install(), /symbolic links or junctions/);
    fs.unlinkSync(target);
  }
  fs.mkdirSync(path.join(target, 'catalog.json'), { recursive: true });
  assert.throws(() => f.api.install(), /regular files/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  const source = path.join(f.root, 'src-tauri/resources/agent-catalogs/catalog.json');
  git(['update-index', '--skip-worktree', 'src-tauri/resources/agent-catalogs/catalog.json'], f.root);
  fs.unlinkSync(source);
  fs.symlinkSync(outside, source, 'junction');
  assert.throws(() => f.api.install(), /symbolic links or junctions/);
});
test('hard-linked installed resources cannot modify an unlisted user file', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  const directory = path.dirname(b.destination);
  const userFile = write(directory, 'user-file.txt', 'preserve linked bytes');
  const destination = path.join(directory, 'skills/creator/SKILL.md');
  fs.unlinkSync(destination);
  fs.linkSync(userFile, destination);
  assert.throws(() => f.api.install(), /hard links/);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'preserve linked bytes');
});

for (const failAt of [2, 3, 4]) {
  test(`partial copy failure at file ${failAt} restores replaced resources and removes newly created files`, t => {
    const launched = [];
    let copied = 0;
    const f = fixture(t, {
      copy: (source, target) => {
        fs.copyFileSync(source, target);
        if (++copied === failAt) { fs.writeFileSync(target, 'partial'); throw new Error('injected copy failure'); }
      },
      launch: file => launched.push(file),
    });
    const b = preparedBuild(f);
    const installRoot = path.dirname(b.destination);
    const unknown = write(installRoot, 'skills/user-owned.txt', 'preserve me');
    assert.throws(() => f.api.install(), /injected copy failure/);
    assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
    assert.equal(fs.readFileSync(path.join(installRoot, 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
    assert.equal(fs.existsSync(path.join(installRoot, 'agent-catalogs/catalog.json')), false);
    assert.equal(fs.existsSync(path.join(installRoot, 'skills/creator/references')), false);
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve me');
    assert.equal(fs.existsSync(b.normalShortcut), true);
    assert.deepEqual(launched, []);
  });
}

test('a resource corrupted by a later copy is detected by the final verification sweep', t => {
  const f = fixture(t, { copy: (source, target) => {
    fs.copyFileSync(source, target);
    if (path.basename(target) === 'ccgui-next.exe') fs.writeFileSync(path.join(path.dirname(target), 'skills/creator/SKILL.md'), 'late corruption');
  } });
  const b = preparedBuild(f);
  assert.throws(() => f.api.install(), /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(path.dirname(b.destination), 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
});

test('one failed restoration does not block other files and reports the retained backup', t => {
  let restoring = false;
  const copyFile = fs.copyFileSync;
  const f = fixture(t, { copy: (source, target) => {
    copyFile(source, target);
    if (path.basename(target) === 'ccgui-next.exe') { restoring = true; throw new Error('injected install failure'); }
  } });
  const b = preparedBuild(f);
  const directory = path.dirname(b.destination);
  const skill = path.join(directory, 'skills/creator/SKILL.md');
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    if (restoring && target === skill) throw new Error('injected restore failure');
    return copyFile(source, target, ...args);
  });
  assert.throws(() => f.api.install(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /restore failed; recover from/);
    assert.match(error.message, /failed items: skills\/creator\/SKILL\.md/);
    assert.deepEqual(error.errors.map(item => item.message), ['injected install failure', 'injected restore failure']);
    return true;
  });
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  assert.equal(fs.existsSync(path.join(directory, 'agent-catalogs')), false);
  assert.equal(fs.existsSync(path.join(directory, 'skills/creator/references')), false);
  const backups = fs.readdirSync(path.join(f.root, 'artifacts')).filter(name => name.startsWith('custom-install-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'artifacts', backups[0], 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
});

test('a launch error after the start attempt does not replace files potentially in use', t => {
  const f = fixture(t, { launch: () => { throw new Error('launch outcome unknown'); } });
  const b = preparedBuild(f);
  assert.throws(() => f.api.install(), /launch outcome unknown/);
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'new binary fixture');
  assert.equal(fs.readFileSync(path.join(path.dirname(b.destination), 'skills/creator/SKILL.md'), 'utf8'), 'new skill');
});

test('shortcut removal failure restores its verified copy and the installed batch', t => {
  const f = fixture(t);
  const b = preparedBuild(f);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', filename => {
    unlink(filename);
    if (filename === b.normalShortcut) throw new Error('shortcut removal failed after unlink');
  });
  assert.throws(() => f.api.install(), /shortcut removal failed after unlink/);
  assert.equal(fs.readFileSync(b.normalShortcut, 'utf8'), 'normal shortcut');
  assert.equal(fs.readFileSync(b.destination, 'utf8'), 'old binary fixture');
  assert.equal(fs.readFileSync(path.join(path.dirname(b.destination), 'skills/creator/SKILL.md'), 'utf8'), 'old skill');
  assert.equal(fs.existsSync(path.join(path.dirname(b.destination), 'agent-catalogs')), false);
});
