import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexRust, releaseCfg, scanNativeBuildPaths } from './native-path-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crate(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-path-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, 'src-tauri/src', relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}
const macro = 'env!("CARGO_MANIFEST_DIR")';

test('lexing keeps offsets and ignores delimiters in comments and literals', () => {
  const source = `fn a<'a>(x: &'a str) { let c = '{'; let q = '\\''; let b = b'"'; let s = "}{"; let r = r#"}"#; } // {\n/* { /* } */ */ fn b() {}`;
  const { text, structure } = lexRust(source);
  assert.equal(text.length, source.length);
  assert.equal(structure.length, source.length);
  assert.equal(structure.split('{').length, structure.split('}').length);
  assert.match(text, /"\}\{"/);
  assert.doesNotMatch(text, /\/\//);
  assert.match(structure, /fn b\(\) \{\}/);
});

test('release cfg evaluation treats test, debug and test-harness code as excluded', () => {
  for (const predicate of ['test', 'debug_assertions', 'feature = "test-harness"', 'any(test, debug_assertions)', 'all(test, windows)', 'not(not(test))']) {
    assert.equal(releaseCfg(predicate), false, predicate);
  }
  assert.equal(releaseCfg('not(test)'), true);
  assert.equal(releaseCfg('windows'), null);
  assert.equal(releaseCfg('any(test, windows)'), null);
  assert.equal(releaseCfg('feature = "custom-protocol"'), null);
});

test('release modules embedding build paths are reported with file and line', t => {
  const root = crate(t, {
    'lib.rs': `pub mod leaky;\nmod quiet;\n#[path = "custom_impl.rs"]\nmod custom;\nmod outer {\n    pub mod deep;\n}\n`,
    'leaky.rs': `pub fn root() -> &'static str {\n    ${macro}\n}\npub fn out() -> Option<&'static str> { std::option_env!("OUT_DIR") }\n`,
    'quiet.rs': `pub const A: &str = "env!(\\"CARGO_MANIFEST_DIR\\")";\n// ${macro}\ninclude!(concat!(env!("OUT_DIR"), "/generated.rs"));\n`,
    'custom_impl.rs': `mod child;\n`,
    'child.rs': `pub fn f() -> &'static str { ${macro} }\n`,
    'outer/deep.rs': `pub fn g() -> &'static str { core::env!("CARGO_MANIFEST_PATH") }\n`,
  });
  assert.deepEqual(scanNativeBuildPaths(root).map(finding => `${finding.file}:${finding.line}`).sort(), [
    'src-tauri/src/child.rs:1',
    'src-tauri/src/leaky.rs:2',
    'src-tauri/src/leaky.rs:4',
    'src-tauri/src/outer/deep.rs:1',
  ]);
});

test('test-only and debug-only code may use build paths', t => {
  const root = crate(t, {
    'lib.rs': [
      'mod a;',
      '#[cfg(test)]',
      'mod tests;',
      '#[cfg(test)]',
      '#[path = "a_tests.rs"]',
      'mod path_tests;',
      '#[cfg(any(test, debug_assertions))]',
      `fn fallback() -> std::path::PathBuf { std::path::PathBuf::from(${macro}).join("resources") }`,
      'fn candidates(list: &mut Vec<std::path::PathBuf>) {',
      '    #[cfg(any(test, debug_assertions))]',
      `    list.push(std::path::PathBuf::from(${macro}));`,
      '    list.push(std::path::PathBuf::from("runtime"));',
      '}',
      'fn arm(x: u8) -> &\'static str {',
      '    match x {',
      `        #[cfg(feature = "test-harness")]`,
      `        0 => ${macro},`,
      '        _ => "runtime",',
      '    }',
      '}',
      '#[cfg(test)]',
      'mod inline_tests {',
      `    #[tokio::test(flavor = "multi_thread")]`,
      `    async fn t() { let _ = ${macro}; }`,
      '}',
      'mod nested {',
      '    #![cfg(test)]',
      `    fn n() -> &'static str { ${macro} }`,
      '}',
      '',
    ].join('\n'),
    'a.rs': `#[test]\nfn t() { let _ = ${macro}; }\n`,
    'tests.rs': `fn t() -> &'static str { ${macro} }\n`,
    'a_tests.rs': `fn t() -> &'static str { ${macro} }\n`,
  });
  assert.deepEqual(scanNativeBuildPaths(root), []);
});

test('a gated module file is skipped entirely and unresolved modules fail loudly', t => {
  const gatedFile = crate(t, { 'lib.rs': 'mod debug_only;\n', 'debug_only.rs': `#![cfg(debug_assertions)]\nfn f() -> &'static str { ${macro} }\n` });
  assert.deepEqual(scanNativeBuildPaths(gatedFile), []);
  const missing = crate(t, { 'lib.rs': 'mod absent;\n' });
  assert.throws(() => scanNativeBuildPaths(missing), /Cannot resolve Rust module absent/);
});

test('the repository release code embeds no compile-time build paths', () => {
  const findings = scanNativeBuildPaths(ROOT);
  assert.deepEqual(findings, [], `Resolve these paths at runtime or gate them to tests/debug builds:\n${findings.map(finding => `${finding.file}:${finding.line} ${finding.macro}`).join('\n')}`);
});
