import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM with a key derived from APP_SECRET. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
const key = (appSecret: string, purpose: string) => createHash("sha256").update(`${purpose}:${appSecret}`).digest();

export function seal(appSecret: string, purpose: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(appSecret, purpose), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function open(appSecret: string, purpose: string, sealed: string): string {
  const [v, iv, tag, enc] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Unrecognised sealed value");
  const d = createDecipheriv("aes-256-gcm", key(appSecret, purpose), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}
