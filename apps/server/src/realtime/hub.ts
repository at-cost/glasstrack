import type pg from "pg";
import type { RealtimeEvent } from "@tracker/shared";
import { logger } from "../lib/logger";

type Listener = (e: RealtimeEvent) => void;

/**
 * One LISTEN connection per process. Mutations call pg_notify('ws_events')
 * inside their transaction, so events only fire after commit; the hub fans
 * them out to the SSE streams of that workspace.
 */
export class RealtimeHub {
  private listeners = new Map<string, Set<{ userId: string; fn: Listener }>>();
  private client: pg.PoolClient | null = null;
  private stopped = false;

  constructor(private pool: pg.Pool) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      this.client = client;
      client.on("notification", (msg) => this.dispatch(msg.payload));
      client.on("error", (err) => {
        logger.warn({ err }, "realtime listener lost, reconnecting");
        this.reconnect(client);
      });
      await client.query("LISTEN ws_events");
    } catch (err) {
      logger.error({ err }, "realtime listener failed to connect");
      if (!this.stopped) setTimeout(() => void this.connect(), 2000).unref();
    }
  }

  private reconnect(client: pg.PoolClient) {
    client.release(true);
    this.client = null;
    if (!this.stopped) setTimeout(() => void this.connect(), 1000).unref();
  }

  private dispatch(payload: string | undefined) {
    if (!payload) return;
    let msg: RealtimeEvent & { w: string };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const set = this.listeners.get(msg.w);
    if (!set) return;
    const { w: _w, ...event } = msg;
    for (const l of set) {
      // Personal events (notifications) go only to their recipient.
      if (event.userId && event.userId !== l.userId) continue;
      l.fn(event);
    }
  }

  subscribe(workspaceId: string, userId: string, fn: Listener): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) {
      set = new Set();
      this.listeners.set(workspaceId, set);
    }
    const entry = { userId, fn };
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0) this.listeners.delete(workspaceId);
    };
  }

  /** Drop every stream of one user in a workspace (removed member). */
  kick(workspaceId: string, userId: string) {
    const set = this.listeners.get(workspaceId);
    if (!set) return;
    for (const l of [...set]) if (l.userId === userId) set.delete(l);
  }

  get connectionCount(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      await this.client.query("UNLISTEN *").catch(() => undefined);
      this.client.release();
      this.client = null;
    }
  }
}
