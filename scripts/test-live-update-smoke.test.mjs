import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, fakeClaudeScript, fixtureEngineConfiguration, watchdogScript } from './test-live-update-smoke.mjs';
import { MANAGED_TASK } from './live-update-smoke-mcp.mjs';

test('Windows PowerShell cleanup inventory preserves separate empty, single and multiple identities', { skip: process.platform !== 'win32' }, () => {
  const assignment = watchdogScript().match(/^\s*\$items\s*=.+$/m)?.[0].trim();
  assert.ok(assignment);
  // Execute only the inventory conversion on synthetic JSON, never the
  // watchdog, process inspection, any GUI or an engine executable.
  const cases = [[], [{ pid: 101, role: 'worker' }], [{ pid: 101, role: 'worker' }, { pid: 202, role: 'watchdog' }]];
  const script = `$results=@();\n${cases.map(items => `$raw='${JSON.stringify(items)}';\n${assignment}\n$results += [pscustomobject]@{count=$items.Count;workers=@($items | Where-Object {$_.role -eq 'worker'} | ForEach-Object {$_.pid})}`).join('\n')}\nConvertTo-Json -InputObject $results -Depth 4 -Compress`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [{ count: 0, workers: [] }, { count: 1, workers: [101] }, { count: 2, workers: [101] }]);
});

test('fixture pins every supported engine and disables all but the fake parent engine', () => {
  const source = fs.readFileSync(new URL('../src-tauri/src/config.rs', import.meta.url), 'utf8');
  const declaration = source.match(/pub const ENGINES: \[&str; \d+\] = \[([\s\S]*?)\];/);
  assert.ok(declaration, 'backend engine registry must be checked when its declaration changes');
  const engines = [...declaration[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const fake = 'C:\\fixture\\fake-cli.ps1';
  const { bins, config } = fixtureEngineConfiguration(fake);
  assert.deepEqual(Object.keys(config).sort(), engines.sort());
  for (const engine of engines) {
    assert.equal(bins[`${engine === 'qoder-cn' ? 'qoderCn' : engine}Bin`], fake, engine);
    assert.equal(config[engine].current, engine === 'claude' ? '__local_settings_json__' : '__disabled__', engine);
  }
});

test('ordinary and managed smoke both exercise rollback by default', () => {
  assert.deepEqual(parseArgs([]), { rollback: true });
  assert.deepEqual(parseArgs(['--managed-child', '--no-rollback']), { rollback: false, managedChild: true });
  assert.deepEqual(parseArgs(['--no-rollback', '--managed-child']), { rollback: false, managedChild: true });
  assert.deepEqual(parseArgs(['--managed-child']), { rollback: true, managedChild: true });
  assert.deepEqual(parseArgs(['--managed-child', '--rollback']), { rollback: true, managedChild: true });
  assert.throws(() => parseArgs(['--managed-child', '--managed-child', '--no-rollback']), /repeated/);
});

test('fake CLI isolates child files after reading its fixed task and keeps MCP in the parent', () => {
  const script = fakeClaudeScript('C:\\fixture\\workspace', 'fallback', 'C:\\fixture\\helper.mjs', true);
  assert.ok(script.includes(`$initial.Contains('${MANAGED_TASK}')`));
  assert.ok(script.indexOf('$initial = [Console]::In.ReadLine()') < script.indexOf("'launches.jsonl'"));
  assert.ok(script.includes("$fixtureOutput = [IO.Path]::Combine($fixtureOutput,'managed-child')"));
  assert.ok(script.includes('if ($isManagedChild -and !$explicitSession) { $session = [Guid]::NewGuid().ToString() }'));
  for (const name of ['launches.jsonl', 'fake.pid', 'keep-running', 'emitted.seq', 'paused-for-stop']) {
    assert.ok(script.includes(`[IO.Path]::Combine($fixtureOutput,'${name}')`));
  }
  assert.ok(script.includes('if (!$isManagedChild) {\r\n$mcpConfig='));
  assert.ok(script.includes("'pause-before-stop'"));
  assert.ok(script.includes('while ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }'));
  const ordinary = fakeClaudeScript('C:\\fixture\\workspace', 'fallback', 'C:\\fixture\\helper.mjs');
  assert.ok(ordinary.includes('$isManagedChild = $false'));
  assert.ok(!ordinary.includes(`$initial.Contains('${MANAGED_TASK}')`));
});
