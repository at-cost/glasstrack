import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RealtimeEvent } from "@glasstrack/shared";
import { type AppEnv, requireUser } from "../context";
import { enterWorkspace } from "../db/tenant";

/**
 * GET /api/v1/w/:slug/events: Server-Sent Events. Membership is checked in a
 * short transaction; the stream itself holds no database connection.
 */
export const realtimeRoutes = new Hono<AppEnv>().get("/events", async (c) => {
  const user = requireUser(c);
  const deps = c.get("deps");
  const ws = await deps.dbs.app.transaction().execute((trx) => enterWorkspace(trx, user.id, c.req.param("slug")!));
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    const queue: RealtimeEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = deps.hub.subscribe(ws.id, user.id, (e) => {
      queue.push(e);
      wake?.();
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (open) {
      if (queue.length === 0) {
        // Heartbeat every 25s keeps proxies from closing idle connections.
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 25_000).unref();
        });
        wake = null;
        if (queue.length === 0 && open) await stream.writeSSE({ event: "ping", data: "{}" });
        continue;
      }
      const batch = queue.splice(0, queue.length);
      await stream.writeSSE({ event: "change", data: JSON.stringify(batch) });
    }
    unsubscribe();
  });
});
