import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNativeReleasePaths, nativeCompilerEnvironment, prepareReleaseCompiler, releaseRemapArgs, REMAP_ENV, ORIGINAL_WRAPPER_ENV } from './release-compiler.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-compiler-'));
  t.after(() => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('ccgui-compiler-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const home = path.join(base, 'synthetic home 用户');
  const root = path.join(home, 'source project=源码');
  fs.mkdirSync(root, { recursive: true });
  return { root, artifacts: path.join(base, 'artifacts'), env: { ...process.env, HOME: home, USERPROFILE: home, CARGO_HOME: path.join(home, '.cargo') } };
}

test('mapping rejects unsafe prefixes and orders specific paths last', t => {
  const options = fixture(t);
  const args = releaseRemapArgs(options);
  assert.ok(args.at(-1).endsWith('=/ccgui-source'));
  assert.ok(args.some(arg => arg.endsWith('=/ccgui-cargo')));
  for (const root of [path.parse(options.root).root, `${options.root}\x1fbad`, 'relative-source']) {
    assert.throws(() => releaseRemapArgs({ ...options, root }), /Invalid release path mapping/);
  }
});

test('Windows native path privacy rejects MSVC partial-prefix trimming', t => {
  const options = fixture(t);
  assert.throws(() => assertNativeReleasePaths(options, 'win32'), /paths without "="/);
  const safe = { ...options, root: path.join(options.env.HOME, 'native source 用户') };
  assert.doesNotThrow(() => assertNativeReleasePaths(safe, 'win32'));
  for (const key of ['USERPROFILE', 'CARGO_HOME']) {
    const invalid = path.join(options.env.HOME, 'private=name');
    const env = { ...safe.env, [key]: invalid, ...(key === 'USERPROFILE' ? { HOME: invalid } : {}) };
    assert.throws(() => assertNativeReleasePaths({ ...safe, env }, 'win32'), /paths without "="/);
  }
});

test('native compiler flags preserve caller parsing and track CL changes for Cargo', t => {
  const options = fixture(t);
  const args = releaseRemapArgs(options);
  const env = { cl: '/DKEEP_CL', _CL_: '/DKEEP_POST', cflags: '/O1 /IC:\\fixture', CXXFLAGS: '/EHsc', CC_SHELL_ESCAPED_FLAGS: '0' };
  const original = { ...env };
  const actual = nativeCompilerEnvironment(env, args, 'win32');
  assert.deepEqual(env, original);
  assert.ok(actual.CL.startsWith('/DKEEP_CL '));
  assert.match(actual.CL, /\/d1trimfile:/);
  assert.equal(actual.cl, undefined);
  assert.equal(actual._CL_, env._CL_);
  assert.ok(actual.CFLAGS.startsWith(`${env.cflags} /DCCGUI_RELEASE_C_PATHS_`));
  assert.ok(actual.CXXFLAGS.startsWith(`${env.CXXFLAGS} /DCCGUI_RELEASE_C_PATHS_`));
  assert.equal(actual.CC_SHELL_ESCAPED_FLAGS, '0');
  assert.equal(nativeCompilerEnvironment(env, args, 'win32').CFLAGS, actual.CFLAGS);
  assert.notEqual(nativeCompilerEnvironment({ ...env, _CL_: '/DCHANGED_POST' }, args, 'win32').CFLAGS, actual.CFLAGS);
  assert.deepEqual(nativeCompilerEnvironment(env, args, 'linux'), env);
});

test('MSVC removes Cargo header paths with spaces and Unicode while retaining user flags', { skip: process.platform !== 'win32' }, t => {
  const options = fixture(t);
  options.root = path.join(options.env.HOME, 'native source 用户');
  fs.mkdirSync(options.root, { recursive: true });
  fs.mkdirSync(options.env.CARGO_HOME, { recursive: true });
  assertNativeReleasePaths(options);
  const onPath = spawnSync('where.exe', ['cl.exe'], { encoding: 'utf8', windowsHide: true });
  let compiler = onPath.status === 0 ? onPath.stdout.trim().split(/\r?\n/)[0] : null;
  if (!compiler) {
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe'], { encoding: 'utf8', windowsHide: true });
    compiler = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null;
  }
  assert.ok(compiler, 'Windows release privacy checks require the MSVC C++ build tools');
  const header = path.join(options.env.CARGO_HOME, 'fixture-header.h');
  const source = path.join(options.env.CARGO_HOME, 'fixture.c');
  const output = path.join(options.root, 'fixture.obj');
  fs.writeFileSync(header, 'const char *fixture_source_path = __FILE__;\n');
  fs.writeFileSync(source, '#include "fixture-header.h"\n#if !defined(BASE_FIXTURE) || !defined(POST_FIXTURE) || !defined(C_FLAG_FIXTURE)\n#error caller flags were lost\n#endif\n');
  const env = nativeCompilerEnvironment({ ...options.env, CL: '/DBASE_FIXTURE', _CL_: '/DPOST_FIXTURE', CFLAGS: '/DC_FLAG_FIXTURE' }, releaseRemapArgs(options));
  const result = spawnSync(compiler, ['/nologo', '/utf-8', '/c', '/FC', ...env.CFLAGS.split(' '), `/Fo${output}`, source], { cwd: options.root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'native fixture compilation preserves caller defines');
  assert.doesNotMatch(result.stdout + result.stderr, /D9002/, 'the compiler must recognize privacy options');
  const strings = fs.readFileSync(output).toString('utf8').split('\0');
  assert.deepEqual(strings.filter(value => value.endsWith('fixture-header.h')), ['fixture-header.h']);
});

test('wrapper compilation errors are sanitized', t => {
  const options = fixture(t);
  options.env.RUSTC = path.join(options.root, 'missing-private-compiler');
  assert.throws(() => prepareReleaseCompiler(options), { message: 'Release compiler wrapper compilation failed. Use Rust 1.95+ and install the platform linker/build tools.' });
});

test('real compiler preserves flags, paths, wrapper chaining, and exit status', t => {
  const options = fixture(t);
  const probe = spawnSync(process.env.RUSTC || 'rustc', ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, 'installed rustc must be available');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const compiler = path.join(probe.stdout.trim(), 'bin', `rustc${suffix}`);
  Object.assign(options.env, {
    RUSTC: compiler,
    RUSTFLAGS: '--cfg inherited_plain_flag',
    CARGO_ENCODED_RUSTFLAGS: '--cfg\x1finherited_encoded_flag',
    RUSTC_WORKSPACE_WRAPPER: 'workspace-wrapper-preserved',
  });
  delete options.env.RUSTC_WRAPPER;
  delete options.env.CARGO_BUILD_RUSTC_WRAPPER;
  const before = { ...options.env };
  const buildEnv = prepareReleaseCompiler(options);
  assert.ok(buildEnv.CARGO_BUILD_BUILD_DIR.startsWith(path.join(options.root, 'src-tauri', 'target', 'release-private-build') + path.sep));
  assert.equal(buildEnv.CARGO_TARGET_DIR, before.CARGO_TARGET_DIR);
  assert.equal(prepareReleaseCompiler(options).CARGO_BUILD_BUILD_DIR, buildEnv.CARGO_BUILD_BUILD_DIR);
  const changedHome = path.join(options.env.HOME, 'another-home');
  assert.notEqual(prepareReleaseCompiler({ ...options, env: { ...options.env, HOME: changedHome, USERPROFILE: changedHome } }).CARGO_BUILD_BUILD_DIR, buildEnv.CARGO_BUILD_BUILD_DIR);
  const aliasEnv = { ...options.env, CARGO_BUILD_RUSTC: compiler };
  delete aliasEnv.RUSTC;
  assert.equal(prepareReleaseCompiler({ ...options, env: aliasEnv }).CARGO_BUILD_BUILD_DIR, buildEnv.CARGO_BUILD_BUILD_DIR);
  assert.deepEqual(options.env, before);
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WORKSPACE_WRAPPER']) assert.equal(buildEnv[key], before[key]);
  assert.ok(buildEnv[REMAP_ENV]);
  assert.equal(buildEnv[ORIGINAL_WRAPPER_ENV], undefined);

  function compileAndRun(source, expected, wrapperEnv = buildEnv, sourceRoot = options.root) {
    fs.mkdirSync(sourceRoot, { recursive: true });
    const input = path.join(sourceRoot, 'test source 用户.rs');
    const output = path.join(options.artifacts, `program${suffix}`);
    fs.writeFileSync(input, source);
    const result = spawnSync(wrapperEnv.RUSTC_WRAPPER, [compiler, '--crate-name', 'fixture', input, '--cfg', 'explicit_flag', '-o', output], { env: wrapperEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'wrapped rustc compilation succeeds');
    const run = spawnSync(output, [], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim().replaceAll('\\', '/'), expected);
  }
  compileAndRun('#[cfg(not(explicit_flag))] compile_error!("lost flag"); fn main() { println!("{}", file!()); }', '/ccgui-source/test source 用户.rs');
  compileAndRun('fn main() { println!("{}", file!()); }', '/ccgui-user/test source 用户.rs', buildEnv, options.env.HOME);
  compileAndRun('fn main() { println!("{}", file!()); }', '/ccgui-cargo/test source 用户.rs', buildEnv, options.env.CARGO_HOME);

  // A native fixture plays both original and workspace wrappers, verifying the
  // compiler argument survives each level of Cargo's wrapper nesting.
  const originalSource = path.join(options.root, 'forward.rs');
  const original = path.join(options.artifacts, `forward${suffix}`);
  fs.writeFileSync(originalSource, 'use std::{env,process::{Command,exit}}; fn main(){ let mut a=env::args_os().skip(1); let c=a.next().unwrap(); let s=Command::new(c).args(a).arg("--cfg").arg("forwarded_flag").status().unwrap(); exit(s.code().unwrap_or(1)); }');
  assert.equal(spawnSync(compiler, [originalSource, '-o', original], { env: options.env, windowsHide: true }).status, 0);
  const chained = prepareReleaseCompiler({ ...options, env: { ...options.env, RUSTC_WRAPPER: original } });
  assert.equal(chained[ORIGINAL_WRAPPER_ENV], original);
  const aliasChained = prepareReleaseCompiler({ ...options, env: { ...aliasEnv, CARGO_BUILD_RUSTC_WRAPPER: original } });
  assert.equal(aliasChained[ORIGINAL_WRAPPER_ENV], original);
  assert.equal(aliasChained.CARGO_BUILD_BUILD_DIR, chained.CARGO_BUILD_BUILD_DIR);
  assert.notEqual(chained.CARGO_BUILD_BUILD_DIR, buildEnv.CARGO_BUILD_BUILD_DIR);
  compileAndRun('#[cfg(not(forwarded_flag))] compile_error!("lost wrapper"); fn main(){println!("chained");}', 'chained', chained);
  const workspaceOutput = path.join(options.artifacts, `workspace${suffix}`);
  const nested = spawnSync(chained.RUSTC_WRAPPER, [original, compiler, '--crate-name', 'fixture', originalSource, '-o', workspaceOutput], { env: chained, windowsHide: true });
  assert.equal(nested.status, 0, 'original and workspace wrappers chain successfully');
  const badSource = path.join(options.root, 'bad.rs');
  fs.writeFileSync(badSource, 'compile_error!("expected fixture failure"); fn main(){}');
  const directFailure = spawnSync(compiler, [badSource], { env: options.env, encoding: 'utf8', windowsHide: true });
  const wrappedFailure = spawnSync(chained.RUSTC_WRAPPER, [compiler, badSource], { env: chained, encoding: 'utf8', windowsHide: true });
  assert.notEqual(directFailure.status, 0);
  assert.equal(wrappedFailure.status, directFailure.status);
});

test('intermediate cache refuses junction ancestors', t => {
  const options = fixture(t);
  const outside = path.join(options.artifacts, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(options.root, 'src-tauri'));
  fs.symlinkSync(outside, path.join(options.root, 'src-tauri', 'target'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareReleaseCompiler(options), /must not use symbolic links or junctions/);
});

test('isolated Cargo intermediates remain reusable on a second build', t => {
  const options = fixture(t);
  const probe = spawnSync(process.env.RUSTC || 'rustc', ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const bin = path.join(probe.stdout.trim(), 'bin');
  options.env.RUSTC = path.join(bin, `rustc${suffix}`);
  options.env.CARGO_TARGET_DIR = path.join(options.root, 'target');
  for (const key of ['RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']) delete options.env[key];
  fs.writeFileSync(path.join(options.root, 'Cargo.toml'), '[package]\nname="release_cache_fixture"\nversion="0.1.0"\nedition="2021"\n');
  fs.mkdirSync(path.join(options.root, 'src'));
  fs.writeFileSync(path.join(options.root, 'src', 'main.rs'), 'fn main() { println!("fixture"); }');
  const cargo = path.join(bin, `cargo${suffix}`);
  const firstEnv = prepareReleaseCompiler(options);
  const first = spawnSync(cargo, ['build', '--offline'], { cwd: options.root, env: firstEnv, encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0, 'first isolated Cargo build succeeds');
  assert.match(first.stderr, /Compiling release_cache_fixture/);
  const secondEnv = prepareReleaseCompiler(options);
  assert.equal(secondEnv.CARGO_BUILD_BUILD_DIR, firstEnv.CARGO_BUILD_BUILD_DIR);
  const second = spawnSync(cargo, ['build', '--offline'], { cwd: options.root, env: secondEnv, encoding: 'utf8', windowsHide: true });
  assert.equal(second.status, 0, 'second isolated Cargo build succeeds');
  assert.doesNotMatch(second.stderr, /Compiling release_cache_fixture/);
  assert.ok(fs.existsSync(path.join(options.env.CARGO_TARGET_DIR, 'debug', `release_cache_fixture${suffix}`)));
});
