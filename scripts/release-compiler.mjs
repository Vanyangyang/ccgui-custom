import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SEPARATOR = '\x1f';
export const REMAP_ENV = 'CCGUI_RELEASE_REMAP_ARGS';
export const ORIGINAL_WRAPPER_ENV = 'CCGUI_RELEASE_ORIGINAL_RUSTC_WRAPPER';

function canonicalPath(input) {
  let current = input;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot resolve release path mapping');
      const parent = path.dirname(current);
      if (parent === current) throw new Error('Cannot resolve release path mapping');
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function releaseRemapArgs({ root, env = process.env }) {
  const home = (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || os.homedir();
  const mappings = new Map();
  for (const [input, target] of [[home, '/ccgui-user'], [env.CARGO_HOME || path.join(home, '.cargo'), '/ccgui-cargo'], [root, '/ccgui-source']]) {
    if (typeof input !== 'string' || !input || !path.isAbsolute(input) || /[\x00\x1f]/.test(input)) throw new Error('Invalid release path mapping; build and Cargo home paths must be absolute');
    const resolved = path.resolve(root, input);
    // Resolve even not-yet-created Cargo homes through their existing parent.
    // Creating the directory on the first build must not change the cache key.
    const aliases = new Set([resolved, canonicalPath(resolved)]);
    for (const alias of aliases) {
      if (alias === path.parse(alias).root || /[\x00\x1f]/.test(alias)) throw new Error('Invalid release path mapping');
      mappings.set(alias, target);
      if (process.platform === 'win32') {
        const plain = alias.startsWith('\\\\?\\UNC\\') ? `\\\\${alias.slice(8)}` : alias.replace(/^\\\\\?\\/, '');
        mappings.set(plain, target);
        mappings.set(plain.replaceAll('\\', '/'), target);
      }
    }
  }
  // rustc uses the last matching mapping, so more specific prefixes go last.
  return [...mappings].sort(([a], [b]) => a.length - b.length).map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
}

function nativePrefixes(args) {
  return [...new Set(args.map(arg => arg.slice('--remap-path-prefix='.length, arg.lastIndexOf('='))))];
}

export function assertNativeReleasePaths(options, platform = process.platform) {
  // MSVC's trim option stops at '=' rather than consuming that path component.
  // Fail before compilation instead of publishing a partially trimmed username.
  if (platform === 'win32' && nativePrefixes(releaseRemapArgs(options)).some(prefix => prefix.includes('='))) {
    throw new Error('Windows release builds require checkout, user home and Cargo home paths without "=" for native compiler path privacy. Use build directories without that character.');
  }
}

export function nativeCompilerEnvironment(env, remapArgs, platform = process.platform) {
  const result = { ...env };
  if (platform !== 'win32') return result;
  const read = name => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] || '';
  const set = (name, value) => {
    for (const key of Object.keys(result)) if (key.toUpperCase() === name) delete result[key];
    result[name] = value;
  };
  // CL has its own Windows argument parser. Preserve caller flags and quote
  // each added argument, including trailing slashes, spaces and Unicode.
  const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  const flags = [...new Set(nativePrefixes(remapArgs).map(prefix => prefix.replaceAll('/', '\\')))]
    .sort((a, b) => b.length - a.length)
    .map(prefix => quote(`/d1trimfile:${prefix}\\`)).join(' ');
  set('CL', [read('CL'), flags].filter(Boolean).join(' '));
  // cc-rs tracks CFLAGS/CXXFLAGS but not CL. An inert define tracks the effective
  // CL options so existing native dependencies rebuild when this policy changes,
  // while unchanged Rust dependencies and caller flag parsing remain reusable.
  const fingerprint = createHash('sha256').update(JSON.stringify([result.CL, read('_CL_')])).digest('hex').slice(0, 16);
  for (const name of ['CFLAGS', 'CXXFLAGS']) {
    set(name, [read(name), `/DCCGUI_RELEASE_C_PATHS_${fingerprint}`].filter(Boolean).join(' '));
  }
  return result;
}

export function prepareReleaseCompiler({ root, artifacts, env = process.env }) {
  const args = releaseRemapArgs({ root, env });
  const source = fileURLToPath(new URL('./release-rustc-wrapper.rs', import.meta.url));
  const originalWrapper = env.RUSTC_WRAPPER ?? env.CARGO_BUILD_RUSTC_WRAPPER;
  const digest = createHash('sha256').update(fs.readFileSync(source)).update(JSON.stringify([args, originalWrapper || ''])).digest('hex').slice(0, 24);
  const buildDir = path.resolve(root, 'src-tauri', 'target', 'release-private-build', digest);
  const relative = path.relative(path.resolve(root), buildDir);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid release intermediate directory');
  let ancestor = buildDir;
  while (true) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Release intermediate directory must not use symbolic links or junctions');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  fs.mkdirSync(buildDir, { recursive: true });
  const destination = path.join(artifacts, 'release-compiler', digest, process.platform === 'win32' ? 'release-rustc-wrapper.exe' : 'release-rustc-wrapper');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Reuse the identical executable; preparation must not perturb its metadata.
  if (!fs.existsSync(destination)) {
    const temporary = `${destination}.${process.pid}.tmp`;
    const result = spawnSync(env.RUSTC || env.CARGO_BUILD_RUSTC || 'rustc', ['--crate-name', 'ccgui_release_rustc_wrapper', source, '-o', temporary, '--remap-path-scope=object', ...args], {
      cwd: root, env: { ...env }, encoding: 'utf8', windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      fs.rmSync(temporary, { force: true });
      throw new Error('Release compiler wrapper compilation failed. Use Rust 1.95+ and install the platform linker/build tools.');
    }
    fs.renameSync(temporary, destination);
  }
  const buildEnv = { ...nativeCompilerEnvironment(env, args), RUSTC_WRAPPER: destination, CARGO_BUILD_BUILD_DIR: buildDir, [REMAP_ENV]: args.join(SEPARATOR) };
  delete buildEnv[ORIGINAL_WRAPPER_ENV];
  if (originalWrapper) buildEnv[ORIGINAL_WRAPPER_ENV] = originalWrapper;
  return buildEnv;
}
