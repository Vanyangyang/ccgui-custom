import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseModels, syncModels, snapshotPath } from './sync-agy-models.mjs';

const rows = [{ id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' }];
const envelope = models => JSON.stringify({ status: 'SUCCESS', command: { name: 'models', data: { models } } });
test('command reports missing CLI with nonzero exit and leaves the shipped snapshot intact', () => {
  const before = readFileSync(snapshotPath, 'utf8');
  const script = fileURLToPath(new URL('./sync-agy-models.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script, '--check', '--bin', 'ccgui-nonexistent-agy-fixture'], {
    encoding: 'utf8', shell: false, windowsHide: true, stdio: 'pipe',
  }), error => error.status === 1);
  assert.equal(readFileSync(snapshotPath, 'utf8'), before);
});
test('JSON parses status prefix and rejects errors, empty, malformed and duplicate catalogs', () => {
  assert.deepEqual(parseModels(`Fetching...\n${envelope(rows)}\n`), rows);
  for (const output of ['{}', envelope([]), envelope([...rows, ...rows]), envelope([{ id: 'bad id', label: 'Bad' }]), envelope(rows).replace('SUCCESS', 'ERROR')]) {
    assert.throws(() => parseModels(output));
  }
});

test('fake CLI sync, check drift, and failures preserve previous snapshot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-models-'));
  t.after(() => {
    assert.ok(dir.startsWith(join(tmpdir(), 'agy-models-')));
    rmSync(dir, { recursive: true, force: true });
  });
  const output = join(dir, 'snapshot.json');
  const fixture = join(dir, 'fake-cli.cjs');
  const stateFile = join(dir, 'state.json');
  writeFileSync(fixture, `const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); if (s.fail) process.exit(1); console.log(process.argv[3] === '--version' ? s.version : s.catalog);`);
  const setState = state => writeFileSync(stateFile, JSON.stringify({ version: '1.3.3', catalog: envelope(rows), ...state }));
  const run = (bin, args) => {
    assert.equal(bin, 'custom agy path');
    assert.ok(JSON.stringify(args) === JSON.stringify(['--version']) || JSON.stringify(args) === JSON.stringify(['--output-format', 'json', 'models']));
    return execFileSync(process.execPath, [fixture, stateFile, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  };
  const options = { bin: 'custom agy path', output, run };
  setState({});
  syncModels(options);
  const original = readFileSync(output, 'utf8');
  assert.doesNotThrow(() => syncModels({ ...options, check: true }));
  for (const state of [{ version: '1.3.4' }, { catalog: envelope([{ ...rows[0], label: 'Changed' }]) }, { catalog: envelope([{ ...rows[0], id: 'other' }]) }]) {
    setState(state);
    assert.throws(() => syncModels({ ...options, check: true }), /drifted/);
    assert.equal(readFileSync(output, 'utf8'), original);
  }
  for (const state of [{ fail: true }, { version: '' }, { catalog: envelope([]) }, { catalog: envelope([...rows, ...rows]) }, { catalog: 'broken' }]) {
    setState(state);
    assert.throws(() => syncModels(options));
    assert.equal(readFileSync(output, 'utf8'), original);
  }
});
