import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { type IssueFilter, PRIORITY_LABELS, type Priority, STATE_CATEGORIES } from "@tracker/shared";
import { ChevronDown, Save, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Avatar, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { type Option, PickerButton } from "../../components/Picker";
import { api, errorMessage } from "../../lib/api";
import { type FilterSearch, isEmptyFilter, readFilterSearch } from "../../lib/filters";
import { paths } from "../../lib/paths";
import { keys, useCycles, useLabels, useMembers, useStates } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useQueryClient } from "@tanstack/react-query";
import { cycleLabel, priorityOptions } from "../issue/options";
import { useWs } from "../shell/context";

export function useFilterSearch(): [FilterSearch, (patch: Partial<FilterSearch>) => void] {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const fs = useMemo(() => readFilterSearch(search), [search]);
  const set = (patch: Partial<FilterSearch>) => {
    navigate({
      to: pathname,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
        return next;
      },
      replace: true,
    });
  };
  return [fs, set];
}

const toggle = (csv: string | undefined, ids: string[]): string | undefined => {
  const cur = new Set(csv ? csv.split(",") : []);
  const allIn = ids.every((i) => cur.has(i));
  for (const i of ids) {
    if (allIn) cur.delete(i);
    else cur.add(i);
  }
  return cur.size ? [...cur].join(",") : undefined;
};

export function FilterBar({
  teamId,
  hide = [],
  savedFilter,
  layout,
  extra,
}: {
  teamId?: string;
  hide?: ("status" | "assignee" | "cycle")[];
  /** The full filter (base + URL) used when saving a view. */
  savedFilter: IssueFilter;
  layout: "list" | "board";
  extra?: React.ReactNode;
}) {
  const { slug, me, workspace } = useWs();
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const cycles = useCycles(slug);
  const [fs, setFs] = useFilterSearch();
  const [q, setQ] = useState(fs.q ?? "");
  const [saving, setSaving] = useState(false);
  const lastPushed = useRef(fs.q ?? "");
  const setFsRef = useRef(setFs);
  setFsRef.current = setFs;

  useEffect(() => {
    if ((fs.q ?? "") !== lastPushed.current) {
      lastPushed.current = fs.q ?? "";
      setQ(fs.q ?? "");
    }
  }, [fs.q]);
  useEffect(() => {
    if (q === lastPushed.current) return;
    const t = setTimeout(() => {
      lastPushed.current = q;
      setFsRef.current({ q: q.trim() || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Statuses: team ones, or merged by name across teams.
  const statusGroups = useMemo(() => {
    const list = (states.data ?? []).filter((s) => !teamId || s.teamId === teamId);
    const byName = new Map<string, { name: string; ids: string[]; state: (typeof list)[number] }>();
    for (const s of list) {
      const k = `${s.category}:${s.name}`;
      const g = byName.get(k);
      if (g) g.ids.push(s.id);
      else byName.set(k, { name: s.name, ids: [s.id], state: s });
    }
    return [...byName.entries()]
      .sort(
        (a, b) =>
          STATE_CATEGORIES.indexOf(a[1].state.category) - STATE_CATEGORIES.indexOf(b[1].state.category) ||
          a[1].state.position - b[1].state.position,
      )
      .map(([k, g]) => ({ key: k, ...g }));
  }, [states.data, teamId]);
  const statusSel = new Set(fs.status?.split(",") ?? []);
  const statusOptions: Option[] = statusGroups.map((g) => ({ id: g.key, label: g.name, icon: <StatusIcon state={g.state} /> }));
  const statusSelected = statusGroups.filter((g) => g.ids.every((i) => statusSel.has(i))).map((g) => g.key);

  const assigneeOpts: Option[] = [
    { id: "me", label: "Me", icon: <Avatar member={members.data?.find((m) => m.userId === me.id)} size={16} /> },
    { id: "none", label: "Unassigned", icon: <Avatar member={null} size={16} /> },
    ...(members.data ?? [])
      .filter((m) => m.userId !== me.id)
      .map((m) => ({ id: m.userId, label: m.name, hint: `@${m.handle}`, icon: <Avatar member={m} size={16} /> })),
  ];
  const labelOpts: Option[] = (labels.data ?? [])
    .filter((l) => !teamId || !l.teamId || l.teamId === teamId)
    .map((l) => ({ id: l.id, label: l.name, icon: <LabelDot color={l.color} /> }));
  const cycleOpts: Option[] = [
    { id: "active", label: "Active cycle" },
    { id: "none", label: "No cycle" },
    ...(cycles.data ?? []).filter((c) => !teamId || c.teamId === teamId).map((c) => ({ id: c.id, label: cycleLabel(c) })),
  ];

  const count = (csv?: string) => (csv ? csv.split(",").length : 0);
  const chipLabel = (name: string, n: number, single?: string) =>
    n === 0 ? name : n === 1 && single ? `${name}: ${single}` : `${name}: ${n}`;
  const firstName = (csv: string | undefined, find: (id: string) => string | undefined) => (csv ? find(csv.split(",")[0]!) : undefined);

  const statusN = statusSelected.length;
  const assigneeN = count(fs.assignee);
  const labelN = count(fs.label);
  const prioN = count(fs.priority);

  return (
    <search className="filter-bar">
      <label className="search-box">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search issues</span>
        <input
          className="search-input"
          placeholder="Filter by text"
          value={q}
          data-search-input
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      {!hide.includes("status") && (
        <PickerButton
          label="Status"
          className={`filter-chip${statusN ? " on" : ""}`}
          multi
          options={statusOptions}
          selected={statusSelected}
          onPick={(key) => {
            const g = statusGroups.find((x) => x.key === key);
            if (g) setFs({ status: toggle(fs.status, g.ids) });
          }}
        >
          {chipLabel("Status", statusN, statusGroups.find((g) => g.key === statusSelected[0])?.name)}
          <ChevronDown size={12} aria-hidden="true" />
        </PickerButton>
      )}
      {!hide.includes("assignee") && (
        <PickerButton
          label="Assignee"
          className={`filter-chip${assigneeN ? " on" : ""}`}
          multi
          options={assigneeOpts}
          selected={fs.assignee?.split(",") ?? []}
          onPick={(id) => setFs({ assignee: toggle(fs.assignee, [id]) })}
        >
          {chipLabel(
            "Assignee",
            assigneeN,
            firstName(fs.assignee, (id) => assigneeOpts.find((o) => o.id === id)?.label),
          )}
          <ChevronDown size={12} aria-hidden="true" />
        </PickerButton>
      )}
      <PickerButton
        label="Label"
        className={`filter-chip${labelN ? " on" : ""}`}
        multi
        options={labelOpts}
        selected={fs.label?.split(",") ?? []}
        onPick={(id) => setFs({ label: toggle(fs.label, [id]) })}
      >
        {chipLabel(
          "Label",
          labelN,
          firstName(fs.label, (id) => labelOpts.find((o) => o.id === id)?.label),
        )}
        <ChevronDown size={12} aria-hidden="true" />
      </PickerButton>
      <PickerButton
        label="Priority"
        className={`filter-chip${prioN ? " on" : ""}`}
        multi
        options={priorityOptions()}
        selected={fs.priority?.split(",") ?? []}
        onPick={(id) => setFs({ priority: toggle(fs.priority, [id]) })}
      >
        {prioN === 1 ? <PriorityIcon priority={Number(fs.priority) as Priority} /> : null}
        {chipLabel("Priority", prioN, PRIORITY_LABELS[Number(fs.priority?.split(",")[0]) as Priority])}
        <ChevronDown size={12} aria-hidden="true" />
      </PickerButton>
      {!hide.includes("cycle") && (
        <PickerButton
          label="Cycle"
          className={`filter-chip${fs.cycle ? " on" : ""}`}
          options={cycleOpts}
          selected={fs.cycle ? [fs.cycle] : []}
          onPick={(id) => setFs({ cycle: fs.cycle === id ? undefined : id })}
        >
          {fs.cycle ? `Cycle: ${cycleOpts.find((o) => o.id === fs.cycle)?.label ?? "?"}` : "Cycle"}
          <ChevronDown size={12} aria-hidden="true" />
        </PickerButton>
      )}
      {!isEmptyFilter(fs) && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setQ("");
            lastPushed.current = "";
            setFs({ status: undefined, assignee: undefined, label: undefined, priority: undefined, cycle: undefined, q: undefined });
          }}
        >
          <X size={13} aria-hidden="true" />
          Clear
        </button>
      )}
      <span className="filter-spacer" />
      {extra}
      {workspace.status !== "read_only" && (
        <button type="button" className="btn btn-sm" onClick={() => setSaving(true)}>
          <Save size={13} aria-hidden="true" />
          Save view
        </button>
      )}
      {saving && <SaveViewDialog filter={savedFilter} teamId={teamId} layout={layout} onClose={() => setSaving(false)} />}
    </search>
  );
}

function SaveViewDialog({
  filter,
  teamId,
  layout,
  onClose,
}: {
  filter: IssueFilter;
  teamId?: string;
  layout: "list" | "board";
  onClose: () => void;
}) {
  const { slug, workspace } = useWs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(workspace.role !== "guest");
  const [busy, setBusy] = useState(false);
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const v = await api.ws(slug).createView({ name: name.trim(), teamId: teamId ?? null, shared, layout, filters: filter });
      await qc.invalidateQueries({ queryKey: keys.views(slug) });
      toast("View saved", "success");
      onClose();
      navigate({ to: paths.view(slug, v.id) });
    } catch (err) {
      toastError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Save view"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => save()}>
            Save view
          </button>
        </>
      }
    >
      <form onSubmit={save} className="stack">
        <div className="field">
          <label className="field-label" htmlFor="view-name">
            Name
          </label>
          <input id="view-name" className="input" data-autofocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {workspace.role !== "guest" && (
          <label className="check-row">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Share with the workspace
          </label>
        )}
        <p className="muted small">Saves the current filters and the {layout} layout.</p>
      </form>
    </Dialog>
  );
}
