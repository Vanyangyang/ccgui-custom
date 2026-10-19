// Build the two real native-fixture pages once, then serve without HMR.
import { build, preview } from "vite";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const config = {
  root,
  configFile: resolve(root, "vite.config.ts"),
  build: {
    target: "esnext",
    outDir: resolve(root, ".artifacts/native-notices-fixture/frontend"),
    emptyOutDir: false,
    rollupOptions: { input: [resolve(root, "tests/browser/assistant-notices-native.html"), resolve(root, "index.html")] },
  },
  preview: { host: "127.0.0.1", port: 5175, strictPort: true },
};
if (!process.argv.includes("--serve")) await build(config);
const server = await preview(config);
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.httpServer.close();
  process.exit(0);
});
