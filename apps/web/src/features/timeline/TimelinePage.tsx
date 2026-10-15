import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type Issue, type IssueFilter, STATE_CATEGORIES, type Team, type WorkflowState } from "@glasstrack/shared";
import { CalendarPlus, ChevronDown, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Empty, Skeleton } from "../../components/Feedback";
import { StatusIcon } from "../../components/icons";
import { Popover } from "../../components/Picker";
import { api, errorMessage } from "../../lib/api";
import { mergeFilters, searchToFilter } from "../../lib/filters";
import { formatDateRange, formatDueDate, todayISO } from "../../lib/format";
import { useUpdateIssue } from "../../lib/mutations";
import { paths } from "../../lib/paths";
import { keys, useCycles, useIssues, useStates } from "../../lib/queries";
import { ui } from "../../lib/store";
import { FilterBar, useFilterSearch } from "../issues/FilterBar";
import { PageHeader, TeamLayoutSwitch, TeamMissing, useTeamByKey } from "../issues/pages";
import { cycleLabel } from "../issue/options";
import { useWs } from "../shell/context";
import { dayNum, headerTicks, isoOf, PPD, visibleRange, type Zoom } from "./dates";

type GroupBy = "status" | "cycle";
const ROW_H = 36;
const GROUP_H = 32;
const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "weeks", label: "Weeks" },
  { id: "months", label: "Months" },
  { id: "quarters", label: "Quarters" },
];

/** Start and end day numbers; a single date gives a one-day item. */
interface Span {
  start: number | null;
  due: number | null;
}
const spanOf = (i: Pick<Issue, "startDate" | "dueDate">): Span => ({
  start: i.startDate ? dayNum(i.startDate) : null,
  due: i.dueDate ? dayNum(i.dueDate) : null,
});
const first = (s: Span) => (s.start ?? s.due) as number;
const last = (s: Span) => (s.due ?? s.start) as number;
const hasDates = (s: Span) => s.start !== null || s.due !== null;

interface Group {
  id: string;
  title: ReactNode;
  label: string;
  issues: Issue[];
}

export function TimelinePage() {
  const { team, loading } = useTeamByKey();
  if (!team) return <TeamMissing loading={loading} />;
  return <Timeline key={team.id} team={team} />;
}

function Timeline({ team }: { team: Team }) {
  const { slug, canEdit } = useWs();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const zoom: Zoom = search.zoom === "months" || search.zoom === "quarters" ? search.zoom : "weeks";
  const groupBy: GroupBy = search.group === "cycle" ? "cycle" : "status";
  const setSearch = (patch: Record<string, string | undefined>) =>
    navigate({ to: paths.teamTimeline(slug, team.key), search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true });

  const [fs] = useFilterSearch();
  const base = useMemo<IssueFilter>(() => ({ team: team.id }), [team.id]);
  const filter = useMemo(() => mergeFilters(base, searchToFilter(fs)), [base, fs]);
  const issues = useIssues(slug, { ...filter, order: "manual" });
  const states = useStates(slug);
  const cycles = useCycles(slug);
  const relations = useQuery({
    queryKey: keys.relations(slug, team.id),
    queryFn: () => api.ws(slug).relations(team.id),
    staleTime: 30_000,
  });
  const count = issues.data?.issues.length;

  return (
    <div className="page tl-page">
      <PageHeader
        title={`${team.name} timeline`}
        sub={count !== undefined ? `${count}${issues.data?.hasMore ? "+" : ""} issues` : undefined}
      >
        <TeamLayoutSwitch team={team} current="timeline" />
        {canEdit && (
          <button type="button" className="btn btn-sm hide-mobile" onClick={() => ui.openCreate({ teamId: team.id })}>
            <Plus size={14} aria-hidden="true" />
            Issue
          </button>
        )}
      </PageHeader>
      <FilterBar
        teamId={team.id}
        savedFilter={filter}
        layout="list"
        canSave={false}
        extra={
          <div className="tl-controls">
            <fieldset className="segmented time-presets">
              <legend className="sr-only">Group by</legend>
              {(["status", "cycle"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`seg${groupBy === g ? " active" : ""}`}
                  aria-pressed={groupBy === g}
                  onClick={() => setSearch({ group: g === "status" ? undefined : g })}
                >
                  {g === "status" ? "Status" : "Cycle"}
                </button>
              ))}
            </fieldset>
            <fieldset className="segmented time-presets">
              <legend className="sr-only">Zoom</legend>
              {ZOOMS.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  className={`seg${zoom === z.id ? " active" : ""}`}
                  aria-pressed={zoom === z.id}
                  onClick={() => setSearch({ zoom: z.id === "weeks" ? undefined : z.id })}
                >
                  {z.label}
                </button>
              ))}
            </fieldset>
          </div>
        }
      />
      <div className="page-body tl-body-wrap">
        {issues.isPending || states.isPending ? (
          <Skeleton />
        ) : issues.error ? (
          <Empty title="Could not load issues">{errorMessage(issues.error)}</Empty>
        ) : issues.data.issues.length === 0 ? (
          <Empty title="No issues here">Nothing matches these filters. Clear them or create an issue.</Empty>
        ) : (
          <Gantt
            team={team}
            issues={issues.data.issues}
            states={states.data ?? []}
            cycles={(cycles.data ?? []).filter((c) => c.teamId === team.id)}
            links={relations.data ?? []}
            zoom={zoom}
            groupBy={groupBy}
          />
        )}
      </div>
    </div>
  );
}

function Gantt({
  team,
  issues,
  states,
  cycles,
  links,
  zoom,
  groupBy,
}: {
  team: Team;
  issues: Issue[];
  states: WorkflowState[];
  cycles: {
    id: string;
    number: number;
    name: string | null;
    startsOn: string;
    endsOn: string;
    completedAt: string | null;
    teamId: string;
  }[];
  links: { id: string; issueId: string; relatedIssueId: string }[];
  zoom: Zoom;
  groupBy: GroupBy;
}) {
  const { slug, canEdit } = useWs();
  const navigate = useNavigate();
  const update = useUpdateIssue(slug);
  const scroller = useRef<HTMLDivElement>(null);
  const tableId = useId();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** Unsaved positions while dragging or nudging with the keyboard. */
  const [preview, setPreview] = useState<Record<string, Span>>({});
  const [announce, setAnnounce] = useState("");
  const [datesFor, setDatesFor] = useState<{ issue: Issue; anchor: HTMLElement } | null>(null);
  const ppd = PPD[zoom];
  const today = dayNum(todayISO());

  const spans = useMemo(() => {
    const m = new Map<string, Span>();
    for (const i of issues) m.set(i.id, preview[i.id] ?? spanOf(i));
    return m;
  }, [issues, preview]);

  const { lo, hi } = useMemo(() => {
    const ds: number[] = [];
    for (const i of issues) {
      const s = spanOf(i);
      if (s.start !== null) ds.push(s.start);
      if (s.due !== null) ds.push(s.due);
    }
    return visibleRange(zoom, ds, today);
  }, [issues, zoom, today]);
  const days = hi - lo;
  const trackW = days * ppd;
  const ticks = useMemo(() => headerTicks(zoom, lo, hi), [zoom, lo, hi]);
  const x = (day: number) => (day - lo) * ppd;

  // Keep the view still when the range grows to the left.
  const prevLo = useRef({ lo, zoom });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && prevLo.current.zoom === zoom && prevLo.current.lo !== lo) el.scrollLeft += (prevLo.current.lo - lo) * ppd;
    prevLo.current = { lo, zoom };
  }, [lo, zoom, ppd]);

  const scrollToToday = () => {
    const el = scroller.current;
    if (!el) return;
    const label = el.querySelector<HTMLElement>(".tl-corner")?.offsetWidth ?? 0;
    el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - label) / 3);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll once per zoom level
  useLayoutEffect(scrollToToday, [zoom]);

  const groups = useMemo<Group[]>(() => {
    const dated = issues.filter((i) => hasDates(spanOf(i)));
    const byFirst = (a: Issue, b: Issue) => first(spanOf(a)) - first(spanOf(b)) || last(spanOf(a)) - last(spanOf(b));
    const out: Group[] = [];
    if (groupBy === "status") {
      const teamStates = states
        .filter((s) => s.teamId === team.id)
        .sort((a, b) => STATE_CATEGORIES.indexOf(a.category) - STATE_CATEGORIES.indexOf(b.category) || a.position - b.position);
      for (const s of teamStates) {
        const list = dated.filter((i) => i.statusId === s.id).sort(byFirst);
        if (list.length)
          out.push({
            id: `s:${s.id}`,
            label: s.name,
            title: (
              <>
                <StatusIcon state={s} />
                {s.name}
              </>
            ),
            issues: list,
          });
      }
    } else {
      const sorted = [...cycles].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
      for (const c of sorted) {
        const list = dated.filter((i) => i.cycleId === c.id).sort(byFirst);
        if (list.length)
          out.push({
            id: `c:${c.id}`,
            label: cycleLabel(c),
            title: (
              <>
                {cycleLabel(c)}
                <span className="muted small">{formatDateRange(c.startsOn, c.endsOn)}</span>
              </>
            ),
            issues: list,
          });
      }
      const none = dated.filter((i) => !i.cycleId || !cycles.some((c) => c.id === i.cycleId)).sort(byFirst);
      if (none.length) out.push({ id: "c:none", label: "No cycle", title: "No cycle", issues: none });
    }
    const undated = issues.filter((i) => !hasDates(spanOf(i)));
    if (undated.length) out.push({ id: "none", label: "No dates", title: "No dates", issues: undated });
    return out;
  }, [issues, states, cycles, groupBy, team.id]);

  // Vertical layout, so the dependency arrows know where each row is.
  const { rows, height } = useMemo(() => {
    const rows = new Map<string, number>();
    let y = 0;
    for (const g of groups) {
      y += GROUP_H;
      if (collapsed[g.id]) continue;
      for (const i of g.issues) {
        rows.set(i.id, y + ROW_H / 2);
        y += ROW_H;
      }
    }
    return { rows, height: y };
  }, [groups, collapsed]);

  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues]);

  // Dependencies: blocker end -> blocked start. A conflict is a blocked issue that starts on or before the blocker's due day.
  const deps = useMemo(() => {
    const out: { id: string; from: Issue; to: Issue; conflict: boolean; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const l of links) {
      const from = byId.get(l.issueId);
      const to = byId.get(l.relatedIssueId);
      if (!from || !to) continue;
      const a = spans.get(from.id)!;
      const b = spans.get(to.id)!;
      if (!hasDates(a) || !hasDates(b)) continue;
      const y1 = rows.get(from.id);
      const y2 = rows.get(to.id);
      const conflict = first(b) <= last(a);
      if (y1 === undefined || y2 === undefined) {
        out.push({ id: l.id, from, to, conflict, x1: 0, y1: -1, x2: 0, y2: -1 });
        continue;
      }
      out.push({ id: l.id, from, to, conflict, x1: (last(a) + 1 - lo) * ppd, y1, x2: (first(b) - lo) * ppd, y2 });
    }
    return out;
  }, [links, byId, spans, rows, lo, ppd]);

  const conflictText = (d: (typeof deps)[number]) =>
    first(spans.get(d.to.id)!) === last(spans.get(d.from.id)!)
      ? `Starts the day ${d.from.identifier} is due`
      : `Starts before ${d.from.identifier} is due`;
  const blockedBy = new Map<string, (typeof deps)[number][]>();
  const blocking = new Map<string, (typeof deps)[number][]>();
  for (const d of deps) {
    if (!d.conflict) continue;
    blockedBy.set(d.to.id, [...(blockedBy.get(d.to.id) ?? []), d]);
    blocking.set(d.from.id, [...(blocking.get(d.from.id) ?? []), d]);
  }

  /** Saves new dates. Single-date issues keep their one date. */
  const commit = (issue: Issue, s: Span) => {
    const cur = spanOf(issue);
    setPreview((p) => {
      const { [issue.id]: _, ...rest } = p;
      return rest;
    });
    if (s.start === cur.start && s.due === cur.due) return;
    const patch: { startDate?: string | null; dueDate?: string | null } = {};
    if (s.start !== cur.start) patch.startDate = s.start === null ? null : isoOf(s.start);
    if (s.due !== cur.due) patch.dueDate = s.due === null ? null : isoOf(s.due);
    update.mutate({ issue, patch });
    setAnnounce(`${issue.identifier} moved to ${describeSpan(s)}`);
  };

  // Pointer drag: move the bar, or resize from either end.
  const drag = useRef<{
    issue: Issue;
    mode: "move" | "start" | "end" | "draw";
    x0: number;
    orig: Span;
    moved: boolean;
    day0?: number;
  } | null>(null);
  const onPointerDown = (e: React.PointerEvent, issue: Issue, mode: "move" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!canEdit) {
      drag.current = { issue, mode: "move", x0: e.clientX, orig: spanOf(issue), moved: false };
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { issue, mode, x0: e.clientX, orig: spans.get(issue.id) ?? spanOf(issue), moved: false };
  };
  const onDrawStart = (e: React.PointerEvent<HTMLDivElement>, issue: Issue) => {
    if (e.button !== 0 || !canEdit) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const day = lo + Math.floor((e.clientX - rect.left) / ppd);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { issue, mode: "draw", x0: e.clientX, orig: { start: day, due: day }, moved: false, day0: day };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !canEdit) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 4) return;
    d.moved = true;
    const delta = Math.round(dx / ppd);
    const o = d.orig;
    let next: Span;
    if (d.mode === "draw") {
      const day = d.day0! + delta;
      next = { start: Math.min(d.day0!, day), due: Math.max(d.day0!, day) };
    } else if (d.mode === "move") {
      next = { start: o.start === null ? null : o.start + delta, due: o.due === null ? null : o.due + delta };
    } else if (d.mode === "start") {
      next = { start: Math.min(first(o) + delta, last(o)), due: o.due ?? o.start };
    } else {
      next = { start: o.start ?? o.due, due: Math.max(last(o) + delta, first(o)) };
    }
    setPreview((p) => ({ ...p, [d.issue.id]: next }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (d.mode !== "draw") navigate({ to: paths.issue(slug, d.issue.identifier) });
      return;
    }
    const s = preview[d.issue.id];
    if (s) commit(d.issue, s);
  };

  // Keyboard: arrows move a day, Shift+arrows change the due date. Saved after a short pause.
  const pending = useRef<{ issue: Issue; timer: ReturnType<typeof setTimeout> } | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const flush = () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    const s = previewRef.current[p.issue.id];
    if (s) commit(p.issue, s);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: save a pending keyboard move when leaving the page
  useEffect(() => () => flush(), []);
  const onBarKey = (e: React.KeyboardEvent, issue: Issue) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      flush();
      navigate({ to: paths.issue(slug, issue.identifier) });
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (!canEdit) return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const cur = previewRef.current[issue.id] ?? spanOf(issue);
    const next: Span = e.shiftKey
      ? { start: cur.start ?? cur.due, due: Math.max(last(cur) + step, first(cur)) }
      : { start: cur.start === null ? null : cur.start + step, due: cur.due === null ? null : cur.due + step };
    if (pending.current && pending.current.issue.id !== issue.id) flush();
    setPreview((p) => ({ ...p, [issue.id]: next }));
    setAnnounce(`${issue.identifier}: ${describeSpan(next)}`);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { issue, timer: setTimeout(flush, 700) };
  };

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <>
      <div className="tl-toolbar">
        <button type="button" className="btn btn-sm" onClick={scrollToToday}>
          Today
        </button>
        <span className="muted small hide-mobile">
          {canEdit
            ? "Drag a bar to move it, or drag an end to change a date. Focus a bar and use the arrow keys; Shift changes the due date."
            : ""}
        </span>
      </div>
      <div className="tl-scroll" ref={scroller} aria-describedby={tableId}>
        <div className="tl-canvas" style={{ width: `calc(var(--tl-label) + ${trackW}px)` }}>
          <div className="tl-head" aria-hidden="true">
            <div className="tl-corner">Issue</div>
            <div className="tl-head-track" style={{ width: trackW }}>
              <div className="tl-head-row">
                {ticks.top.map((t) => (
                  <span key={t.start} className="tl-tick top" style={{ left: x(t.start), width: (t.end - t.start) * ppd }}>
                    <span className="tl-tick-text">{t.label}</span>
                  </span>
                ))}
              </div>
              <div className="tl-head-row">
                {ticks.bottom.map((t) => (
                  <span
                    key={t.start}
                    className={`tl-tick${t.start <= today && today < t.end ? " today" : ""}`}
                    style={{ left: x(t.start), width: (t.end - t.start) * ppd }}
                  >
                    {(t.end - t.start) * ppd >= 18 ? t.label : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="tl-body">
            <div
              className={`tl-grid${zoom === "weeks" ? " days" : ""}`}
              style={{ width: trackW, height, ["--ppd" as string]: `${ppd}px` }}
              aria-hidden="true"
            >
              {ticks.lines.map((d) => (
                <span key={d} className="tl-line" style={{ left: x(d) }} />
              ))}
              {today >= lo && today < hi && <span className="tl-today" style={{ left: x(today) + ppd / 2 }} />}
            </div>
            {groups.map((g) => (
              <div key={g.id} className="tl-group-block">
                <div className="tl-group" style={{ height: GROUP_H }}>
                  <button type="button" className="tl-group-toggle" aria-expanded={!collapsed[g.id]} onClick={() => toggle(g.id)}>
                    {collapsed[g.id] ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    {g.title}
                    <span className="group-count">{g.issues.length}</span>
                  </button>
                  {g.id === "none" && !collapsed[g.id] && canEdit && (
                    <span className="tl-group-hint muted small hide-mobile">Drag across the grid to set dates</span>
                  )}
                </div>
                {!collapsed[g.id] &&
                  g.issues.map((i) => {
                    const s = spans.get(i.id)!;
                    const dated = hasDates(s);
                    const conflictIn = blockedBy.get(i.id);
                    const conflictOut = blocking.get(i.id);
                    const state = states.find((st) => st.id === i.statusId);
                    return (
                      <div key={i.id} className="tl-row" style={{ height: ROW_H }}>
                        <div className="tl-label">
                          <Link to={paths.issue(slug, i.identifier)} className="tl-label-link" title={i.title}>
                            <span className="issue-id">{i.identifier}</span>
                            <span className="tl-label-title">{i.title}</span>
                          </Link>
                          {dated && conflictIn ? (
                            <span
                              className="tl-warn"
                              title={conflictIn.map(conflictText).join(". ")}
                              role="img"
                              aria-label={conflictIn.map(conflictText).join(". ")}
                            >
                              <TriangleAlert size={14} />
                            </span>
                          ) : null}
                          {!dated && canEdit && (
                            <button
                              type="button"
                              className="icon-btn small"
                              aria-label={`Set dates for ${i.identifier}`}
                              title="Set dates"
                              onClick={(e) => setDatesFor({ issue: i, anchor: e.currentTarget })}
                            >
                              <CalendarPlus size={14} />
                            </button>
                          )}
                        </div>
                        <div
                          className={`tl-track${!dated && canEdit ? " drawable" : ""}`}
                          style={{ width: trackW }}
                          onPointerDown={!dated ? (e) => onDrawStart(e, i) : undefined}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                          onPointerCancel={() => {
                            drag.current = null;
                            setPreview(({ [i.id]: _, ...rest }) => rest);
                          }}
                        >
                          {dated && (
                            <Bar
                              issue={i}
                              span={s}
                              x={x}
                              ppd={ppd}
                              color={state?.color}
                              canEdit={canEdit}
                              conflictIn={conflictIn?.map(conflictText)}
                              conflictOut={Boolean(conflictOut?.length)}
                              onPointerDown={onPointerDown}
                              onKeyDown={onBarKey}
                              onBlur={flush}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
            <svg className="tl-deps" width={trackW} height={height} aria-hidden="true">
              <defs>
                <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="tl-arrow-head" />
                </marker>
                <marker id="tl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="tl-arrow-head bad" />
                </marker>
              </defs>
              {deps
                .filter((d) => d.y1 >= 0)
                .map((d) => {
                  const bend = Math.max(16, Math.min(60, Math.abs(d.x2 - d.x1) / 2));
                  const path =
                    d.x2 - d.x1 >= 16
                      ? `M${d.x1},${d.y1} C${d.x1 + bend},${d.y1} ${d.x2 - bend},${d.y2} ${d.x2},${d.y2}`
                      : `M${d.x1},${d.y1} c12,0 12,${(d.y2 - d.y1) / 2} 0,${(d.y2 - d.y1) / 2} L${d.x2},${(d.y1 + d.y2) / 2} c-12,0 -12,${(d.y2 - d.y1) / 2} 0,${(d.y2 - d.y1) / 2}`;
                  return (
                    <path
                      key={d.id}
                      d={path}
                      className={`tl-dep${d.conflict ? " bad" : ""}`}
                      markerEnd={`url(#${d.conflict ? "tl-arrow-bad" : "tl-arrow"})`}
                    />
                  );
                })}
            </svg>
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="sr-only">
      <table id={tableId}>
        <caption>{team.name} timeline</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Title</th>
            <th scope="col">Start</th>
            <th scope="col">Due</th>
            <th scope="col">Blocked by</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => {
            const s = spans.get(i.id)!;
            const blockers = deps.filter((d) => d.to.id === i.id);
            return (
              <tr key={i.id}>
                <th scope="row">{i.identifier}</th>
                <td>{i.title}</td>
                <td>{s.start === null ? "None" : formatDueDate(isoOf(s.start))}</td>
                <td>{s.due === null ? "None" : formatDueDate(isoOf(s.due))}</td>
                <td>
                  {blockers.length
                    ? blockers.map((d) => `${d.from.identifier}${d.conflict ? ` (${conflictText(d).toLowerCase()})` : ""}`).join(", ")
                    : "None"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {datesFor && (
        <SetDates
          issue={datesFor.issue}
          anchor={datesFor.anchor}
          onClose={() => {
            setDatesFor(null);
            datesFor.anchor.focus();
          }}
        />
      )}
    </>
  );
}

function describeSpan(s: Span): string {
  if (s.start !== null && s.due !== null && s.start !== s.due) return `${formatDueDate(isoOf(s.start))} to ${formatDueDate(isoOf(s.due))}`;
  if (s.due !== null) return `due ${formatDueDate(isoOf(s.due))}`;
  if (s.start !== null) return `starts ${formatDueDate(isoOf(s.start))}`;
  return "no dates";
}

function Bar({
  issue,
  span,
  x,
  ppd,
  color,
  canEdit,
  conflictIn,
  conflictOut,
  onPointerDown,
  onKeyDown,
  onBlur,
}: {
  issue: Issue;
  span: Span;
  x: (d: number) => number;
  ppd: number;
  color?: string;
  canEdit: boolean;
  conflictIn?: string[];
  conflictOut: boolean;
  onPointerDown: (e: React.PointerEvent, issue: Issue, mode: "move" | "start" | "end") => void;
  onKeyDown: (e: React.KeyboardEvent, issue: Issue) => void;
  onBlur: () => void;
}) {
  const single = span.start === null || span.due === null;
  const left = x(first(span));
  const width = (last(span) - first(span) + 1) * ppd;
  const help = canEdit ? ". Arrow keys move it a day, Shift with arrow keys changes the due date, Enter opens it" : ". Enter opens it";
  const label = `${issue.identifier} ${issue.title}, ${describeSpan(span)}${conflictIn?.length ? `. Warning: ${conflictIn.join(". ")}` : ""}${help}`;
  const style = { "--bar": color ?? "var(--accent)" } as React.CSSProperties;
  if (single) {
    return (
      <button
        type="button"
        className={`tl-milestone${conflictIn?.length || conflictOut ? " conflict" : ""}`}
        style={{ ...style, left: left + ppd / 2 - 9 }}
        aria-label={label}
        title={`${issue.identifier}: ${describeSpan(span)}`}
        onPointerDown={(e) => onPointerDown(e, issue, "move")}
        onKeyDown={(e) => onKeyDown(e, issue)}
        onBlur={onBlur}
        data-testid="timeline-bar"
      >
        <span className="tl-diamond" aria-hidden="true" />
        <span className="tl-milestone-text" aria-hidden="true">
          {issue.title}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`tl-bar${conflictIn?.length ? " conflict-start" : ""}${conflictOut ? " conflict-end" : ""}`}
      style={{ ...style, left, width }}
      aria-label={label}
      title={`${issue.identifier}: ${describeSpan(span)}`}
      onPointerDown={(e) => onPointerDown(e, issue, "move")}
      onKeyDown={(e) => onKeyDown(e, issue)}
      onBlur={onBlur}
      data-testid="timeline-bar"
    >
      {canEdit && <span className="tl-handle start" aria-hidden="true" onPointerDown={(e) => onPointerDown(e, issue, "start")} />}
      <span className="tl-bar-text" aria-hidden="true">
        {width >= 48 ? issue.title : ""}
      </span>
      {canEdit && <span className="tl-handle end" aria-hidden="true" onPointerDown={(e) => onPointerDown(e, issue, "end")} />}
    </button>
  );
}

function SetDates({ issue, anchor, onClose }: { issue: Issue; anchor: HTMLElement; onClose: () => void }) {
  const { slug } = useWs();
  const update = useUpdateIssue(slug);
  const id = useId();
  const [start, setStart] = useState(todayISO());
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!start && !due) return setError("Pick a start or due date.");
    if (start && due && start > due) return setError("The start date must be on or before the due date.");
    update.mutate({ issue, patch: { startDate: start || null, dueDate: due || null } });
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Set dates for ${issue.identifier}`} width={260}>
      <form className="stack tl-dates-form" onSubmit={save}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-s`}>
            Start date
          </label>
          <input
            id={`${id}-s`}
            type="date"
            className="input input-sm"
            data-autofocus
            value={start}
            onChange={(e) => setStart(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the popover opens on request, focus goes to its first field
            autoFocus
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-d`}>
            Due date
          </label>
          <input
            id={`${id}-d`}
            type="date"
            className="input input-sm"
            value={due}
            min={start || undefined}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
        <div className="row-end">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary">
            Save
          </button>
        </div>
      </form>
    </Popover>
  );
}
