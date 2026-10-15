import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BarChart } from "../../components/BarChart";
import { Empty, Skeleton } from "../../components/Feedback";
import { Avatar, LabelDot, teamOptionLabel } from "../../components/icons";
import { LineChart, shortDate } from "../../components/LineChart";
import { api, errorMessage } from "../../lib/api";
import { addDays, toISODate, todayISO } from "../../lib/format";
import { keys, useLabels, useMembers, useTeams } from "../../lib/queries";
import { PageHeader } from "../issues/pages";
import { useWs } from "../shell/context";

type Preset = "4w" | "12w" | "quarter" | "custom";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "4w", label: "Last 4 weeks" },
  { id: "12w", label: "Last 12 weeks" },
  { id: "quarter", label: "This quarter" },
  { id: "custom", label: "Custom" },
];

function presetRange(p: Exclude<Preset, "custom">): { from: string; to: string } {
  const to = todayISO();
  if (p === "4w") return { from: addDays(to, -27), to };
  if (p === "12w") return { from: addDays(to, -83), to };
  const now = new Date();
  return { from: toISODate(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Hours as "5 hours" or "2.5 days". */
export function formatHours(h: number | null): string {
  if (h === null || Number.isNaN(h)) return "No data";
  if (h < 24) {
    const v = round1(h);
    return `${v} ${v === 1 ? "hour" : "hours"}`;
  }
  const d = round1(h / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ReportsPage() {
  const { slug } = useWs();
  const id = useId();
  const teams = useTeams(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const [preset, setPreset] = useState<Preset>("12w");
  const [custom, setCustom] = useState(() => presetRange("12w"));
  const [team, setTeam] = useState("");
  const range = preset === "custom" ? custom : presetRange(preset);
  const valid = Boolean(range.from && range.to && range.from <= range.to);
  const report = useQuery({
    queryKey: [...keys.reportsAll(slug), "overview", range.from, range.to, team],
    queryFn: () => api.ws(slug).reportOverview({ from: range.from, to: range.to, team: team || undefined }),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  const data = report.data;
  const nothing = data && data.completed === 0 && data.weekly.every((w) => w.created === 0 && w.completed === 0 && w.open === 0);

  const memberOf = (uid: string | null) => members.data?.find((m) => m.userId === uid);
  const people = (data?.byAssignee ?? []).map((r) => ({
    key: r.userId ?? "none",
    name: r.userId ? (memberOf(r.userId)?.name ?? "Former member") : "Unassigned",
    icon: <Avatar member={r.userId ? (memberOf(r.userId) ?? { name: "Former member", avatarUrl: null }) : null} size={18} />,
    color: "var(--series-1)",
    value: r.completed,
  }));
  const byLabel = (data?.byLabel ?? []).map((r) => {
    const l = labels.data?.find((x) => x.id === r.labelId);
    return {
      key: r.labelId,
      name: l?.name ?? "Removed label",
      icon: <LabelDot color={l?.color ?? "var(--text-3)"} />,
      color: l?.color ?? "var(--text-3)",
      value: r.completed,
    };
  });

  return (
    <div className="page reports-page">
      <PageHeader title="Reports" sub={data ? `${data.completed} completed` : undefined} />
      <div className="page-body pad-page">
        <form className="time-filters" onSubmit={(e) => e.preventDefault()} aria-label="Report filters">
          <fieldset className="segmented time-presets report-presets">
            <legend className="sr-only">Date range</legend>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`seg${preset === p.id ? " active" : ""}`}
                aria-pressed={preset === p.id}
                onClick={() => {
                  if (p.id === "custom") setCustom(range);
                  setPreset(p.id);
                }}
              >
                {p.label}
              </button>
            ))}
          </fieldset>
          {preset === "custom" && (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-from`}>
                  From
                </label>
                <input
                  id={`${id}-from`}
                  type="date"
                  className="input input-sm"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-to`}>
                  To
                </label>
                <input
                  id={`${id}-to`}
                  type="date"
                  className="input input-sm"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                />
              </div>
            </>
          )}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-team`}>
              Team
            </label>
            <select id={`${id}-team`} className="select select-sm" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamOptionLabel(t)}
                </option>
              ))}
            </select>
          </div>
        </form>
        {!valid ? (
          <p className="form-error" role="alert">
            The start date must be on or before the end date.
          </p>
        ) : report.isPending ? (
          <Skeleton rows={5} />
        ) : report.error ? (
          <Empty title="Could not load the report">{errorMessage(report.error)}</Empty>
        ) : !data || nothing ? (
          <Empty title="No activity in this range">Create and complete some issues, then come back to see how work flows.</Empty>
        ) : (
          <>
            <dl className="tiles report-tiles">
              <div className="tile">
                <dt>Completed</dt>
                <dd>{data.completed}</dd>
                <span className="tile-note">Issues finished in this range.</span>
              </div>
              <div className="tile">
                <dt>Median cycle time</dt>
                <dd>{formatHours(data.cycleTimeHours.p50)}</dd>
                <span className="tile-note">Cycle time: from first In Progress to Done.</span>
              </div>
              <div className="tile">
                <dt>Cycle time, 90th percentile</dt>
                <dd>{formatHours(data.cycleTimeHours.p90)}</dd>
                <span className="tile-note">9 in 10 issues finished faster than this.</span>
              </div>
              <div className="tile">
                <dt>Median lead time</dt>
                <dd>{formatHours(data.leadTimeHours.p50)}</dd>
                <span className="tile-note">Lead time: from created to Done.</span>
              </div>
            </dl>
            <div className="report-grid">
              <section className="card-box" aria-labelledby={`${id}-through`}>
                <h2 className="card-title" id={`${id}-through`}>
                  Weekly throughput
                </h2>
                <p className="muted small">Issues created and completed each week, starting Monday.</p>
                <BarChart
                  title="Created and completed per week"
                  columnLabel="Week of"
                  categories={data.weekly.map((w) => shortDate(w.week))}
                  series={[
                    { key: "created", label: "Created", color: "var(--series-2)", values: data.weekly.map((w) => w.created) },
                    { key: "completed", label: "Completed", color: "var(--series-1)", values: data.weekly.map((w) => w.completed) },
                  ]}
                />
              </section>
              <section className="card-box" aria-labelledby={`${id}-open`}>
                <h2 className="card-title" id={`${id}-open`}>
                  Open issues
                </h2>
                <p className="muted small">Issues not yet done or canceled at the end of each week.</p>
                <LineChart
                  title="Open issues by week"
                  days={data.weekly.map((w) => w.week)}
                  series={[{ key: "open", label: "Open", color: "var(--series-1)", values: data.weekly.map((w) => w.open) }]}
                  format={(v) => String(Math.round(v))}
                  height={200}
                />
              </section>
              <section className="card-box" aria-labelledby={`${id}-hist`}>
                <h2 className="card-title" id={`${id}-hist`}>
                  Cycle time spread
                </h2>
                <p className="muted small">How long finished issues took from first In Progress to Done.</p>
                {data.cycleTimeHistogram.every((b) => b.count === 0) ? (
                  <p className="muted small">No finished issues with a start time in this range.</p>
                ) : (
                  <BarChart
                    title="Issues by cycle time"
                    columnLabel="Cycle time"
                    categories={data.cycleTimeHistogram.map((b) => sentence(b.bucket))}
                    series={[{ key: "n", label: "Issues", color: "var(--series-1)", values: data.cycleTimeHistogram.map((b) => b.count) }]}
                  />
                )}
              </section>
              <section className="card-box" aria-labelledby={`${id}-people`}>
                <h2 className="card-title" id={`${id}-people`}>
                  Completed by person
                </h2>
                <p className="muted small">An issue with two assignees counts for both.</p>
                <HBars rows={people} empty="Nothing completed in this range." label="Completed by person" />
              </section>
              <section className="card-box" aria-labelledby={`${id}-labels`}>
                <h2 className="card-title" id={`${id}-labels`}>
                  Completed by label
                </h2>
                <p className="muted small">An issue with two labels counts for both.</p>
                <HBars rows={byLabel} empty="No completed issues had labels." label="Completed by label" />
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HBars({
  rows,
  empty,
  label,
}: {
  rows: { key: string; name: string; icon: React.ReactNode; color: string; value: number }[];
  empty: string;
  label: string;
}) {
  if (rows.length === 0) return <p className="muted small">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="hbar-list" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="hbar-row">
          <span className="hbar-name">
            {r.icon}
            <span className="hbar-text">{r.name}</span>
          </span>
          <span className="hbar-track" aria-hidden="true">
            <span className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
          </span>
          <span className="hbar-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
