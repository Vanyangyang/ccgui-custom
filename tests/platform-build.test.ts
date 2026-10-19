import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Linux release installs the GBM development library before linking", () => {
  const workflow = read(".github/workflows/release.yml");
  const linuxJob = workflow.split("  build_linux:")[1].split("  build_windows:")[0];
  assert.match(linuxJob, /sudo apt-get install[^\n]*\blibgbm-dev\b/);
});

test("Windows MSVC embeds the manifest for library tests as well as the application", () => {
  const build = read("src-tauri/build.rs");
  assert.match(build, /CARGO_CFG_TARGET_OS/);
  assert.match(build, /CARGO_CFG_TARGET_ENV/);
  assert.match(build, /new_without_app_manifest\(\)/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFEST:EMBED/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFESTINPUT:/);
  assert.match(build, /cargo:rerun-if-changed=/);
  assert.doesNotMatch(build, /rustc-link-arg-(?:bins|tests)=/);
  const manifest = read("src-tauri/windows-app-manifest.xml");
  assert.match(manifest, /name="Microsoft.Windows.Common-Controls"/);
  assert.match(manifest, /version="6\.0\.0\.0"/);
  assert.match(manifest, /processorArchitecture="\*"/);
  assert.match(manifest, /publicKeyToken="6595b64144ccf1df"/);
});

test("Both Windows workflows continue to execute Rust library tests", () => {
  for (const path of [".github/workflows/release.yml", ".github/workflows/build-windows-artifact.yml"]) {
    const workflow = read(path);
    assert.match(workflow, /run: cargo test --manifest-path src-tauri\/Cargo\.toml --lib/);
    assert.doesNotMatch(workflow, /continue-on-error: true/);
  }
});

// Packaged builds apply their CSP plus a build step that tags every inline
// <style>/<script> in index.html with a __TAURI_*_NONCE__ token (tauri-codegen
// inject_nonce_token) and appends the nonce to the matching directive at
// runtime (tauri replace_csp_nonce). A nonce cancels 'unsafe-inline' in the
// same directive, so a single inline <style> in index.html makes the webview
// refuse every stylesheet created at runtime — plugin styles.css bundles and
// ctx.theme.injectCss included — with no JS error to surface. v1.0.9 shipped
// the boot splash inline and silently lost all plugin styling in packaged
// builds only (dev is unaffected: the dev HTML never gets the token). Keep
// boot assets external and 'unsafe-inline' in style-src.
test("index.html keeps boot assets external so Tauri's CSP nonce can't disable runtime-injected plugin CSS", () => {
  // Comments may name the tags they forbid; only real elements count.
  const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(html, /<style[\s>]/, "inline <style> would nonce style-src and block every plugin stylesheet");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "inline <script> would nonce script-src");
  assert.match(html, /<link rel="stylesheet" href="\/boot\.css"\s*\/?>/, "boot.css must be linked");
  assert.match(read("public/boot.css"), /#boot-splash\b/);
  assert.match(read("src-tauri/tauri.conf.json"), /style-src 'self' 'unsafe-inline'/, "plugin runtime CSS relies on style-src 'unsafe-inline'");
});
