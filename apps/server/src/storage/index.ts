import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";
import type { Config } from "../config";

export interface UploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface Storage {
  uploadTarget(key: string, contentType: string, size: number): Promise<UploadTarget>;
  downloadUrl(key: string, filename: string): Promise<string>;
  /** body: in-memory bytes, or a local file streamed with a known size. */
  put(key: string, body: Buffer | { path: string; size: number }, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

const TTL_SECONDS = 15 * 60;

// ─── local disk ───

export interface FileToken {
  key: string;
  op: "get" | "put";
  exp: number;
  filename?: string;
  contentType?: string;
  size?: number;
}

export function signFileToken(secret: string, t: FileToken): string {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyFileToken(secret: string, token: string): FileToken | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const t = JSON.parse(Buffer.from(body, "base64url").toString()) as FileToken;
  if (t.exp < Date.now() / 1000) return null;
  return t;
}

export function localStorage(config: Config): Storage & { pathFor(key: string): string } {
  const root = path.resolve(config.STORAGE_LOCAL_DIR);
  const pathFor = (key: string) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error("invalid storage key");
    return p;
  };
  const exp = () => Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const base = `${config.APP_URL.replace(/\/$/, "")}/api/v1/files/`;
  return {
    pathFor,
    async uploadTarget(key, contentType, size) {
      const token = signFileToken(config.APP_SECRET, { key, op: "put", exp: exp(), contentType, size });
      return { method: "PUT", url: base + token, headers: { "content-type": contentType } };
    },
    async downloadUrl(key, filename) {
      return base + signFileToken(config.APP_SECRET, { key, op: "get", exp: exp(), filename });
    },
    async put(key, body) {
      const p = pathFor(key);
      await mkdir(path.dirname(p), { recursive: true });
      await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : createReadStream(body.path), createWriteStream(p));
    },
    async get(key) {
      return createReadStream(pathFor(key));
    },
    async size(key) {
      try {
        return (await stat(pathFor(key))).size;
      } catch {
        return null;
      }
    },
    async delete(key) {
      await unlink(pathFor(key)).catch(() => undefined);
    },
    async deletePrefix(prefix) {
      await rm(pathFor(prefix), { recursive: true, force: true });
    },
  };
}

// ─── S3-compatible (AWS S3, MinIO, R2, Hetzner) ───

export function s3Storage(config: Config): Storage {
  const client = new AwsClient({
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
    service: "s3",
  });
  const endpoint = (config.S3_ENDPOINT || `https://s3.${config.S3_REGION}.amazonaws.com`).replace(/\/$/, "");
  const objectUrl = (key: string) => {
    const k = key.split("/").map(encodeURIComponent).join("/");
    if (config.S3_FORCE_PATH_STYLE || config.S3_ENDPOINT) return `${endpoint}/${config.S3_BUCKET}/${k}`;
    const u = new URL(endpoint);
    return `${u.protocol}//${config.S3_BUCKET}.${u.host}/${k}`;
  };
  const bucketUrl = () => {
    if (config.S3_FORCE_PATH_STYLE || config.S3_ENDPOINT) return `${endpoint}/${config.S3_BUCKET}`;
    const u = new URL(endpoint);
    return `${u.protocol}//${config.S3_BUCKET}.${u.host}`;
  };
  const presign = async (url: string, method: string, headers: Record<string, string> = {}) => {
    const u = new URL(url);
    u.searchParams.set("X-Amz-Expires", String(TTL_SECONDS));
    const signed = await client.sign(u.toString(), { method, headers, aws: { signQuery: true } });
    return signed.url;
  };
  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`S3 ${what} failed: ${res.status} ${await res.text()}`);
    return res;
  };
  return {
    async uploadTarget(key, contentType) {
      return {
        method: "PUT",
        url: await presign(objectUrl(key), "PUT", { "content-type": contentType }),
        headers: { "content-type": contentType },
      };
    },
    async downloadUrl(key, filename) {
      const u = new URL(objectUrl(key));
      u.searchParams.set("response-content-disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
      return presign(u.toString(), "GET");
    },
    async put(key, body, contentType) {
      // Single PUT (S3 limit 5 GB). Files are streamed, never buffered whole.
      const init: RequestInit & { duplex?: "half" } = Buffer.isBuffer(body)
        ? { method: "PUT", body: new Uint8Array(body), headers: { "content-type": contentType } }
        : {
            method: "PUT",
            body: Readable.toWeb(createReadStream(body.path)) as unknown as BodyInit,
            duplex: "half",
            headers: {
              "content-type": contentType,
              "content-length": String(body.size),
              "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
          };
      await check(await client.fetch(objectUrl(key), init), "put");
    },
    async get(key) {
      const res = await check(await client.fetch(objectUrl(key)), "get");
      return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    },
    async size(key) {
      const res = await client.fetch(objectUrl(key), { method: "HEAD" });
      if (!res.ok) return null;
      return Number(res.headers.get("content-length") ?? 0);
    },
    async delete(key) {
      await client.fetch(objectUrl(key), { method: "DELETE" });
    },
    async deletePrefix(prefix) {
      for (;;) {
        const res = await check(
          await client.fetch(`${bucketUrl()}?list-type=2&prefix=${encodeURIComponent(prefix)}`),
          "list",
        );
        const keys = [...(await res.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
        if (keys.length === 0) return;
        for (const k of keys) await this.delete(k.replace(/&amp;/g, "&"));
      }
    },
  };
}

export function createStorage(config: Config): Storage {
  return config.STORAGE_DRIVER === "s3" ? s3Storage(config) : localStorage(config);
}

/** Every key for a workspace lives under this prefix, so deletion is one call. */
export const workspacePrefix = (workspaceId: string) => `w/${workspaceId}/`;

export async function listLocalFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
}
