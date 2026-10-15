import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { IssueFilter, Team } from "@glasstrack/shared";
import { ChartGantt, Columns3, ListTodo, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage } from "../../lib/api";
import { filterToSearch, isEmptyFilter, mergeFilters, searchToFilter } from "../../lib/filters";
import { paths } from "../../lib/paths";
import { keys, useIssues, useStates, useTeams, useViews } from "../../lib/queries";
import { ui } from "../../lib/store";
import { toast, toastError } from "../../lib/toast";
import { Board } from "../board/Board";
import { useWs } from "../shell/context";
import { FilterBar, useFilterSearch } from "./FilterBar";
import { IssueList } from "./IssueList";

export function PageHeader({ title, children, sub }: { title: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-title-wrap">
        <h1 className="page-title">{title}</h1>
        {sub && <span className="page-sub">{sub}</span>}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}

function IssuesView({
  title,
  baseFilter,
  team,
  layout,
  hide,
  emptyText,
  headerExtra,
  layoutSwitch,
}: {
  title: ReactNode;
  baseFilter: IssueFilter;
  team?: Team;
  layout: "list" | "board";
  hide?: ("status" | "assignee" | "cycle")[];
  emptyText?: string;
  headerExtra?: ReactNode;
  layoutSwitch?: ReactNode;
}) {
  const { slug, canEdit } = useWs();
  const [fs] = useFilterSearch();
  const filter = useMemo(() => mergeFilters(baseFilter, searchToFilter(fs)), [baseFilter, fs]);
  const issues = useIssues(slug, { ...filter, order: "manual" });
  const count = issues.data?.issues.length;
  return (
    <div className="page">
      <PageHeader title={title} sub={count !== undefined ? `${count}${issues.data?.hasMore ? "+" : ""} issues` : undefined}>
        {layoutSwitch}
        {headerExtra}
        {canEdit && (
          <button type="button" className="btn btn-sm hide-mobile" onClick={() => ui.openCreate(team ? { teamId: team.id } : {})}>
            <Plus size={14} aria-hidden="true" />
            Issue
          </button>
        )}
      </PageHeader>
      <FilterBar teamId={team?.id} hide={hide} savedFilter={filter} layout={layout} />
      <div className="page-body">
        {issues.isPending ? (
          <Skeleton />
        ) : issues.error ? (
          <Empty title="Could not load issues">{errorMessage(issues.error)}</Empty>
        ) : layout === "board" && team ? (
          <Board issues={issues.data.issues} teamId={team.id} statusIds={filter.status} />
        ) : (
          <IssueList issues={issues.data.issues} teamId={team?.id} statusIds={filter.status} emptyText={emptyText} />
        )}
      </div>
    </div>
  );
}

export function useTeamByKey(): { team: Team | undefined; loading: boolean } {
  const { slug } = useWs();
  const { teamKey } = useParams({ strict: false }) as { teamKey: string };
  const teams = useTeams(slug);
  return { team: teams.data?.find((t) => t.key.toLowerCase() === teamKey?.toLowerCase()), loading: teams.isPending };
}

export function TeamMissing({ loading }: { loading: boolean }) {
  if (loading) return <Skeleton />;
  return <Empty title="Team not found">It may have been archived or renamed.</Empty>;
}

export function TeamLayoutSwitch({ team, current }: { team: Team; current: "list" | "board" | "timeline" }) {
  const { slug } = useWs();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const keep = filterToSearch(searchToFilter(search as never));
  return (
    <fieldset className="segmented">
      <legend className="sr-only">Layout</legend>
      <Link
        to={paths.teamIssues(slug, team.key)}
        search={keep}
        className={`seg${current === "list" ? " active" : ""}`}
        aria-current={current === "list" ? "page" : undefined}
      >
        <ListTodo size={14} aria-hidden="true" />
        <span className="sr-only">Show as list</span>
      </Link>
      <Link
        to={paths.teamBoard(slug, team.key)}
        search={keep}
        className={`seg${current === "board" ? " active" : ""}`}
        aria-current={current === "board" ? "page" : undefined}
      >
        <Columns3 size={14} aria-hidden="true" />
        <span className="sr-only">Show as columns</span>
      </Link>
      <Link
        to={paths.teamTimeline(slug, team.key)}
        search={keep}
        className={`seg${current === "timeline" ? " active" : ""}`}
        aria-current={current === "timeline" ? "page" : undefined}
      >
        <ChartGantt size={14} aria-hidden="true" />
        <span className="sr-only">Show as timeline</span>
      </Link>
    </fieldset>
  );
}

export function MyIssuesPage() {
  const base = useMemo<IssueFilter>(() => ({ assignee: ["me"] }), []);
  return (
    <IssuesView title="My issues" baseFilter={base} layout="list" hide={["assignee"]} emptyText="Nothing is assigned to you right now." />
  );
}

export function TeamIssuesPage() {
  const { team, loading } = useTeamByKey();
  const base = useMemo<IssueFilter>(() => (team ? { team: team.id } : {}), [team]);
  if (!team) return <TeamMissing loading={loading} />;
  return (
    <IssuesView
      key={team.id}
      title={team.name}
      baseFilter={base}
      team={team}
      layout="list"
      layoutSwitch={<TeamLayoutSwitch team={team} current="list" />}
    />
  );
}

export function TeamBoardPage() {
  const { team, loading } = useTeamByKey();
  const base = useMemo<IssueFilter>(() => (team ? { team: team.id } : {}), [team]);
  if (!team) return <TeamMissing loading={loading} />;
  return (
    <IssuesView
      key={team.id}
      title={`${team.name} board`}
      baseFilter={base}
      team={team}
      layout="board"
      layoutSwitch={<TeamLayoutSwitch team={team} current="board" />}
    />
  );
}

export function TeamBacklogPage() {
  const { slug } = useWs();
  const { team, loading } = useTeamByKey();
  const states = useStates(slug);
  const base = useMemo<IssueFilter>(() => {
    if (!team) return {};
    const ids = (states.data ?? []).filter((s) => s.teamId === team.id && s.category === "backlog").map((s) => s.id);
    return { team: team.id, status: ids.length ? ids : ["00000000-0000-0000-0000-000000000000"] };
  }, [team, states.data]);
  if (!team || states.isPending) return <TeamMissing loading={loading || states.isPending} />;
  return (
    <IssuesView
      key={team.id}
      title={`${team.name} backlog`}
      baseFilter={base}
      team={team}
      layout="list"
      hide={["status"]}
      emptyText="The backlog is empty."
    />
  );
}

export function ViewPage() {
  const { slug, me, isAdmin, canEdit } = useWs();
  const { viewId } = useParams({ strict: false }) as { viewId: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const views = useViews(slug);
  const teams = useTeams(slug);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [fs] = useFilterSearch();
  const view = views.data?.find((v) => v.id === viewId);
  const base = useMemo<IssueFilter>(() => view?.filters ?? {}, [view]);
  if (views.isPending) return <Skeleton />;
  if (!view) return <Empty title="View not found">It may have been deleted.</Empty>;
  const teamId = view.teamId ?? view.filters.team;
  const team = teams.data?.find((t) => t.id === teamId);
  const layout = search.layout === "board" || search.layout === "list" ? search.layout : view.layout;
  const canManage = view.ownerId === me.id || isAdmin;
  const merged = mergeFilters(base, searchToFilter(fs));

  const updateView = async () => {
    try {
      await api.ws(slug).updateView(view.id, { filters: merged, layout });
      await qc.invalidateQueries({ queryKey: keys.views(slug) });
      navigate({ to: paths.view(slug, view.id), replace: true });
      toast("View updated", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const remove = async () => {
    try {
      await api.ws(slug).deleteView(view.id);
      await qc.invalidateQueries({ queryKey: keys.views(slug) });
      toast("View deleted", "success");
      navigate({ to: paths.myIssues(slug) });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const dirty = !isEmptyFilter(fs) || (search.layout !== undefined && search.layout !== view.layout);
  return (
    <>
      <IssuesView
        key={view.id}
        title={view.name}
        baseFilter={base}
        team={team}
        layout={layout}
        layoutSwitch={
          team ? (
            <fieldset className="segmented">
              <legend className="sr-only">Layout</legend>
              <Link
                to={paths.view(slug, view.id)}
                search={{ ...fs, layout: "list" }}
                className={`seg${layout === "list" ? " active" : ""}`}
              >
                <ListTodo size={14} aria-hidden="true" />
                <span className="sr-only">Show as list</span>
              </Link>
              <Link
                to={paths.view(slug, view.id)}
                search={{ ...fs, layout: "board" }}
                className={`seg${layout === "board" ? " active" : ""}`}
              >
                <Columns3 size={14} aria-hidden="true" />
                <span className="sr-only">Show as columns</span>
              </Link>
            </fieldset>
          ) : null
        }
        headerExtra={
          canManage && canEdit ? (
            <>
              {dirty && (
                <button type="button" className="btn btn-sm" onClick={updateView}>
                  Update view
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Delete view" onClick={() => setConfirm(true)}>
                <Trash2 size={15} />
              </button>
            </>
          ) : null
        }
      />
      {confirm && (
        <ConfirmDialog
          title="Delete view?"
          message={`"${view.name}" will be removed for everyone who sees it.`}
          confirmLabel="Delete view"
          danger
          onConfirm={remove}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}
