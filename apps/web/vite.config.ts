import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      // The public website is rendered by the API server.
      "^/(pricing|finances|finances\\.csv|about|how-its-run|self-host|terms|privacy|dpa|contact|status|sitemap\\.xml|robots\\.txt|og/.*|site/.*)?(\\?.*)?$": {
        target: "http://localhost:3100",
        changeOrigin: false,
      },
      "/api": {
        target: "http://localhost:3100",
        // Keep the Origin header as sent by the browser so the API CSRF check passes.
        changeOrigin: false,
        // The realtime stream stays open for a long time.
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (res) => {
            if (res.headers["content-type"]?.includes("text/event-stream")) {
              res.headers["cache-control"] = "no-cache";
              res.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
