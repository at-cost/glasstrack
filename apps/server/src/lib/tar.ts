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
