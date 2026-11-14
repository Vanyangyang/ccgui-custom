import assert from "node:assert/strict";
import { mkdir, readdir, writeFile, access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd(), port = Number(process.env.HOST_CONFIRMATION_PORT || 1433);
const output = path.join(cwd, ".artifacts/host-confirmation", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { port, output, checks: [], console: [], pageErrors: [], externalRequests: [], screenshots: [], cleanup: false };
let server, browser;
try {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(resolve)); });
  const modules = await readdir(path.join(cwd, "node_modules/.pnpm"));
  const installed = modules.find(name => name.startsWith("playwright-core@"));
  assert(installed, "Existing playwright-core dependency required; no installation attempted");
  const { chromium } = await import(pathToFileURL(path.join(cwd, "node_modules/.pnpm", installed, "node_modules/playwright-core/index.mjs")).href);
  const executable = process.env.HOST_CONFIRMATION_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  await access(executable);
  const esbuildPackage = modules.find(name => name.startsWith("esbuild@"));
  assert(esbuildPackage, "Existing esbuild dependency required");
  const { build } = await import(pathToFileURL(path.join(cwd, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild/lib/main.js")).href);
  const fixture = (await readFile(path.join(cwd, "tests/browser/host-confirmation.tsx"), "utf8")).replace('import "../../src/index.css";', "");
  const bundle = await build({ absWorkingDir: cwd, stdin: { contents: fixture, resolveDir: path.join(cwd, "tests/browser"), loader: "tsx" },
    alias: { "@": path.join(cwd, "src") }, bundle: true, format: "esm", platform: "browser", target: "es2022", jsx: "automatic", write: false,
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" } });
  const assets = path.join(cwd, "dist/assets"), assetNames = new Set(await readdir(assets));
  const cssFile = [...assetNames].find(name => /^index-.*\.css$/.test(name));
  assert(cssFile, "Run the production build first; verify its real theme stylesheet");
  report.stylesheet = cssFile;
  const css = await readFile(path.join(assets, cssFile));
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    const resource = pathname.endsWith("/host-confirmation.html") ? ["text/html", html]
      : pathname === "/app.js" ? ["text/javascript", bundle.outputFiles[0].text]
      : pathname === "/styles.css" ? ["text/css", css] : null;
    if (resource) { response.writeHead(200, { "content-type": resource[0] }); response.end(resource[1]); return; }
    const name = pathname.slice(1);
    if (assetNames.has(name) && !name.includes("/")) { response.writeHead(200); response.end(await readFile(path.join(assets, name))); return; }
    response.writeHead(pathname === "/favicon.ico" ? 204 : 404); response.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${port}/tests/browser/host-confirmation.html`;
  // Test only this loopback fixture; inherited system proxies must not route it.
  browser = await chromium.launch({ headless: true, executablePath: executable, args: ["--no-proxy-server"] });
  for (const dark of [false, true]) for (const [width, height] of [[380, 620], [760, 720]]) {
    const name = `${dark ? "dark" : "light"}-${width}`;
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(60_000);
    page.on("console", msg => { if (["error", "warning"].includes(msg.type())) report.console.push({ name, text: msg.text() }); });
    page.on("pageerror", error => report.pageErrors.push({ name, error: String(error) }));
    page.on("request", request => { if (!request.url().startsWith(`http://127.0.0.1:${port}/`) && !request.url().startsWith("data:")) report.externalRequests.push(request.url()); });
    const visit = async (long = false) => {
      await page.goto(`${url}?dark=${Number(dark)}&long=${Number(long)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByRole("button", { name: "取消", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消");
    };
    const layout = async () => {
      const result = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]'), footer = document.querySelector("footer").getBoundingClientRect();
        return { background: getComputedStyle(dialog).backgroundColor, text: getComputedStyle(dialog).color,
          border: getComputedStyle(document.querySelector("header")).borderBottomColor,
          right: footer.right, bottom: footer.bottom, top: footer.top, width: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth };
      });
      assert.notEqual(result.background, "rgba(0, 0, 0, 0)"); assert.notEqual(result.background, "transparent");
      assert.notEqual(result.border, result.text, "Separators must use the theme border token, not default currentColor");
      assert(result.top >= 0 && result.bottom <= height + 1 && result.right <= width + 1, JSON.stringify(result));
      assert(result.width <= width + 1 && result.bodyWidth <= width + 1, JSON.stringify(result));
      return result;
    };
    await visit();
    const collapsed = await layout();
    await page.getByRole("button", { name: "历史摘要 · 点击展开", exact: true }).click();
    await page.getByRole("heading", { name: "合成摘要 🧭", exact: true }).waitFor();
    assert.equal(await page.locator("main img, main a, main script").count(), 0);
    assert((await page.locator("pre code").count()) > 0);
    assert((await page.locator("table").count()) > 0);
    await page.waitForTimeout(250);
    const expanded = await layout();
    const screenshot = path.join(output, `${name}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    await page.getByRole("button", { name: "待发原文 · 点击展开", exact: true }).click();
    await page.waitForTimeout(250); await layout();
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(() => window.confirmationFixture.calls), [false]);
    await visit(); await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.confirmationFixture.calls), [false]);
    await visit(); await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.confirmationFixture.calls), [true]);
    await visit(true); await layout();
    report.checks.push({ name, collapsed, expanded, keyboard: "Escape and default Enter deny; Tab + Enter accepts exactly once", longMessage: "footer visible with 1,500-character message" });
    await page.close();
  }
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  assert.equal(report.console.length, 0, JSON.stringify(report.console));
  assert.equal(report.externalRequests.length, 0, JSON.stringify(report.externalRequests));
  report.passed = true;
} catch (error) { report.passed = false; report.failure = String(error.stack || error); process.exitCode = 1; }
finally {
  if (!report.passed && browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    const screenshot = path.join(output, "failure.png"); await page.screenshot({ path: screenshot }).catch(() => {}); report.screenshots.push(screenshot);
  }
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.cleanup = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
