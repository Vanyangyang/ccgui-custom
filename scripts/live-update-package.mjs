import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_LIMITS = { maxFiles: 4096, maxBytes: 2 * 1024 * 1024 * 1024 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || value.split('/').length > 16) throw new Error('Invalid package path');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$|[<>:"|?*\x00-\x1f\x7f]/.test(part)
      || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error('Invalid package path component');
  }
  return value;
}

function plain(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error('Package paths must not use symlinks or junctions');
  // On Windows node lstat reports junctions as symbolic links. Recheck every
  // ancestor, so an apparently regular file behind a junction is rejected too.
  return stat;
}
function checkAncestors(filename) {
  let current = path.resolve(filename);
  while (true) {
    plain(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function digestFile(filename, expectedBytes) {
  const stat = plain(filename);
  if (!stat.isFile() || stat.size !== expectedBytes) throw new Error('Source file changed or is not regular');
  const digest = createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  let total = 0;
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const read = fs.readSync(fd, buffer);
      if (!read) break;
      total += read;
      if (total > expectedBytes) throw new Error('Source file grew while reading');
      digest.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  if (total !== expectedBytes) throw new Error('Source file changed while reading');
  return digest.digest('hex');
}
function copyBounded(source, destination, expectedBytes) {
  const input = fs.openSync(source, 'r');
  let output;
  try {
    output = fs.openSync(destination, 'wx');
    const buffer = Buffer.alloc(65536);
    let copied = 0;
    for (;;) {
      const read = fs.readSync(input, buffer);
      if (!read) break;
      if (copied + read > expectedBytes) throw new Error('Source grew during packaging');
      let written = 0;
      while (written < read) written += fs.writeSync(output, buffer, written, read - written);
      copied += read;
    }
    if (copied !== expectedBytes) throw new Error('Source changed during packaging');
    fs.fsyncSync(output);
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Cannot inspect source revision (${args[0]})`);
  return result.stdout.trim();
}

function provenance(options, executableHash) {
  if (options.mode === 'working-tree') {
    if (options.verificationReport || options.buildReport) throw new Error('Working-tree packages cannot claim verified reports');
    return { mode: 'working-tree', verified: false, note: 'Explicit local build; no clean-HEAD verification is claimed.' };
  }
  if (options.mode !== 'verified-head') throw new Error('Explicit --mode working-tree or verified-head is required');
  if (!options.sourceRoot || !options.verificationReport || !options.buildReport) throw new Error('Verified-head requires source root, verification report and build report');
  for (const filename of [options.verificationReport, options.buildReport]) checkAncestors(filename);
  const verification = JSON.parse(fs.readFileSync(options.verificationReport, 'utf8'));
  const build = JSON.parse(fs.readFileSync(options.buildReport, 'utf8'));
  const head = git(options.sourceRoot, ['rev-parse', 'HEAD']);
  if (git(options.sourceRoot, ['status', '--porcelain=v1']) || verification.clean !== true || verification.head !== head
    || !Array.isArray(verification.checks) || verification.checks.length === 0 || !Number.isFinite(Date.parse(verification.checkedAt))
    || build.head !== head || build.version !== options.version || build.sha256 !== executableHash
    || path.resolve(build.exe ?? '') !== path.resolve(options.exe) || !Number.isFinite(Date.parse(build.builtAt))) {
    throw new Error('Reports do not attest this clean source revision and executable');
  }
  return { mode: 'verified-head', verified: true, head, checkedAt: verification.checkedAt, checks: verification.checks, builtAt: build.builtAt };
}

function batchProvenance(filename) {
  if (!filename) return undefined;
  checkAncestors(filename);
  if (!plain(filename).isFile() || plain(filename).size > 1024 * 1024) throw new Error('Invalid update batch file');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const batch = value.channel?.batch ?? value.batch ?? value;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(batch.id) || batch.phase !== 'Building' || !path.isAbsolute(batch.sourceRoot ?? '')
    || !Array.isArray(batch.changes) || !batch.changes.length || batch.changes.length > 128) throw new Error('Expected the frozen Building batch returned by coordinate_self_update');
  const seen = new Set();
  const changes = batch.changes.map(change => {
    if (!uuid(change.id) || seen.has(change.id) || !label(change.revision) || change.sourceRoot !== batch.sourceRoot) throw new Error('Invalid or mixed-source update batch changes');
    seen.add(change.id);
    return { id: change.id, revision: change.revision };
  });
  return { batchId: batch.id, sourceRoot: batch.sourceRoot, changes };
}

/** Windows may temporarily refuse directory publication. Retry only the same
 * atomic rename; never replace an existing destination or copy around a failure.
 * Hooks are limited to exercising this publication boundary in local tests. */
export function publishLocalDirectory(staging, output, {
  platform = process.platform,
  rename = fs.renameSync,
  sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  now = () => performance.now(),
} = {}) {
  const deadline = now() + 3_000;
  let originalError;
  for (let retries = 0; ; retries++) {
    // lstat also catches dangling links, which existsSync would treat as absent.
    try {
      fs.lstatSync(output);
      throw new Error('Output appeared during packaging; publication will not overwrite it');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      rename(staging, output);
      return;
    } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      originalError ??= error;
      const remaining = deadline - now();
      if (retries >= 30 || remaining <= 0) throw originalError;
      sleep(Math.min(100, remaining));
      if (now() >= deadline) throw originalError;
    }
  }
}

/** Packages explicitly selected local inputs only; does not install or execute. */
export function packageLocal(options) {
  if (!label(options.releaseId) || !label(options.version) || !validHash(options.schemaHash)) throw new Error('releaseId, version and a SHA256 schemaHash are required');
  const externalFrontend = options.frontend !== undefined || options.frontendFingerprint !== undefined;
  if (externalFrontend && (!options.frontend || !validHash(options.frontendFingerprint))) throw new Error('External frontend requires an explicit directory and native fingerprint');
  if (externalFrontend && options.mode !== 'working-tree') throw new Error('External frontend currently requires working-tree provenance; installer reports do not attest separate frontend bytes');
  if (!options.exe || !options.output) throw new Error('Explicit executable and output paths are required');
  const executable = path.resolve(options.exe);
  const output = path.resolve(options.output);
  const parent = path.dirname(output);
  checkAncestors(executable);
  checkAncestors(parent);
  if (!plain(parent).isDirectory()) throw new Error('Output parent must be a directory');
  if (fs.existsSync(output)) throw new Error('Output already exists; immutable packages are never overwritten');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) throw new Error('Invalid package limits');
  const sources = new Map();
  const folded = new Map([['manifest.json', 'manifest.json'], ['build-provenance.json', 'build-provenance.json'], ['frontend-manifest.json', 'frontend-manifest.json']]);
  let total = 0;
  function add(relative, source) {
    safeRelative(relative);
    const key = relative.toLowerCase();
    if (folded.has(key)) throw new Error('Duplicate or reserved package path');
    const parts = relative.split('/');
    for (let count = 1; count < parts.length; count++) {
      const prefix = parts.slice(0, count).join('/');
      if (sources.has(prefix) || folded.has(prefix.toLowerCase())) throw new Error('File/directory path collision');
    }
    const stat = plain(source);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Package inputs must be regular files');
    total += stat.size;
    if (sources.size + 2 > limits.maxFiles || total > limits.maxBytes) throw new Error('Package exceeds file count or total bytes limit');
    folded.set(key, relative);
    sources.set(relative, { source, bytes: stat.size, sha256: digestFile(source, stat.size) });
  }
  add('ccgui-next.exe', executable);
  let entryCount = 0;
  function walk(directory, prefix, resourceTree = false) {
    checkAncestors(directory);
    for (const name of fs.readdirSync(directory).sort()) {
      if (++entryCount > limits.maxFiles * 17) throw new Error('Too many resource entries');
      const source = path.join(directory, name);
      const relative = safeRelative(prefix ? `${prefix}/${name}` : name);
      if (resourceTree && relative.split('/')[0].toLowerCase() === 'frontend') throw new Error('Frontend assets must use the explicit frontend input, not resources');
      const stat = plain(source);
      if (stat.isDirectory()) walk(source, relative, resourceTree);
      else add(relative, source);
    }
  }
  if (options.resources) {
    const resources = path.resolve(options.resources);
    checkAncestors(resources);
    if (!plain(resources).isDirectory()) throw new Error('Resources must be an explicit directory');
    // Tauri's Windows resource directory is next to the executable. The supplied
    // tree must already have the final resource layout (agent-catalogs/, skills/).
    walk(resources, '', true);
  }
  if (externalFrontend) {
    const frontend = path.resolve(options.frontend);
    checkAncestors(frontend);
    if (!plain(frontend).isDirectory()) throw new Error('Frontend must be an explicit directory');
    const previousTotal = total;
    walk(frontend, 'frontend');
    if (!sources.has('frontend/index.html') || !sources.has('frontend/cursor.html')) throw new Error('Frontend requires index.html and cursor.html');
    if (total - previousTotal > 128 * 1024 * 1024) throw new Error('Frontend exceeds the native 128 MiB snapshot limit');
    const data = Buffer.from(`${JSON.stringify({ formatVersion: 1, nativeFingerprint: options.frontendFingerprint }, null, 2)}\n`);
    total += data.length;
    if (sources.size + 2 > limits.maxFiles || total > limits.maxBytes) throw new Error('Package exceeds file count or total bytes limit');
    sources.set('frontend-manifest.json', { data, bytes: data.length, sha256: hash(data) });
  }
  // Reject case aliases of directory prefixes even on a case-sensitive host.
  const prefixes = new Map();
  for (const relative of sources.keys()) {
    const parts = relative.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/');
      const key = prefix.toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix) throw new Error('Windows path case collision');
      prefixes.set(key, prefix);
    }
  }
  const proof = { ...provenance(options, sources.get('ccgui-next.exe').sha256),
    ...(options.batchFile ? { updateBatch: batchProvenance(options.batchFile) } : {}) };
  const proofBytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  if (total + proofBytes.length > limits.maxBytes) throw new Error('Package exceeds total bytes limit');
  const staging = path.join(parent, `.live-update-package-${randomUUID()}`);
  fs.mkdirSync(staging);
  const files = [];
  // Failed staging is retained; this tool never recursively removes paths.
  for (const [relative, source] of sources) {
    const destination = path.join(staging, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (source.data) fs.writeFileSync(destination, source.data, { flag: 'wx' });
    else {
      checkAncestors(source.source);
      copyBounded(source.source, destination, source.bytes);
    }
    if (digestFile(destination, source.bytes) !== source.sha256) throw new Error('Source changed during packaging');
    files.push({ path: relative, bytes: source.bytes, sha256: source.sha256 });
  }
  fs.writeFileSync(path.join(staging, 'build-provenance.json'), proofBytes, { flag: 'wx' });
  files.push({ path: 'build-provenance.json', bytes: proofBytes.length, sha256: hash(proofBytes) });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { manifestVersion: 1, channel: 'protected-custom', releaseId: options.releaseId, version: options.version,
    workerProtocol: 1, checkpointSchema: 1, schemaHash: options.schemaHash, executable: 'ccgui-next.exe', files };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Manifest exceeds native import size limit');
  fs.writeFileSync(path.join(staging, 'manifest.json'), bytes, { flag: 'wx' });
  // No file named after the digest is put inside the package: the caller must
  // convey this expected digest separately to the native importer.
  if (fs.existsSync(output)) throw new Error('Output appeared during packaging');
  const checkedProof = { ...provenance(options, sources.get('ccgui-next.exe').sha256),
    ...(options.batchFile ? { updateBatch: batchProvenance(options.batchFile) } : {}) };
  if (JSON.stringify(checkedProof) !== JSON.stringify(proof)) throw new Error('Verification provenance changed during packaging');
  publishLocalDirectory(staging, output);
  return { output, manifestSha256: hash(bytes), mode: proof.mode, verified: proof.verified, files: files.length, bytes: total + proofBytes.length,
    integrity: 'SHA256 only; this package is not publisher-signed.' };
}

export function parseArgs(args) {
  const names = new Map([['--exe', 'exe'], ['--resources', 'resources'], ['--output', 'output'], ['--release-id', 'releaseId'],
    ['--version', 'version'], ['--schema-hash', 'schemaHash'], ['--mode', 'mode'], ['--source-root', 'sourceRoot'],
    ['--verification-report', 'verificationReport'], ['--build-report', 'buildReport'], ['--batch-file', 'batchFile'],
    ['--frontend', 'frontend'], ['--frontend-fingerprint', 'frontendFingerprint']]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = names.get(args[i]);
    if (!name || !args[i + 1] || args[i + 1].startsWith('--') || name in options) throw new Error('Unknown, missing or repeated package argument');
    options[name] = args[i + 1];
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(packageLocal(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
