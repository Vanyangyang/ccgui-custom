import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inside, fixtureMaintenance, git } from './custom-maintain.mjs';

// Repositories for the maintenance tests. Building one takes about twenty git
// processes (two seconds on Windows), so tests that neither change nor push to
// the upstream and backup repositories copy one prepared checkout per file.
export function write(root, filename, contents) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}
export function commit(root, message) {
  git(['add', '--all'], root);
  git(['commit', '--quiet', '-m', message], root);
  return git(['rev-parse', 'HEAD'], root);
}
function temporaryContainer(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
// Only an exact directory created here is removed; never clean a computed parent.
function removeContainer(container) {
  inside(os.tmpdir(), container);
  fs.rmSync(container, { recursive: true, force: true });
}
function createRepositories(container) {
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
  write(upstream, 'src-tauri/tauri.conf.json', JSON.stringify({ bundle: { resources: { 'resources/agent-catalogs': 'agent-catalogs', 'resources/skills': 'skills' } } }));
  write(upstream, '.custom/tauri.json', JSON.stringify({ bundle: { targets: ['nsis'] } }));
  write(upstream, 'src-tauri/resources/agent-catalogs/catalog.json', 'new catalog');
  write(upstream, 'src-tauri/resources/skills/creator/SKILL.md', 'new skill');
  write(upstream, 'src-tauri/resources/skills/creator/references/sdk-api.md', 'new SDK');
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
  return { upstream, root, backup, base, manifest };
}
let template;
function sharedTemplate() {
  if (!template) {
    const container = temporaryContainer('ccgui-maintenance-template-');
    process.once('exit', () => removeContainer(container));
    template = createRepositories(container);
  }
  return template;
}
/**
 * A source checkout with an upstream and a local backup remote. Copies share the
 * template's remotes read-only; pass `ownRemotes` to change or push to them.
 */
export function fixture(t, hooks = {}, { ownRemotes = false } = {}) {
  const container = temporaryContainer('ccgui-maintenance-');
  t.after(() => removeContainer(container));
  let repositories;
  if (ownRemotes) repositories = createRepositories(container);
  else {
    const shared = sharedTemplate();
    const root = path.join(container, 'source');
    fs.cpSync(shared.root, root, { recursive: true });
    repositories = { ...shared, root };
  }
  return { container, ...repositories, api: fixtureMaintenance(repositories.root, hooks) };
}
export function nextRelease(f, contents = 'new upstream\n') {
  write(f.upstream, 'upstream.txt', contents);
  const head = commit(f.upstream, 'upstream release');
  git(['tag', 'v2'], f.upstream);
  return head;
}
export function snapshot(root) {
  const filename = path.join(root, 'shared.txt');
  return { head: git(['rev-parse', 'HEAD'], root), branch: git(['branch', '--show-current'], root), status: git(['status', '--porcelain=v1'], root), content: fs.readFileSync(filename, 'utf8'), timestamp: fs.statSync(filename).mtimeMs, manifest: fs.readFileSync(path.join(root, '.custom/manifest.json'), 'utf8') };
}
export function preparedBuild(f) {
  const head = git(['rev-parse', 'HEAD'], f.root);
  f.api.recordVerification(head);
  const exe = write(f.root, 'src-tauri/target/release/ccgui-next.exe', 'new binary fixture');
  const installer = write(f.root, 'src-tauri/target/release/bundle/nsis/CCGUI-setup.exe', 'installer fixture');
  const destination = write(f.root, 'profile/AppData/Local/Programs/CCGUI/ccgui-next.exe', 'old binary fixture');
  write(f.root, 'profile/AppData/Local/Programs/CCGUI/skills/creator/SKILL.md', 'old skill');
  const shortcut = write(f.root, 'profile/Desktop/CC GUI（代理保护）.lnk', 'protected shortcut');
  const script = write(f.root, 'profile/protected-launch.ps1', 'protected script');
  const normalShortcut = write(f.root, 'profile/Desktop/CC GUI.lnk', 'normal shortcut');
  const report = f.api.recordBuild('1.1.1+protected.1', Date.now());
  return { head, exe, installer, destination, shortcut, script, normalShortcut, report };
}
export function runtimeState(f, active = true) {
  const identity = { manifestSha256: 'a'.repeat(64), channel: 'protected-custom', releaseId: 'old', version: '1.0.0', workerProtocol: 1, checkpointSchema: 1, schemaHash: 'b'.repeat(64), executable: 'ccgui-next.exe' };
  const state = write(f.root, 'profile/.ccgui-next/runtime-updates/state.json', JSON.stringify({ stateVersion: 1, active: active ? identity : null, transaction: null }));
  const exe = active ? write(f.root, `profile/.ccgui-next/runtime-updates/releases/${identity.manifestSha256}/ccgui-next.exe`, 'active binary') : null;
  return { state, exe, identity };
}
