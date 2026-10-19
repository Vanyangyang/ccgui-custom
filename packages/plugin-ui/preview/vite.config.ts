import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 视觉验证页（不进产物、不发包）：用宿主完整 index.css 编译出真实
 * token（含 .dark 翻转），并排渲染 plugin-ui 全部组件的亮/暗形态。
 * 从仓库根跑：pnpm exec vite build --config packages/plugin-ui/preview/vite.config.ts
 */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
