import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));

// Check the policy boundary rather than one exact serialized CSP. Unknown
// sources fail closed, including host wildcards and scheme-wide HTTP grants.
function directives(): Map<string, string[]> {
  const csp = config.app.security.csp;
  assert.equal(typeof csp, "string", "the packaged app must have a CSP");
  const result = new Map<string, string[]>();
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (!name) continue;
    assert.equal(result.has(name), false, `duplicate ${name} could hide a weaker policy`);
    result.set(name, sources);
  }
  return result;
}

function localOnly(name: string, sources: string[], allowed: ReadonlySet<string>): void {
  assert.ok(sources.length > 0, `${name} must restrict resource loading`);
  for (const source of sources) {
    assert.ok(allowed.has(source), `${name} permits an unexpected source: ${source}`);
  }
}

test("packaged scripts cannot execute remote or inline payloads", () => {
  const policy = directives();
  const localScripts = new Set(["'none'", "'self'", "blob:"]);
  const defaults = policy.get("default-src") ?? [];
  localOnly("default-src", defaults, new Set(["'none'", "'self'"]));
  const scripts = policy.get("script-src") ?? defaults;
  localOnly("script-src", scripts, localScripts);
  // More specific directives must not reopen the script-src boundary.
  localOnly("script-src-elem", policy.get("script-src-elem") ?? scripts, localScripts);
  localOnly("script-src-attr", policy.get("script-src-attr") ?? scripts, localScripts);
  assert.ok(scripts.includes("'self'"), "bundled application scripts must load");
  assert.ok(scripts.includes("blob:"), "local plugin module blobs must load");
});

test("packaged images cannot contact remote beacon endpoints", () => {
  const policy = directives();
  const images = policy.get("img-src") ?? policy.get("default-src") ?? [];
  const localImages = new Set([
    "'none'", "'self'", "data:", "blob:", "asset:",
    "http://asset.localhost", "https://asset.localhost",
  ]);
  localOnly("img-src", images, localImages);
  for (const source of ["'self'", "data:", "blob:", "asset:", "http://asset.localhost"]) {
    assert.ok(images.includes(source), `local image attachments require ${source}`);
  }
});

test("privacy policy retains local IPC and bundled or uploaded fonts", () => {
  const policy = directives();
  const connections = policy.get("connect-src") ?? [];
  localOnly("connect-src", connections, new Set([
    "'none'", "'self'", "ipc:", "http://ipc.localhost", "https://ipc.localhost",
  ]));
  for (const source of ["'self'", "ipc:", "http://ipc.localhost"]) {
    assert.ok(connections.includes(source), `application IPC requires ${source}`);
  }
  const fonts = policy.get("font-src") ?? [];
  localOnly("font-src", fonts, new Set(["'none'", "'self'", "data:", "blob:"]));
  for (const source of ["'self'", "data:"]) {
    assert.ok(fonts.includes(source), `local fonts require ${source}`);
  }
});

test("embedded documents and form navigation cannot bypass request grants", () => {
  const policy = directives();
  for (const name of ["object-src", "frame-src", "base-uri", "form-action"]) {
    assert.deepEqual(policy.get(name), ["'none'"], `${name} must not reopen a remote request path`);
  }
});

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(filename);
    return /\.(?:tsx?|jsx?|rs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
      ? [filename]
      : [];
  });
}

test("production startup and native IPC expose no Baidu script or beacon path", () => {
  for (const relative of ["src/lib/analytics.ts", "src-tauri/src/baidu_tongji.rs"]) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} must stay removed`);
  }
  // Scan both sides of the IPC boundary: removing only bootstrap or only the
  // command registration would leave the other execution/transport path alive.
  const forbidden = /hm\.baidu\.com|baidu[-_]?tongji|daa60bcc45c658ee35054b93be3cf2e4|\b_hmt\b/i;
  for (const filename of [
    ...productionSources(path.join(root, "src")),
    ...productionSources(path.join(root, "src-tauri/src")),
  ]) {
    assert.doesNotMatch(readFileSync(filename, "utf8"), forbidden, path.relative(root, filename));
  }
  assert.doesNotMatch(
    readFileSync(path.join(root, "src/bootstrap.tsx"), "utf8"),
    /(?:from\s*|import\s*\()\s*["'][^"']*\/analytics["']/,
    "startup must not defer loading the removed analytics module",
  );
});

function assertNoSourceHints(allowedRoot: string, filename: string): void {
  const canonicalRoot = realpathSync(allowedRoot);
  const visited = new Set<string>();
  const walk = (candidate: string): void => {
    assert.notEqual(path.basename(candidate), "default-source-root.txt", "remove the local source hint before packaging");
    const actual = realpathSync(candidate);
    const relative = path.relative(canonicalRoot, actual);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
      "bundled resources must not link outside the checkout");
    assert.notEqual(path.basename(actual), "default-source-root.txt", "remove the local source hint before packaging");
    if (!statSync(actual).isDirectory() || visited.has(actual)) return;
    visited.add(actual);
    for (const entry of readdirSync(actual, { withFileTypes: true })) walk(path.join(actual, entry.name));
  };
  walk(filename);
}

test("resource privacy checks follow internal links and reject external directories and hints", t => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ccgui-resource-privacy-"));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(scratch));
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    rmSync(scratch, { recursive: true, force: true });
  });
  const checkout = path.join(scratch, "checkout");
  const assets = path.join(checkout, "assets");
  const outside = path.join(scratch, "outside");
  mkdirSync(assets, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(assets, "ok.txt"), "bundled fixture");
  writeFileSync(path.join(outside, "default-source-root.txt"), "synthetic source hint");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const insideLink = path.join(checkout, "inside-link");
  const outsideLink = path.join(checkout, "outside-link");
  symlinkSync(assets, insideLink, linkType);
  symlinkSync(outside, outsideLink, linkType);
  assert.doesNotThrow(() => assertNoSourceHints(checkout, insideLink));
  assert.throws(() => assertNoSourceHints(checkout, outsideLink), /must not link outside/);
  writeFileSync(path.join(assets, "default-source-root.txt"), "synthetic source hint");
  assert.throws(() => assertNoSourceHints(checkout, insideLink), /remove the local source hint/);
});

test("machine-local source hints stay untracked and outside distributable resources", () => {
  const hint = "default-source-root.txt";
  const tracked = spawnSync("git", ["ls-files", "-z", "--", `*${hint}`], { cwd: root, encoding: "utf8" });
  assert.equal(tracked.status, 0, "Git must be available to check the source hint boundary");
  assert.equal(tracked.stdout, "", "machine-local source hints must never be tracked");

  const copies = [hint, `public/${hint}`, `src-tauri/resources/skills/${hint}`];
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root, input: `${copies.join("\n")}\n`, encoding: "utf8",
  });
  assert.equal(ignored.status, 0);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/), copies);

  // Git ignore alone cannot stop Vite/Tauri from copying an untracked file.
  for (const relative of ["public", "dist"]) {
    const directory = path.join(root, relative);
    if (existsSync(directory)) assertNoSourceHints(root, directory);
  }
  const custom = JSON.parse(readFileSync(path.join(root, ".custom/tauri.json"), "utf8"));
  for (const settings of [config, custom]) {
    const resources = settings.bundle?.resources ?? {};
    for (const source of Array.isArray(resources) ? resources : Object.keys(resources)) {
      const directory = path.resolve(root, "src-tauri", source);
      const relative = path.relative(root, directory);
      assert.ok(!path.isAbsolute(source) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
        "bundled resources must come from the checkout, not a user profile");
      assertNoSourceHints(root, directory);
    }
  }
});
