import { createReadStream } from "node:fs";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal streaming ustar writer: enough for exports (regular files only).
 * Sizes must be known up front, which they are (DB rows and stored objects).
 */
function header(name: string, size: number, mtime: Date): Buffer {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      base = base.slice(-90);
    }
  }
  const field = (s: string, off: number, len: number) => h.write(s, off, len, "utf8");
  const oct = (n: number, off: number, len: number) => field(n.toString(8).padStart(len - 1, "0") + "\0", off, len);
  field(base, 0, 100);
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  if (size >= 8 ** 11) {
    // GNU base-256 for files over 8 GiB
    h[124] = 0x80;
    let v = BigInt(size);
    for (let i = 135; i > 124; i--) {
      h[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  } else oct(size, 124, 12);
  oct(Math.floor(mtime.getTime() / 1000), 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

function write(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.write(chunk)) resolve();
    else {
      out.once("drain", resolve);
      out.once("error", reject);
    }
  });
}

export class TarWriter {
  constructor(private out: Writable) {}

  async addBuffer(name: string, data: Buffer | string, mtime = new Date()) {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    await write(this.out, header(name, buf.length, mtime));
    await write(this.out, buf);
    await this.pad(buf.length);
  }

  async addStream(name: string, size: number, stream: Readable, mtime = new Date()) {
    await write(this.out, header(name, size, mtime));
    let written = 0;
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      const take = b.subarray(0, Math.max(0, size - written));
      if (take.length) await write(this.out, take);
      written += take.length;
    }
    // Object shorter than recorded: zero-fill to keep the archive valid.
    if (written < size) await write(this.out, Buffer.alloc(size - written));
    await this.pad(size);
  }

  async addFile(name: string, path: string, size: number) {
    await this.addStream(name, size, createReadStream(path));
  }

  private async pad(size: number) {
    const rem = size % 512;
    if (rem) await write(this.out, Buffer.alloc(512 - rem));
  }

  async finish() {
    await write(this.out, Buffer.alloc(1024));
    await new Promise<void>((resolve, reject) => {
      this.out.once("error", reject);
      this.out.end(resolve);
    });
  }
}

export interface TarEntry {
  /** Name inside the archive (never used as a local path). */
  name: string;
  size: number;
  /** Where the entry was extracted (a generated name in `dir`), or "" when its body was skipped. */
  path: string;
}

export interface ExtractOptions {
  maxEntries?: number;
  /** Total bytes of all entries, including metadata. */
  maxBytes?: number;
  /** Return false to skip writing an entry's body (it is still read and counted). */
  keep?: (name: string) => boolean;
}

const META_LIMIT = 64 * 1024;

/**
 * Extracts every regular file in a .tar.gz into `dir` under generated names
 * (entry-0, entry-1, ...), so nothing in the archive can choose where it is
 * written. Understands ustar prefixes, GNU long names and pax path headers.
 * Rejects malformed headers (bad checksum or size), oversized metadata,
 * archives over the limits and truncated archives.
 */
export async function extractTarGz(file: string, dir: string, opts: ExtractOptions = {}): Promise<TarEntry[]> {
  const maxEntries = opts.maxEntries ?? 100_000;
  const maxBytes = opts.maxBytes ?? 50 * 1024 ** 3;
  const { createReadStream: open, createWriteStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  const pathMod = await import("node:path");
  const entries: TarEntry[] = [];
  let buf = Buffer.alloc(0);
  type Body = { kind: "body"; remaining: number; pad: number; out: import("node:fs").WriteStream | null; collect: Buffer[] | null; type: string };
  let state: { kind: "header" } | Body = { kind: "header" };
  let longName: string | null = null;
  let total = 0;
  const bad = (why: string) => new Error(`Not a valid export archive: ${why}`);
  const parseSize = (h: Buffer) => {
    if (h[124]! & 0x80) {
      if (h[124] !== 0x80) throw bad("negative entry size");
      let v = 0n;
      for (let i = 125; i < 136; i++) v = (v << 8n) | BigInt(h[i]!);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw bad("entry size too large");
      return Number(v);
    }
    const raw = h.subarray(124, 136).toString("ascii").replace(/[\0 ]+$/, "").trim();
    if (!/^[0-7]*$/.test(raw)) throw bad("malformed entry size");
    return raw ? Number.parseInt(raw, 8) : 0;
  };
  const checksumOk = (h: Buffer) => {
    const stored = h.subarray(148, 156).toString("ascii").replace(/[\0 ]+$/, "").trim();
    if (!/^[0-7]+$/.test(stored)) return false;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    return sum === Number.parseInt(stored, 8);
  };
  const str = (h: Buffer, off: number, len: number) => h.subarray(off, off + len).toString("utf8").replace(/\0.*$/s, "");
  const closeOut = (out: import("node:fs").WriteStream) => new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  const writeOut = (out: import("node:fs").WriteStream, chunk: Buffer) =>
    new Promise<void>((res, rej) => (out.write(chunk, (e) => (e ? rej(e) : res()))));
  let ended = false;
  for await (const chunk of open(file).pipe(createGunzip())) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    for (;;) {
      if (ended) break;
      if (state.kind === "header") {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) {
          ended = true;
          break;
        }
        if (!checksumOk(h)) throw bad("header checksum mismatch");
        const type = String.fromCharCode(h[156] || 48);
        const size = parseSize(h);
        total += size;
        if (total > maxBytes) throw bad("larger than the allowed size");
        const prefix = str(h, 345, 155);
        let name = str(h, 0, 100);
        if (prefix) name = `${prefix}/${name}`;
        if (longName) {
          name = longName;
          longName = null;
        }
        const pad = (512 - (size % 512)) % 512;
        const isFile = type === "0" || type === "\0" || type === "7";
        const isMeta = type === "L" || type === "x";
        if (isMeta && size > META_LIMIT) throw bad("oversized name header");
        let out: import("node:fs").WriteStream | null = null;
        if (isFile) {
          if (entries.length >= maxEntries) throw bad("too many files");
          const keep = opts.keep ? opts.keep(name) : true;
          const target = keep ? pathMod.join(dir, `entry-${entries.length}`) : "";
          if (keep) out = createWriteStream(target);
          entries.push({ name, size, path: target });
        }
        state = { kind: "body", remaining: size, pad, out, collect: isMeta ? [] : null, type };
      } else {
        const take = Math.min(state.remaining, buf.length);
        if (take > 0) {
          const part = buf.subarray(0, take);
          if (state.out) await writeOut(state.out, Buffer.from(part));
          else if (state.collect) state.collect.push(Buffer.from(part));
          buf = buf.subarray(take);
          state.remaining -= take;
        }
        if (state.remaining > 0) break;
        if (buf.length < state.pad) break;
        buf = buf.subarray(state.pad);
        if (state.out) await closeOut(state.out);
        if (state.collect) {
          const meta = Buffer.concat(state.collect).toString("utf8");
          if (state.type === "L") longName = meta.replace(/\0.*$/s, "");
          else {
            const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(meta);
            if (m) longName = m[1]!;
          }
        }
        state = { kind: "header" };
      }
    }
    if (ended) break;
  }
  if (state.kind === "body") {
    if (state.out) await closeOut(state.out);
    throw bad("the file ends in the middle of an entry (truncated download?)");
  }
  if (!ended) throw bad("the file ends before the end of the archive (truncated download?)");
  return entries;
}
