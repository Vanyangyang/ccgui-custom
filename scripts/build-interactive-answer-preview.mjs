import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(project, "package.json"));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
const tailwind = (await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href)).default;
const outDir = path.join(project, "artifacts/interactive-answer/preview-bundle");

await build({
  root: project,
  configFile: false,
  base: "./",
  plugins: [react(), tailwind()],
  resolve: { alias: {
    "@": path.join(project, "src"),
    "@openuidev/react-lang": path.join(project, "node_modules/@openuidev/react-lang/dist/index.native.mjs"),
  } },
  build: {
    outDir,
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: path.join(project, "tests/browser/interactive-answer.html"), output: { inlineDynamicImports: true } },
  },
});

const htmlPath = path.join(outDir, "tests/browser/interactive-answer.html");
let html = readFileSync(htmlPath, "utf8");
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, href) =>
  `<script type="module">${readFileSync(path.resolve(path.dirname(htmlPath), href), "utf8").replaceAll("</script", "<\\/script")}</script>`);
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) =>
  `<style>${readFileSync(path.resolve(path.dirname(htmlPath), href), "utf8")}</style>`);
html = html.replace(/<link rel="modulepreload"[^>]*>/g, "");
const finalPath = path.join(project, "artifacts/interactive-answer/gpt-interactive-preview.html");
writeFileSync(finalPath, html);
console.log(`离线预览已生成：${finalPath}`);
