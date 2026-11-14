import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@openuidev/react-lang": path.resolve(__dirname, "./node_modules/@openuidev/react-lang/dist/index.native.mjs"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Files that never touch browser globals opt out with `// @vitest-environment node`;
    // jsdom setup costs about a second per file.
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
