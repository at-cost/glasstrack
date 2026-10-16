import { sql } from "kysely";
import type { Db } from "../db";
import { logger } from "../lib/logger";

/**
 * Cookie-less page view counter for the public site. Per UTC day it keeps only
 * the path and, for visits from another site, that site's host name. No IP
 * address, cookie, user agent or full referrer is ever stored. Counts are kept
 * in memory and flushed to page_views once a minute and on shutdown.
 */

const BOT = /bot|crawl|spider|slurp|scrape|fetch|preview|monitor|uptime|lighthouse|headless|phantom|curl|wget|python|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;
const MAX_KEYS = 5000;

export function isBot(userAgent: string | undefined): boolean {
  return !userAgent || BOT.test(userAgent);
}

/** The referring site's host, only when it is another site. Everything but the host is dropped. */
export function referrerHost(referer: string | undefined, ownHost: string): string {
  if (!referer) return "";
  try {
    const u = new URL(referer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === ownHost.toLowerCase().replace(/^www\./, "")) return "";
    return host.slice(0, 253);
  } catch {
    return "";
  }
}

export class PageViewCounter {
  private counts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  count(path: string, refHost: string, day = new Date().toISOString().slice(0, 10)) {
    const key = `${day}\u0000${path}\u0000${refHost}`;
    if (!this.counts.has(key) && this.counts.size >= MAX_KEYS) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  get pending(): number {
    return this.counts.size;
  }

  start(db: Db, everyMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(db), everyMs);
    this.timer.unref();
  }

  async flush(db: Db): Promise<void> {
    if (this.counts.size === 0) return;
    const batch = this.counts;
    this.counts = new Map();
    const rows = [...batch].map(([k, views]) => {
      const [day, path, ref] = k.split("\u0000") as [string, string, string];
      return { day, path, ref, views };
    });
    try {
      await sql`INSERT INTO page_views (day, path, referrer_host, views)
        SELECT * FROM unnest(${rows.map((r) => r.day)}::date[], ${rows.map((r) => r.path)}::text[], ${rows.map((r) => r.ref)}::text[], ${rows.map((r) => r.views)}::int[])
        ON CONFLICT (day, path, referrer_host) DO UPDATE SET views = page_views.views + EXCLUDED.views`.execute(db);
    } catch (err) {
      logger.warn({ err }, "page view flush failed");
    }
  }

  async stop(db: Db) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(db);
  }
}

/** One counter per process. */
export const pageViews = new PageViewCounter();
