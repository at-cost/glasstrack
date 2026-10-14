import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Cycle } from "@tracker/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage } from "../../lib/api";
import { addDays, formatDateRange, todayISO } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useCycles, useIssues, useStates } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { cycleLabel } from "../issue/options";
import { PageHeader, useTeamByKey } from "../issues/pages";
import { useWs } from "../shell/context";

function isActive(c: Cycle): boolean {
  const t = todayISO();
  return !c.completedAt && c.startsOn <= t && c.endsOn >= t;
}

export function CyclesPage() {
  const { slug, canEdit, workspace } = useWs();
  const { team, loading } = useTeamByKey();
  const cycles = useCycles(slug);
  const states = useStates(slug);
  const issues = useIssues(slug, { team: team?.id, order: "manual" }, Boolean(team));
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Cycle | "new" | null>(null);
  const [deleting, setDeleting] = useState<Cycle | null>(null);
  const isGuest = workspace.role === "guest";

  const list = useMemo(
    () => (cycles.data ?? []).filter((c) => c.teamId === team?.id).sort((a, b) => b.number - a.number),
    [cycles.data, team],
  );
  const stats = useMemo(() => {
    const done = new Set((states.data ?? []).filter((s) => s.category === "completed" || s.category === "canceled").map((s) => s.id));
    const m = new Map<string, { total: number; done: number }>();
    for (const i of issues.data?.issues ?? []) {
      if (!i.cycleId) continue;
      const s = m.get(i.cycleId) ?? { total: 0, done: 0 };
      s.total++;
      if (done.has(i.statusId)) s.done++;
      m.set(i.cycleId, s);
    }
    return m;
  }, [issues.data, states.data]);

  const complete = useMutation({
    mutationFn: ({ c, completed }: { c: Cycle; completed: boolean }) => api.ws(slug).updateCycle(c.id, { completed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.cycles(slug) }),
    onError: (e) => toastError(errorMessage(e)),
  });
  const remove = async (c: Cycle) => {
    try {
      await api.ws(slug).deleteCycle(c.id);
      await qc.invalidateQueries({ queryKey: keys.cycles(slug) });
      qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
      toast("Cycle deleted", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  if (!team) return loading ? <Skeleton /> : <Empty title="Team not found">It may have been archived or renamed.</Empty>;
  return (
    <div className="page">
      <PageHeader title={`${team.name} cycles`}>
        {canEdit && !isGuest && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
            <Plus size={14} aria-hidden="true" />
            New cycle
          </button>
        )}
      </PageHeader>
      <div className="page-body">
        {cycles.isPending ? (
          <Skeleton rows={3} />
        ) : list.length === 0 ? (
          <Empty title="No cycles yet">Cycles are short time boxes. Create one to plan the next week or two.</Empty>
        ) : (
          <ul className="cycle-list">
            {list.map((c) => {
              const s = stats.get(c.id) ?? { total: 0, done: 0 };
              const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
              return (
                <li key={c.id} className={`cycle-row${c.completedAt ? " completed" : ""}`}>
                  <Link to={paths.teamIssues(slug, team.key)} search={{ cycle: c.id }} className="cycle-main">
                    <span className="cycle-name">
                      {cycleLabel(c)}
                      {isActive(c) && <span className="badge badge-accent">Active</span>}
                      {c.completedAt && <span className="badge">Completed</span>}
                    </span>
                    <span className="muted small">{formatDateRange(c.startsOn, c.endsOn)}</span>
                    <span className="cycle-progress">
                      <span className="progress">
                        <span className="progress-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="small">
                        {s.done}/{s.total} done
                      </span>
                    </span>
                  </Link>
                  {canEdit && !isGuest && (
                    <span className="cycle-actions">
                      <button type="button" className="btn btn-sm" onClick={() => complete.mutate({ c, completed: !c.completedAt })}>
                        {c.completedAt ? "Reopen" : "Complete"}
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Edit ${cycleLabel(c)}`} onClick={() => setEditing(c)}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Delete ${cycleLabel(c)}`} onClick={() => setDeleting(c)}>
                        <Trash2 size={14} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {editing && <CycleDialog teamId={team.id} cycle={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${cycleLabel(deleting)}?`}
          message="Issues in it stay, they just leave the cycle."
          confirmLabel="Delete cycle"
          danger
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CycleDialog({ teamId, cycle, onClose }: { teamId: string; cycle: Cycle | null; onClose: () => void }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const [name, setName] = useState(cycle?.name ?? "");
  const [startsOn, setStartsOn] = useState(cycle?.startsOn ?? todayISO());
  const [endsOn, setEndsOn] = useState(cycle?.endsOn ?? addDays(todayISO(), 13));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (endsOn < startsOn) return setError("The end date must be on or after the start date.");
    setBusy(true);
    try {
      if (cycle) await api.ws(slug).updateCycle(cycle.id, { name: name.trim(), startsOn, endsOn });
      else await api.ws(slug).createCycle(teamId, { name: name.trim() || undefined, startsOn, endsOn });
      await qc.invalidateQueries({ queryKey: keys.cycles(slug) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={cycle ? `Edit ${cycleLabel(cycle)}` : "New cycle"}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save()} disabled={busy}>
            {cycle ? "Save" : "Create cycle"}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor="cy-name">
            Name (optional)
          </label>
          <input id="cy-name" className="input" data-autofocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="cy-start">
              Starts
            </label>
            <input id="cy-start" className="input" type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cy-end">
              Ends
            </label>
            <input id="cy-end" className="input" type="date" required value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
