import { Link } from "@tanstack/react-router";
import { type Issue, type Label, type Member, STATE_CATEGORIES, type WorkflowState } from "@glasstrack/shared";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AvatarStack, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { dueState, formatDueDate } from "../../lib/format";
import { paths } from "../../lib/paths";
import { useLabels, useMembers, useStates } from "../../lib/queries";
import { currentIssueStore, ui } from "../../lib/store";
import { isTypingTarget } from "../palette/shortcuts";
import { useWs } from "../shell/context";

interface Group {
  key: string;
  name: string;
  state: WorkflowState | undefined;
  /** status id to use for "add issue here" when the list is one team */
  statusId?: string;
  issues: Issue[];
}

export function groupByStatus(issues: Issue[], states: WorkflowState[] | undefined, teamId?: string, onlyStatusIds?: string[]): Group[] {
  const byId = new Map((states ?? []).map((s) => [s.id, s]));
  const groups = new Map<string, Group>();
  // Seed with all team statuses so empty ones still show on team lists.
  if (teamId) {
    for (const s of (states ?? []).filter((x) => x.teamId === teamId && (!onlyStatusIds?.length || onlyStatusIds.includes(x.id)))) {
      groups.set(`${s.category}:${s.name}`, { key: `${s.category}:${s.name}`, name: s.name, state: s, statusId: s.id, issues: [] });
    }
  }
  for (const i of issues) {
    const s = byId.get(i.statusId);
    const key = s ? `${s.category}:${s.name}` : "unknown";
    let g = groups.get(key);
    if (!g) {
      g = { key, name: s?.name ?? "Unknown", state: s, statusId: teamId ? s?.id : undefined, issues: [] };
      groups.set(key, g);
    }
    g.issues.push(i);
  }
  const rank = (g: Group) => (g.state ? STATE_CATEGORIES.indexOf(g.state.category) * 1000 + g.state.position : 99999);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/** j/k move focus between rows anywhere on the page. */
function useRowNavigation() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (e.key !== "j" && e.key !== "k" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-issue-row]")];
      if (rows.length === 0) return;
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const isArrow = e.key.startsWith("Arrow");
      // Arrow keys only navigate once focus is already on a row.
      if (isArrow && i < 0) return;
      e.preventDefault();
      const down = e.key === "j" || e.key === "ArrowDown";
      const next = i < 0 ? (down ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + (down ? 1 : -1)));
      rows[next]?.focus();
      rows[next]?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function IssueRow({
  issue,
  state,
  labels,
  members,
  showStatus = true,
}: {
  issue: Issue;
  state?: WorkflowState;
  labels: Label[];
  members: Map<string, Member> | Member[] | undefined;
  showStatus?: boolean;
}) {
  const { slug } = useWs();
  const temp = issue.id.startsWith("temp-");
  const due = dueState(issue.dueDate);
  const content = (
    <>
      <PriorityIcon priority={issue.priority} />
      <span className="issue-id">{temp ? "New" : issue.identifier}</span>
      {showStatus && <StatusIcon state={state} />}
      <span className="issue-title">{issue.title}</span>
      <span className="issue-meta">
        {labels.map((l) => (
          <span key={l.id} className="label-chip">
            <LabelDot color={l.color} />
            {l.name}
          </span>
        ))}
        {issue.dueDate && (
          <span className={`due due-${due}`} title={`Due ${issue.dueDate}`}>
            {formatDueDate(issue.dueDate)}
          </span>
        )}
        <AvatarStack ids={issue.assigneeIds} members={members} size={20} />
      </span>
    </>
  );
  if (temp) {
    return (
      <div className="issue-row pending" aria-busy="true">
        {content}
      </div>
    );
  }
  return (
    <Link
      to={paths.issue(slug, issue.identifier)}
      className="issue-row"
      data-issue-row
      data-issue-id={issue.id}
      onFocus={() => currentIssueStore.set(issue.id)}
      onBlur={() => {
        if (currentIssueStore.get() === issue.id) currentIssueStore.set(null);
      }}
    >
      {content}
    </Link>
  );
}

export function IssueList({
  issues,
  teamId,
  emptyText,
  statusIds,
}: {
  issues: Issue[];
  teamId?: string;
  emptyText?: string;
  statusIds?: string[];
}) {
  const { slug, canEdit } = useWs();
  const states = useStates(slug);
  const labels = useLabels(slug);
  const members = useMembers(slug);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useRowNavigation();
  const groups = useMemo(() => groupByStatus(issues, states.data, teamId, statusIds), [issues, states.data, teamId, statusIds]);
  const labelById = useMemo(() => new Map((labels.data ?? []).map((l) => [l.id, l])), [labels.data]);
  const memberById = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m])), [members.data]);
  const stateById = useMemo(() => new Map((states.data ?? []).map((s) => [s.id, s])), [states.data]);

  if (issues.length === 0 && !teamId) {
    return (
      <div className="empty">
        <p className="empty-title">No issues here</p>
        <p className="empty-body">{emptyText ?? "Try other filters, or press C to create one."}</p>
      </div>
    );
  }
  return (
    <div className="issue-list">
      {groups.map((g) => {
        const isCollapsed = collapsed[g.key];
        return (
          <section key={g.key} className="issue-group" aria-label={g.name}>
            <div className="group-header">
              <button
                type="button"
                className="group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
              >
                {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                <StatusIcon state={g.state} />
                <span className="group-name">{g.name}</span>
                <span className="group-count">{g.issues.length}</span>
              </button>
              {g.statusId && canEdit && (
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`New issue in ${g.name}`}
                  onClick={() => ui.openCreate({ teamId, statusId: g.statusId })}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            {!isCollapsed && g.issues.length > 0 && (
              <ul className="issue-rows">
                {g.issues.map((i) => (
                  <li key={i.id}>
                    <IssueRow
                      issue={i}
                      state={stateById.get(i.statusId)}
                      showStatus={false}
                      labels={i.labelIds.map((id) => labelById.get(id)).filter((l): l is Label => Boolean(l))}
                      members={memberById}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {issues.length === 0 && <p className="muted center pad">{emptyText ?? "No issues match. Press C to create one."}</p>}
    </div>
  );
}
