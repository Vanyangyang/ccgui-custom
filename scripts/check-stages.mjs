import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Verification stages are pure data; the runner below owns reuse and failure
// handling. A stage may be reused only when every input it can observe is
// byte-identical to a previous pass, so scopes are deliberately wide. A file
// that cannot be classified belongs to every scope.
export const STAGE_CACHE_VERSION = 1;
const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Tracked files of HEAD with mode and blob id. Verification requires a clean tree, so this is what is on disk. */
export function headEntries(root) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not list the committed tree');
  return result.stdout.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, , blob] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), mode, blob };
  });
}

const startsWithAny = (value, prefixes) => prefixes.some(prefix => value.startsWith(prefix));
export function stageScopes(embeddedInputs) {
  const embedded = new Set(embeddedInputs);
  const native = relative => relative.startsWith('src-tauri/') || embedded.has(relative) || relative.startsWith('.cargo/') || /^rust-toolchain/.test(relative) || /^Cargo\.(?:toml|lock)$/.test(relative);
  return {
    all: () => true,
    native,
    // Rust-only files, the maintenance scripts and prose documents cannot change type
    // checking or the Vitest run (nothing under src imports or reads them); resources,
    // generated skill documents, self-update-shell and TypeScript tooling still can.
    frontend: relative => !(startsWithAny(relative, ['src-tauri/src/', 'src-tauri/tests/']) || /^src-tauri\/(?:Cargo\.(?:toml|lock)|build\.rs)$/.test(relative) || /^scripts\/[^/]+\.(?:mjs|rs|sh)$/.test(relative) || relative.startsWith('docs/') || /^[^/]+\.md$/.test(relative)),
    // Tests of the maintenance tools read their own scripts and the packaging
    // configuration; they build their repositories as fixtures.
    tooling: relative => startsWithAny(relative, ['scripts/', '.custom/']) || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(relative) || /^src-tauri\/tauri(?:\.[a-z]+)?\.conf\.json$/.test(relative),
    // The embedded-input audit and the compile-path scan also read the Rust tree.
    scripts: relative => native(relative) || startsWithAny(relative, ['scripts/', '.custom/']) || /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(relative),
  };
}

// Variables that can change what a test observes. Parallelism knobs and output
// directories are excluded: they schedule the same work.
const KEY_ENVIRONMENT = /^(?:RUST[A-Z_]*|CARGO_(?!BUILD_JOBS$|TARGET_DIR$)[A-Z_]*|CCGUI_(?!VITEST_WORKERS$|SOURCE_SNAPSHOT$|ISOLATED_ROOT$|RELEASE_PARALLEL$)[A-Z_]*|CL|_CL_|CFLAGS|CXXFLAGS|NODE_OPTIONS|VITE_[A-Z0-9_]*|TAURI_[A-Z_]*)$/i;
export function keyEnvironment(env) {
  return Object.entries(env).filter(([name]) => KEY_ENVIRONMENT.test(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function toolVersions(run = (exe, args) => spawnSync(exe, args, { encoding: 'utf8', windowsHide: true })) {
  const read = (exe, args) => {
    try {
      const result = run(exe, args);
      return result.status === 0 ? String(result.stdout).trim() : 'unavailable';
    } catch { return 'unavailable'; }
  };
  return { node: process.version, cargo: read('cargo', ['-V']), rustc: read('rustc', ['-vV']) };
}

export function stageKey(stage, { entries, scopes, tools, env }) {
  const include = scopes[stage.scope];
  if (!include) throw new Error(`Unknown stage scope: ${stage.scope}`);
  const files = sha256(entries.filter(entry => include(entry.path)).map(entry => `${entry.mode} ${entry.blob}\t${entry.path}`).join('\n'));
  return sha256(JSON.stringify({ version: STAGE_CACHE_VERSION, id: stage.id, exe: path.basename(stage.exe), args: stage.keyArgs ?? stage.args, cwd: stage.cwd ?? '.', scope: stage.scope, tools, env: keyEnvironment(env), files }));
}

export function loadStageCache(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value?.version === STAGE_CACHE_VERSION && value.stages && typeof value.stages === 'object' && !Array.isArray(value.stages)) return value;
  } catch { /* A missing or damaged cache only costs a rerun. */ }
  return { version: STAGE_CACHE_VERSION, stages: {} };
}
export function saveStageCache(filename, cache) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(temporary, filename);
}

// Planning and execution must agree about which stages will actually run.
export function canReuseStage(stage, { cache, fresh = false, key }) {
  return !fresh && !stage.always && cache.stages[stage.id]?.key === key;
}

/**
 * Runs every stage once, in order, whatever earlier stages did: one round should
 * show all failures. A passed stage whose key is unchanged is reused unless
 * `fresh` is set or the stage is `always`. A compile failure blocks the rest of
 * its group, because the remaining stages would only repeat the same error.
 */
export async function runStages(stages, { cache, head, fresh = false, key, execute, save = () => {}, emit = () => {}, now = Date.now }) {
  const results = [];
  const blocked = new Map();
  for (const stage of stages) {
    const base = { id: stage.id, label: stage.label };
    const expected = key(stage);
    const previous = cache.stages[stage.id];
    if (canReuseStage(stage, { cache, fresh, key: expected })) {
      results.push({ ...base, status: 'reused', head: previous.head });
      emit({ stage: stage.label, reused: true, head: previous.head });
      continue;
    }
    if (stage.group && blocked.has(stage.group)) {
      results.push({ ...base, status: 'skipped', reason: blocked.get(stage.group) });
      emit({ stage: stage.label, skipped: blocked.get(stage.group) });
      continue;
    }
    const started = now();
    let outcome;
    try { outcome = await execute(stage); } catch (error) { outcome = { ok: false, message: error.message }; }
    if (outcome.ok) {
      cache.stages[stage.id] = { key: expected, head, label: stage.label, passedAt: new Date(now()).toISOString(), durationMs: now() - started };
      save(cache);
      results.push({ ...base, status: 'ran', durationMs: now() - started });
      continue;
    }
    delete cache.stages[stage.id];
    save(cache);
    results.push({ ...base, status: 'failed', durationMs: now() - started, message: outcome.message });
    if (outcome.compileFailed && stage.group) blocked.set(stage.group, `${stage.label} did not compile`);
  }
  return results;
}

export function summarizeResults(results) {
  const labels = status => results.filter(result => result.status === status).map(result => result.label);
  return { failed: labels('failed'), skipped: results.filter(result => result.status === 'skipped').map(({ label, reason }) => ({ stage: label, reason })), reused: labels('reused'), ran: labels('ran') };
}
