/**
 * Fixed-window in-process limiter. Correct for the single-process deployment
 * target; swap for a Postgres-backed limiter if several app containers run.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private sweep: NodeJS.Timeout;

  constructor(
    private limit: number,
    private windowMs: number,
  ) {
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }, windowMs).unref();
  }

  /** Returns seconds to wait, or 0 if allowed. */
  take(key: string): number {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    cur.count++;
    if (cur.count > this.limit) return Math.ceil((cur.resetAt - now) / 1000);
    return 0;
  }

  reset() {
    this.hits.clear();
  }

  stop() {
    clearInterval(this.sweep);
  }
}
