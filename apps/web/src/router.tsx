import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "./components/Feedback";
import { IndexPage, InvitePage, LoginPage, NewWorkspacePage, VerifyPage } from "./features/auth/pages";
import { CyclesPage } from "./features/cycles/CyclesPage";
import { InboxPage } from "./features/inbox/InboxPage";
import { IssueDetailPage } from "./features/issue/IssueDetail";
import { MyIssuesPage, TeamBacklogPage, TeamBoardPage, TeamIssuesPage, ViewPage } from "./features/issues/pages";
import { SettingsPage } from "./features/settings/SettingsPage";
import { WorkspaceIndex, WorkspaceLayout } from "./features/shell/AppShell";

function Root() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Page not found</h1>
        <p className="muted center">The link may be old or mistyped.</p>
        <Link to="/" className="btn btn-primary btn-block">
          Go home
        </Link>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: IndexPage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const verifyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/auth/verify", component: VerifyPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/$token", component: InvitePage });
const newWsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/new", component: NewWorkspacePage });

const wsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$slug", component: WorkspaceLayout });
const child = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => wsRoute, path, component });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  verifyRoute,
  inviteRoute,
  newWsRoute,
  wsRoute.addChildren([
    child("/", WorkspaceIndex),
    child("inbox", InboxPage),
    child("my-issues", MyIssuesPage),
    child("team/$teamKey/issues", TeamIssuesPage),
    child("team/$teamKey/board", TeamBoardPage),
    child("team/$teamKey/backlog", TeamBacklogPage),
    child("team/$teamKey/cycles", CyclesPage),
    child("view/$viewId", ViewPage),
    child("issue/$identifier", IssueDetailPage),
    child("settings", SettingsPage),
  ]),
]);

/** Plain query strings (no JSON quoting), so filters read like ?status=a,b&priority=1. */
function parseSearch(search: string): Record<string, unknown> {
  return Object.fromEntries(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
}
function stringifySearch(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const s = p.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: true, parseSearch, stringifySearch });
