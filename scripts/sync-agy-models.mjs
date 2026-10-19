import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const snapshotPath = fileURLToPath(new URL('../src-tauri/resources/engine-models/agy.json', import.meta.url));

export function parseModels(stdout) {
  let root;
  for (let i = stdout.indexOf('{'); i >= 0; i = stdout.indexOf('{', i + 1)) {
    try { root = JSON.parse(stdout.slice(i)); break; } catch { /* Skip progress text. */ }
  }
  const rows = root?.command?.data?.models;
  if (root?.status !== 'SUCCESS' || root?.command?.name !== 'models' || !Array.isArray(rows) || rows.length === 0) {
    throw new Error('AGY did not return a successful nonempty model catalog');
  }
  const seen = new Set();
  return rows.map(row => {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    const label = typeof row?.label === 'string' ? row.label.trim() : '';
    if (!id || /\s/.test(id) || !label || seen.has(id)) throw new Error('Invalid or duplicate AGY model');
    seen.add(id);
    return { id, label };
  });
}

function runCli(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function syncModels({ bin = 'agy', check = false, output = snapshotPath, run = runCli } = {}) {
  const cliVersion = run(bin, ['--version']).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(cliVersion)) throw new Error('Invalid AGY CLI version');
  const models = parseModels(run(bin, ['--output-format', 'json', 'models']));
  const snapshot = { cliVersion, models };
  if (check) {
    const current = JSON.parse(readFileSync(output, 'utf8'));
    const comparable = { cliVersion: current.cliVersion, models: current.models?.map(({ id, label }) => ({ id, label })) };
    if (JSON.stringify(comparable) !== JSON.stringify(snapshot)) throw new Error('AGY model snapshot has drifted; run node scripts/sync-agy-models.mjs');
  } else {
    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      renameSync(temporary, output);
    } finally { rmSync(temporary, { force: true }); }
  }
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let bin = 'agy';
    let check = false;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check') check = true;
      else if (args[i] === '--bin' && args[i + 1]) bin = args[++i];
      else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    }
    const result = syncModels({ bin, check });
    console.log(`${check ? 'Verified' : 'Updated'} ${result.models.length} AGY models from CLI ${result.cliVersion}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
