import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { ApiError, notFound } from "../lib/errors";
import { localStorage, verifyFileToken } from ".";

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

/** Signed-URL file transfer for the local-disk storage driver. */
export const fileRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const deps = c.get("deps");
    const t = verifyFileToken(deps.config.APP_SECRET, c.req.param("token"));
    if (!t || t.op !== "get") throw notFound("Link expired");
    const p = localStorage(deps.config).pathFor(t.key);
    const info = await stat(p).catch(() => null);
    if (!info) throw notFound("File not found");
    const filename = (t.filename ?? path.basename(t.key)).replace(/["\r\n]/g, "");
    const ext = path.extname(filename).toLowerCase();
    const type =
      { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain" }[ext] ??
      "application/octet-stream";
    const disposition = INLINE_TYPES.has(type) ? "inline" : "attachment";
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, {
      headers: {
        "content-type": type,
        "content-length": String(info.size),
        "content-disposition": `${disposition}; filename="${encodeURIComponent(filename)}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=600",
      },
    });
  })
  .put("/:token", async (c) => {
    const deps = c.get("deps");
    const t = verifyFileToken(deps.config.APP_SECRET, c.req.param("token"));
    if (!t || t.op !== "put") throw notFound("Upload link expired");
    const max = t.size ?? 0;
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, "empty", "Empty upload");
    const p = localStorage(deps.config).pathFor(t.key);
    await mkdir(path.dirname(p), { recursive: true });
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > max) cb(new ApiError(413, "too_large", "File is larger than declared"));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), limit, createWriteStream(p));
    } catch (e) {
      await unlink(p).catch(() => undefined);
      throw e;
    }
    return c.body(null, 204);
  });
