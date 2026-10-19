import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
