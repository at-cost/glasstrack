import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { Empty, Skeleton } from "../../components/Feedback";
import { Avatar, teamOptionLabel } from "../../components/icons";
import { api, errorMessage } from "../../lib/api";
import { addDays, formatDueDate, toISODate } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useMembers, useTeams } from "../../lib/queries";
import { downloadCsv, formatMinutes, weekRange } from "../../lib/time";
import { PageHeader } from "../issues/pages";
import { useWs } from "../shell/context";

function presets() {
  const week = weekRange();
  const now = new Date();
  const monthStart = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const lastMonthStart = toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { id: "week", label: "This week", from: week.from, to: week.to },
    { id: "last-week", label: "Last week", from: addDays(week.from, -7), to: addDays(week.to, -7) },
    { id: "month", label: "This month", from: monthStart, to: monthEnd },
    { id: "last-month", label: "Last month", from: lastMonthStart, to: lastMonthEnd },
  ];
}

export function TimePage() {
  const { slug } = useWs();
  const id = useId();
  const teams = useTeams(slug);
  const members = useMembers(slug);
  const initial = weekRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [team, setTeam] = useState("");
  const [user, setUser] = useState("");
  const valid = Boolean(from && to && from <= to);
  const report = useQuery({
    queryKey: [...keys.timeReportAll(slug), from, to, team, user],
    queryFn: () => api.ws(slug).timeReport({ from, to, team: team || undefined, user: user || undefined }),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  const name = (uid: string | null) => members.data?.find((m) => m.userId === uid)?.name ?? "Former member";
  const member = (uid: string | null) => members.data?.find((m) => m.userId === uid);
  const data = report.data;
  const activePreset = presets().find((p) => p.from === from && p.to === to)?.id;

  const csv = () => {
    if (!data) return;
    downloadCsv(`${slug}-time-${from}-to-${to}.csv`, [
      ["Date", "Person", "Email", "Issue", "Title", "Minutes", "Hours", "Note"],
      ...data.entries.map((e) => [
        e.spentOn,
        name(e.userId),
        member(e.userId)?.email ?? "",
        e.identifier,
        e.title,
        e.minutes,
        (e.minutes / 60).toFixed(2),
        e.note ?? "",
      ]),
    ]);
  };

  return (
    <div className="page time-page">
      <PageHeader title="Time" sub={data ? `${formatMinutes(data.totalMinutes)} logged` : undefined}>
        <button type="button" className="btn btn-sm" onClick={csv} disabled={!data || data.entries.length === 0}>
          <Download size={14} aria-hidden="true" />
          Download CSV
        </button>
      </PageHeader>
      <div className="page-body pad-page">
        <form className="time-filters" onSubmit={(e) => e.preventDefault()} aria-label="Report filters">
          <fieldset className="segmented time-presets">
            <legend className="sr-only">Date range</legend>
            {presets().map((p) => (
              <button
                key={p.id}
                type="button"
                className={`seg${activePreset === p.id ? " active" : ""}`}
                aria-pressed={activePreset === p.id}
                onClick={() => {
                  setFrom(p.from);
                  setTo(p.to);
                }}
              >
                {p.label}
              </button>
            ))}
          </fieldset>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-from`}>
              From
            </label>
            <input id={`${id}-from`} type="date" className="input input-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-to`}>
              To
            </label>
            <input id={`${id}-to`} type="date" className="input input-sm" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
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
          <div className="field">
            <label className="field-label" htmlFor={`${id}-user`}>
              Person
            </label>
            <select id={`${id}-user`} className="select select-sm" value={user} onChange={(e) => setUser(e.target.value)}>
              <option value="">Everyone</option>
              {members.data?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
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
        ) : !data || data.entries.length === 0 ? (
          <Empty title="No time logged in this range">Start a timer or log time on an issue, then it shows up here.</Empty>
        ) : (
          <>
            {data.truncated && (
              <p className="notice notice-warning">Showing the first 5,000 entries. Pick a shorter range to see all of them.</p>
            )}
            <div className="time-totals">
              <section className="card-box" aria-labelledby={`${id}-people`}>
                <h2 className="card-title" id={`${id}-people`}>
                  By person
                </h2>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Person</th>
                        <th scope="col" className="num">
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byUser.map((u) => (
                        <tr key={u.userId ?? "none"}>
                          <td>
                            <span className="person-cell">
                              <Avatar member={member(u.userId) ?? { name: "Former member", avatarUrl: null }} size={20} />
                              {name(u.userId)}
                            </span>
                          </td>
                          <td className="num">{formatMinutes(u.minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total</th>
                        <td className="num">{formatMinutes(data.totalMinutes)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
              <section className="card-box" aria-labelledby={`${id}-issues`}>
                <h2 className="card-title" id={`${id}-issues`}>
                  By issue
                </h2>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Issue</th>
                        <th scope="col" className="num">
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byIssue.map((i) => (
                        <tr key={i.issueId}>
                          <td>
                            <Link to={paths.issue(slug, i.identifier)} className="issue-cell">
                              <span className="issue-id">{i.identifier}</span>
                              <span className="issue-cell-title">{i.title}</span>
                            </Link>
                          </td>
                          <td className="num">{formatMinutes(i.minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            <section className="card-box" aria-labelledby={`${id}-entries`}>
              <h2 className="card-title" id={`${id}-entries`}>
                Entries <span className="group-count">{data.entries.length}</span>
              </h2>
              <div className="table-wrap">
                <table className="data-table time-entries">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Person</th>
                      <th scope="col">Issue</th>
                      <th scope="col">Note</th>
                      <th scope="col" className="num">
                        Time
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => (
                      <tr key={e.id}>
                        <td className="nowrap">{formatDueDate(e.spentOn)}</td>
                        <td className="nowrap">{name(e.userId)}</td>
                        <td>
                          <Link to={paths.issue(slug, e.identifier)} className="issue-cell">
                            <span className="issue-id">{e.identifier}</span>
                            <span className="issue-cell-title">{e.title}</span>
                          </Link>
                        </td>
                        <td className="muted">{e.note}</td>
                        <td className="num nowrap">{formatMinutes(e.minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
