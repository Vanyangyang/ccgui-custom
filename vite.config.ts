import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    // TEMP DEBUG: beacon endpoint for composer trigger diagnosis. Remove after.
    {
      name: "dbg-beacon",
      configureServer(server) {
        server.middlewares.use("/__dbg", (req, res) => {
          void import("node:fs").then((fs) =>
            fs.appendFileSync("/tmp/composer-dbg.log", new Date().toISOString() + " " + (req.url ?? "") + "\n"),
          );
          res.statusCode = 204;
          res.end();
        });
      },
    },
  ],
  resolve: {
    alias: {
      // Same React runtime exports, without OpenUI's automatic remote devtools loader.
      "@openuidev/react-lang": path.resolve(__dirname, "./node_modules/@openuidev/react-lang/dist/index.native.mjs"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: {
      // Sibling plugin repos (e.g. ../ccgui-plugin/usage-stats) are served in
      // dev so external plugins can be exercised without installing.
      allow: [".."],
    },
    watch: {
      ignored: ["**/src-tauri/**", "**/artifacts/**", "**/.artifacts/**"],
    },
  },
}));
