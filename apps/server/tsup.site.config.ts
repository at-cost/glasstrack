import { defineConfig } from "tsup";

/**
 * The public site's browser scripts (a few KB each), plus its static files
 * (fonts, screenshots, OG images) copied from src/site/public. Output goes to
 * dist/site/public, which the server serves with content-hashed URLs.
 */
export default defineConfig({
  entry: { "js/site": "src/site/client/site.ts", "js/calc": "src/site/client/calc.ts" },
  outDir: "dist/site/public",
  publicDir: "src/site/public",
  format: ["iife"],
  platform: "browser",
  target: "es2020",
  bundle: true,
  minify: true,
  sourcemap: false,
  clean: false,
  outExtension: () => ({ js: ".js" }),
});
