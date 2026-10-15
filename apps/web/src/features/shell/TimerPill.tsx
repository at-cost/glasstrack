import { Link } from "@tanstack/react-router";
import { Square } from "lucide-react";
import { paths } from "../../lib/paths";
import { useTimer } from "../../lib/queries";
import { formatElapsed, useNow } from "../../lib/time";
import { useTimerControls } from "../issue/TimeSection";
import { useWs } from "./context";

/** Shows your running timer: issue key and elapsed time, a link to the issue and a stop button. */
export function TimerPill({ compact = false }: { compact?: boolean }) {
  const { slug } = useWs();
  const timer = useTimer(slug);
  const t = timer.data;
  const now = useNow(Boolean(t));
  const { stop } = useTimerControls();
  if (!t) return null;
  const elapsed = formatElapsed(now - new Date(t.startedAt).getTime());
  return (
    <div className={`timer-pill${compact ? " compact" : ""}`} title="Your running timer">
      <span className="timer-dot" aria-hidden="true" />
      <Link
        to={paths.issue(slug, t.identifier)}
        className="timer-link"
        title={t.title}
        aria-label={`Timer running on ${t.identifier}, ${elapsed}. Open the issue`}
      >
        <span className="timer-key">{t.identifier}</span>
        <span className="timer-elapsed">{elapsed}</span>
      </Link>
      <button
        type="button"
        className="icon-btn small"
        aria-label={`Stop timer on ${t.identifier}`}
        onClick={() => stop.mutate()}
        disabled={stop.isPending}
      >
        <Square size={11} fill="currentColor" />
      </button>
    </div>
  );
}
