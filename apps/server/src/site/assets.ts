import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";

/**
 * Static files for the public site: fonts, screenshots, OG images and the small
 * browser scripts. The build (tsup.site.config.ts) bundles the scripts and copies
 * src/site/public into dist/site/public. Files are read once at startup and served
 * from memory with a content hash in the URL (?v=), so they can be cached for a year.
 */

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
  hash: string;
}

function candidates(): string[] {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  return [
    process.env.SITE_PUBLIC_DIR ?? "",
    // Bundled server: dist/index.js (or a chunk beside it) -> dist/site/public
    here("./site/public"),
    // Running from source (tsx, vitest): src/site/assets.ts -> apps/server/dist/site/public
    here("../../dist/site/public"),
  ].filter(Boolean);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function load(): Map<string, Asset> {
  const files = new Map<string, Asset>();
  const roots = candidates().filter((d) => existsSync(join(d, "js")));
  // Source images are always available from src, even before the first site build.
  const srcPublic = fileURLToPath(new URL("./public", import.meta.url));
  const dirs = [...roots.slice(0, 1), ...(existsSync(srcPublic) ? [srcPublic] : [])];
  if (roots.length === 0) logger.warn("site scripts not built: run `pnpm --filter @glasstrack/server build:site`");
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const rel = relative(dir, file).split(sep).join("/");
      if (files.has(rel)) continue;
      const type = TYPES[extname(file)];
      if (!type) continue;
      const body = new Uint8Array(readFileSync(file));
      files.set(rel, { body, type, hash: createHash("sha256").update(body).digest("hex").slice(0, 10) });
    }
  }
  return files;
}

let cache: Map<string, Asset> | null = null;
export function assets(): Map<string, Asset> {
  cache ??= load();
  return cache;
}

/** Versioned URL for a site file, e.g. /site/js/site.js?v=ab12cd34ef. */
export function assetUrl(path: string): string {
  const a = assets().get(path);
  return a ? `/site/${path}?v=${a.hash}` : `/site/${path}`;
}

export const hasAsset = (path: string) => assets().has(path);
