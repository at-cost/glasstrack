import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IssueDetail, TimeEntry } from "@glasstrack/shared";
import { Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { Avatar } from "../../components/icons";
import { api, errorMessage, type RunningTimer } from "../../lib/api";
import { formatDueDate, todayISO } from "../../lib/format";
import { keys, useMembers, useTimeEntries } from "../../lib/queries";
import { formatElapsed, formatMinutes, parseDuration, useNow } from "../../lib/time";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

/** Start and stop your timer, with optimistic updates to the issue and the shell pill. */
export function useTimerControls() {
  const { slug } = useWs();
  const qc = useQueryClient();
  const refresh = (issueId?: string) => {
    qc.invalidateQueries({ queryKey: keys.timer(slug) });
    qc.invalidateQueries({ queryKey: keys.issueAll(slug) });
    if (issueId) {
      qc.invalidateQueries({ queryKey: keys.timeEntries(slug, issueId) });
      qc.invalidateQueries({ queryKey: keys.activity(slug, issueId) });
    }
  };
  const setDetailTimer = (startedAt: string | null, issueId?: string) => {
    qc.setQueriesData<IssueDetail>({ queryKey: keys.issueAll(slug) }, (d) => {
      if (!d || !("myTimerStartedAt" in d)) return d;
      if (d.id === issueId) return { ...d, myTimerStartedAt: startedAt };
      // Only one timer runs per person: starting one stops the others.
      return startedAt && d.myTimerStartedAt ? { ...d, myTimerStartedAt: null } : d;
    });
  };
  const start = useMutation({
    mutationFn: (issue: Pick<IssueDetail, "id" | "identifier" | "title">) => api.ws(slug).startTimer(issue.id),
    onMutate: async (issue) => {
      await qc.cancelQueries({ queryKey: keys.timer(slug) });
      const prev = qc.getQueryData(keys.timer(slug));
      const startedAt = new Date().toISOString();
      const next: RunningTimer = { issueId: issue.id, identifier: issue.identifier, title: issue.title, startedAt };
      qc.setQueryData(keys.timer(slug), next);
      setDetailTimer(startedAt, issue.id);
      return { prev };
    },
    onSuccess: (r) => {
      if (r.stopped) toast(`Logged ${formatMinutes(r.stopped.minutes)} on the issue you were timing`, "success");
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(keys.timer(slug), ctx?.prev);
      toastError(errorMessage(e));
    },
    onSettled: (r, _e, issue) => {
      refresh(issue.id);
      if (r?.stopped) refresh(r.stopped.issueId);
    },
  });
  const stop = useMutation({
    mutationFn: () => api.ws(slug).stopTimer(),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: keys.timer(slug) });
      const prev = qc.getQueryData<RunningTimer | null>(keys.timer(slug));
      qc.setQueryData(keys.timer(slug), null);
      setDetailTimer(null, prev?.issueId);
      return { prev };
    },
    onSuccess: (entry) => toast(`Logged ${formatMinutes(entry.minutes)}`, "success"),
    onError: (e, _v, ctx) => {
      qc.setQueryData(keys.timer(slug), ctx?.prev);
      toastError(errorMessage(e));
    },
    onSettled: (entry, _e, _v) => refresh(entry?.issueId),
  });
  return { start, stop };
}

export function TimeSection({ issue }: { issue: IssueDetail }) {
  const { slug, me, canEdit, isAdmin, workspace } = useWs();
  const qc = useQueryClient();
  const members = useMembers(slug);
  const entries = useTimeEntries(slug, issue.id);
  const { start, stop } = useTimerControls();
  const running = Boolean(issue.myTimerStartedAt);
  const now = useNow(running);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);
  const canTrack = canEdit && workspace.role !== "guest";

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.timeEntries(slug, issue.id) });
    qc.invalidateQueries({ queryKey: keys.issue(slug, issue.identifier) });
    qc.invalidateQueries({ queryKey: keys.activity(slug, issue.id) });
  };
  const listKey = keys.timeEntries(slug, issue.id);
  const setTotal = (delta: number) =>
    qc.setQueryData<IssueDetail>(keys.issue(slug, issue.identifier), (d) =>
      d ? { ...d, timeSpentMinutes: Math.max(0, d.timeSpentMinutes + delta) } : d,
    );

  const log = useMutation({
    mutationFn: (b: { minutes: number; spentOn: string; note?: string }) => api.ws(slug).logTime(issue.id, b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: listKey });
      const prev = qc.getQueryData<TimeEntry[]>(listKey);
      const temp: TimeEntry = {
        id: `temp-${Date.now()}`,
        issueId: issue.id,
        userId: me.id,
        spentOn: b.spentOn,
        minutes: b.minutes,
        note: b.note ?? null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<TimeEntry[]>(listKey, (l) => [temp, ...(l ?? [])]);
      setTotal(b.minutes);
      return { prev, minutes: b.minutes };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(listKey, ctx?.prev);
      if (ctx) setTotal(-ctx.minutes);
      toastError(errorMessage(e));
    },
    onSettled: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ id, b }: { id: string; b: { minutes: number; spentOn: string; note: string } }) => api.ws(slug).updateTime(id, b),
    onMutate: async ({ id, b }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const prev = qc.getQueryData<TimeEntry[]>(listKey);
      const old = prev?.find((e) => e.id === id);
      qc.setQueryData<TimeEntry[]>(listKey, (l) => l?.map((e) => (e.id === id ? { ...e, ...b, note: b.note || null } : e)));
      const delta = old ? b.minutes - old.minutes : 0;
      setTotal(delta);
      return { prev, delta };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(listKey, ctx?.prev);
      if (ctx) setTotal(-ctx.delta);
      toastError(errorMessage(e));
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (entry: TimeEntry) => api.ws(slug).deleteTime(entry.id),
    onMutate: async (entry) => {
      await qc.cancelQueries({ queryKey: listKey });
      const prev = qc.getQueryData<TimeEntry[]>(listKey);
      qc.setQueryData<TimeEntry[]>(listKey, (l) => l?.filter((e) => e.id !== entry.id));
      setTotal(-entry.minutes);
      return { prev };
    },
    onError: (e, entry, ctx) => {
      qc.setQueryData(listKey, ctx?.prev);
      setTotal(entry.minutes);
      toastError(errorMessage(e));
    },
    onSettled: refresh,
  });

  const memberOf = (id: string | null) => members.data?.find((m) => m.userId === id);
  const elapsed = issue.myTimerStartedAt ? now - new Date(issue.myTimerStartedAt).getTime() : 0;

  return (
    <section className="detail-section" aria-labelledby="time-title">
      <div className="section-head">
        <h2 className="section-title" id="time-title">
          Time <span className="group-count">{issue.timeSpentMinutes > 0 ? formatMinutes(issue.timeSpentMinutes) : "None logged"}</span>
        </h2>
        {canTrack && (
          <div className="inline-form">
            {running ? (
              <button type="button" className="btn btn-sm btn-timer on" onClick={() => stop.mutate()} disabled={stop.isPending}>
                <Square size={12} aria-hidden="true" fill="currentColor" />
                Stop timer
                <span className="timer-elapsed">{formatElapsed(elapsed)}</span>
              </button>
            ) : (
              <button type="button" className="btn btn-sm btn-timer" onClick={() => start.mutate(issue)} disabled={start.isPending}>
                <Play size={12} aria-hidden="true" fill="currentColor" />
                Start timer
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={logging} onClick={() => setLogging((v) => !v)}>
              <Plus size={13} aria-hidden="true" />
              Log time
            </button>
          </div>
        )}
      </div>
      {logging && (
        <TimeForm
          submitLabel="Log time"
          onCancel={() => setLogging(false)}
          onSubmit={(b) => {
            log.mutate(b);
            setLogging(false);
          }}
        />
      )}
      {(entries.data?.length ?? 0) > 0 && (
        <ul className="time-list">
          {entries.data!.map((e) => {
            const who = memberOf(e.userId);
            const mine = e.userId === me.id;
            const pending = e.id.startsWith("temp-");
            if (editing === e.id) {
              return (
                <li key={e.id}>
                  <TimeForm
                    initial={e}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={(b) => {
                      edit.mutate({ id: e.id, b: { minutes: b.minutes, spentOn: b.spentOn, note: b.note ?? "" } });
                      setEditing(null);
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={e.id} className={`time-row${pending ? " pending" : ""}`}>
                <Avatar member={who ?? { name: "Former member", avatarUrl: null }} size={20} />
                <span className="time-who">{who?.name ?? "Former member"}</span>
                <span className="time-mins">{formatMinutes(e.minutes)}</span>
                <span className="time-date muted small">{formatDueDate(e.spentOn)}</span>
                <span className="time-note muted small">{e.note}</span>
                {canTrack && (mine || isAdmin) && !pending && (
                  <span className="edit-actions">
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Edit ${formatMinutes(e.minutes)} entry`}
                      onClick={() => setEditing(e.id)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Delete ${formatMinutes(e.minutes)} entry`}
                      onClick={() => setDeleting(e)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete time entry?"
          message={`${formatMinutes(deleting.minutes)} on ${formatDueDate(deleting.spentOn)} will be removed.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function TimeForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: TimeEntry;
  submitLabel: string;
  onSubmit: (b: { minutes: number; spentOn: string; note?: string }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [duration, setDuration] = useState(initial ? formatMinutes(initial.minutes) : "");
  const [spentOn, setSpentOn] = useState(initial?.spentOn ?? todayISO());
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const durationRef = useRef<HTMLInputElement>(null);
  useEffect(() => durationRef.current?.focus(), []);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const minutes = parseDuration(duration);
    if (!minutes) return setError('Enter a time like "1h 30m" or "90".');
    if (minutes > 1440) return setError("One entry can be at most 24 hours.");
    if (!spentOn) return setError("Pick a date.");
    onSubmit({ minutes, spentOn, note: note.trim() || undefined });
  };
  return (
    <form className="time-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-d`}>
          Time spent
        </label>
        <input
          id={`${id}-d`}
          className="input input-sm"
          placeholder="1h 30m"
          value={duration}
          ref={durationRef}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            setDuration(e.target.value);
            setError(null);
          }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-date`}>
          Date
        </label>
        <input
          id={`${id}-date`}
          className="input input-sm"
          type="date"
          value={spentOn}
          max="2100-12-31"
          onChange={(e) => setSpentOn(e.target.value)}
        />
      </div>
      <div className="field grow">
        <label className="field-label" htmlFor={`${id}-n`}>
          Note
        </label>
        <input
          id={`${id}-n`}
          className="input input-sm"
          value={note}
          maxLength={500}
          placeholder="Optional"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="time-form-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary">
          {submitLabel}
        </button>
      </div>
      {error && (
        <p className="form-error time-form-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
