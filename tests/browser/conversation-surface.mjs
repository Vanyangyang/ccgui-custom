// Run from the repository root: node tests/browser/conversation-surface.mjs
// Synthetic messages, production renderer, real Chrome layout; no native IPC.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const cwd = process.cwd();
const output = path.join(cwd, ".artifacts/conversation-surface", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { scope: "Chrome, production ConversationSurface, 1201 synthetic messages; no native IPC/models", checks: [], errors: [], cleanup: false };
let browser;
try {
  const modules = await readdir(path.join(cwd, "node_modules/.pnpm"));
  const dependency = (name, entry) => pathToFileURL(path.join(cwd, "node_modules/.pnpm", modules.find(item => item.startsWith(name + "@")), "node_modules", name, entry)).href;
  const { build } = await import(dependency("esbuild", "lib/main.js"));
  const { chromium } = await import(dependency("playwright-core", "index.mjs"));
  const bundle = await build({ absWorkingDir: cwd, entryPoints: ["tests/browser/conversation-surface.tsx"], alias: { "@": path.join(cwd, "src") },
    bundle: true, format: "esm", platform: "browser", target: "es2022", jsx: "automatic", write: false, outdir: "in-memory",
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "refuse-native", setup(build) {
      build.onResolve({ filter: /(?:^@\/lib\/transport$|^\.\/transport$)/ }, () => ({ path: "transport", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export const isWeb = false, webToken = null;
        export async function invoke(name) { throw Error("Forbidden fixture IPC: " + name); }
        export async function listen() { return () => {}; }
        export const initializeWorkerEvents = async () => {}, pauseWorkerEvents = async () => ({}), resumeWorkerEvents = async () => {}, getWorkerEventCursors = () => ({}), attachRunSources = async () => {}, disposeWebBridge = () => {}, serverVersion = async () => null;` }));
    } }],
  });
  const assets = path.join(cwd, "dist/assets");
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name));
  assert(cssName, "Build host stylesheet with pnpm build first");
  const css = await readFile(path.join(assets, cssName));
  const origin = "http://127.0.0.1:41762";
  browser = await chromium.launch({ headless: true, executablePath: process.env.CONVERSATION_SURFACE_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.errors.push(`External request: ${url.href}`); return route.abort(); }
    const resource = url.pathname === "/" ? ["text/html", '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/app.js"></script>']
      : url.pathname === "/app.js" ? ["text/javascript", bundle.outputFiles.find(file => file.path.endsWith(".js")).text] : url.pathname === "/style.css" ? ["text/css", css] : null;
    if (resource) return route.fulfill({ contentType: resource[0], body: resource[1] });
    const asset = path.basename(url.pathname);
    if (url.pathname === "/" + asset && (await readdir(assets)).includes(asset)) return route.fulfill({ body: await readFile(path.join(assets, asset)) });
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto(origin);
  await page.locator('[data-conversation-virtual]').waitFor();
  const settle = () => page.waitForTimeout(250);
  const metrics = () => page.evaluate(() => { const el = document.getElementById("viewport"); return { count: document.querySelectorAll("[data-conversation-segment]").length,
    top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, indices: [...document.querySelectorAll("[data-index]")].map(el => Number(el.dataset.index)) }; });
  const bound = async name => { await settle(); const value = await metrics(); assert(value.count < 45, `${name}: unbounded rows ${JSON.stringify(value)}`); report.checks.push({ name, ...value }); return value; };
  const end = async () => { await page.locator("#viewport").evaluate(el => { el.scrollTop = el.scrollHeight; }); await settle(); };
  const top = async () => { await page.locator("#viewport").evaluate(el => { el.scrollTop = 0; }); await settle(); };
  const index = async value => {
    // Scroll using observed row positions. Estimates converge as neighborhoods mount.
    for (let retry = 0; retry < 12; retry++) {
      if (await page.locator(`[data-index="${value}"]`).count()) {
        await page.locator(`[data-index="${value}"]`).evaluate(el => { const scroll = document.getElementById("viewport"); scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20; });
        await settle(); return;
      }
      await page.evaluate(target => {
        const scroll = document.getElementById("viewport");
        const visible = [...document.querySelectorAll("[data-index]")].filter(el => Number(el.dataset.index) !== 100);
        const nearest = visible.reduce((best, el) => Math.abs(Number(el.dataset.index) - target) < Math.abs(Number(best.dataset.index) - target) ? el : best);
        scroll.scrollTop += nearest.getBoundingClientRect().top - scroll.getBoundingClientRect().top + (target - Number(nearest.dataset.index)) * 96;
      }, value); await settle();
    }
    throw Error(`Unreachable row ${value}`);
  };
  if (process.argv.includes("--identity-only")) {
    report.scope = "Chrome, standalone physical-session identity isolation; 1201 synthetic messages, no native IPC/models";
    await page.evaluate(() => window.conversationFixture.identity("threadId", "thread-a"));
    for (const [field, value] of [["threadId", "thread-b"], ["sessionId", "native-b"], ["engine", "claude"], ["workspacePath", "G:/other"]]) {
      await index(300);
      const tool = page.locator('[data-index="300"] button[aria-expanded]');
      await tool.click();
      await index(100);
      const choice = page.getByRole("radio", { name: "Project A", exact: false });
      await choice.click();
      await choice.evaluate(el => { window.identityChoice = el; });
      await page.evaluate(() => window.conversationFixture.update("同会话流式更新中文😀", true)); await settle();
      assert.equal(await choice.getAttribute("aria-checked"), "true");
      assert(await choice.evaluate(el => el === window.identityChoice), "same session update remounted form");
      await index(300); assert.equal(await tool.getAttribute("aria-expanded"), "true");
      await page.evaluate(([field, value]) => window.conversationFixture.identity(field, value), [field, value]); await settle();
      assert.equal(await choice.getAttribute("aria-checked"), "false");
      assert(await choice.evaluate(el => el !== window.identityChoice), `${field}: reused another session's form`);
      await index(300); assert.equal(await tool.getAttribute("aria-expanded"), "false");
      await bound(`standalone ${field} switch resets form and tool; same-session updates retain state`);
    }
    assert.equal(await page.evaluate(() => window.conversationFixture.actions.length), 0);
  } else {
  await bound("initial bounded DOM");
  assert(await page.locator('[data-index="0"]').count(), "oldest row retained");
  await index(100);
  await page.getByRole("radio", { name: "Project A", exact: false }).click();
  await end(); await bound("bottom beyond old 1000-row cutoff");
  assert(await page.locator('[data-index="1200"]').count());
  await index(100);
  const submit = page.locator('[data-index="100"] button').filter({ hasText: /提交|Submit/ });
  await submit.click();
  assert.equal(await page.evaluate(() => window.conversationFixture.actions[0].answers["选择项目？"]), "Project A");
  await index(300);
  const tool = page.locator('[data-index="300"] button[aria-expanded]');
  await tool.click();
  await page.locator("#viewport").focus(); await top();
  assert.equal(await page.locator('[data-index="300"]').count(), 0, "expanded offscreen tool must actually unmount");
  await index(300);
  assert.equal(await tool.getAttribute("aria-expanded"), "true");
  assert((await page.locator('[data-index="300"] pre').allTextContents()).includes("完整工具结果-300👩🏽‍💻\n第二行"));
  await bound("tool disclosure survives virtual unmount");
  await index(600); await bound("long markdown row");
  assert(await page.locator('[data-index="600"] table').count());
  assert((await page.locator('[data-index="600"] pre code').textContent()).includes("末尾😀"));
  await page.locator('[data-index="600"] button').filter({ has: page.locator('svg.lucide-copy') }).last().evaluate(el => el.click());
  assert(await page.evaluate(() => window.conversationFixture.copied === window.conversationFixture.longText), "copy preserves raw long Markdown");
  await end();
  for (let chunk = 1; chunk <= 5; chunk++) {
    await page.evaluate(count => window.conversationFixture.update("流式中文👩🏽‍💻 **完整**\n\n".repeat(count * 15)), chunk);
    const value = await bound(`stream chunk ${chunk}`);
    assert(value.height - value.client - value.top < 2, `tail lost during streaming ${JSON.stringify(value)}`);
  }
  await top(); const before = (await metrics()).top;
  await page.evaluate(() => window.conversationFixture.update("最终完整中文😀", false));
  await bound("stream completion while reading history"); assert.equal((await metrics()).top, before);
  await page.locator("#prefix summary").click(); await bound("prefix disclosure shifts virtual origin");
  assert(await page.locator('[data-index="0"]').count());
  await page.evaluate(() => window.conversationFixture.prefix(false)); await bound("removed prefix releases layout observation");
  assert.equal(await page.locator("#prefix").count(), 0);
  assert(await page.locator('[data-index="0"]').count());
  await end(); assert((await page.locator('[data-index="1200"]').textContent()).includes("最终完整中文😀"));
  await page.evaluate(() => window.conversationFixture.append()); await bound("append at tail");
  assert(await page.locator('[data-index="1201"]').count());
  await index(300); await page.evaluate(() => window.conversationFixture.switchSource("source-b")); await settle();
  await index(300);
  assert.equal(await page.locator('[data-index="300"] button[aria-expanded]').getAttribute("aria-expanded"), "false");
  await page.setViewportSize({ width: 380, height: 620 }); await top(); await bound("narrow resized viewport and new source");
  await end(); await bound("narrow bottom reachable");
  assert(await page.locator('[data-index="1201"]').count());
  await page.evaluate(() => window.conversationFixture.threshold(79)); await top();
  assert.equal(await page.locator('[data-conversation-virtual]').count(), 0);
  const choice = page.getByRole("radio", { name: "Project B", exact: false });
  await choice.click();
  await choice.evaluate(el => { window.thresholdChoice = el; });
  await page.evaluate(() => window.conversationFixture.threshold(80)); await settle();
  assert.equal(await choice.getAttribute("aria-checked"), "true");
  assert(await choice.evaluate(el => el === window.thresholdChoice), "threshold must not remount pending form");
  await bound("79 to 80 messages retains pending form DOM and selection");
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error.stack ?? error); process.exitCode = 1; }
finally { if (browser) await browser.close(); report.cleanup = true; await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
