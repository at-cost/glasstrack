import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeEvent } from "@glasstrack/shared";
import { useEffect } from "react";
import { invalidateFor } from "./queries";

/** Subscribes to the workspace event stream and refreshes matching queries. */
export function useRealtime(slug: string, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let stopped = false;
    let readyOnce = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource(`/api/v1/w/${encodeURIComponent(slug)}/events`);
      es.addEventListener("ready", () => {
        // After a reconnect, refetch what may have changed while we were away.
        if (readyOnce) {
          for (const k of ["issues", "issue", "comments", "activity", "notifications", "unread"]) {
            qc.invalidateQueries({ queryKey: [k, slug] });
          }
        }
        readyOnce = true;
      });
      es.addEventListener("change", (ev) => {
        try {
          const events = JSON.parse((ev as MessageEvent).data) as RealtimeEvent[];
          invalidateFor(qc, slug, events);
        } catch {
          // ignore malformed payloads
        }
      });
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          es.close();
          retry = setTimeout(open, 5000);
        }
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [slug, enabled, qc]);
}
