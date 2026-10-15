import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "./components/Feedback";
import { IndexPage, InvitePage, LoginPage, NewWorkspacePage, VerifyPage } from "./features/auth/pages";
import { AdminPage } from "./features/admin/AdminPage";
import { CyclesPage } from "./features/cycles/CyclesPage";
import { FinancesPage } from "./features/finances/FinancesPage";
import { PublicFormPage } from "./features/forms/PublicFormPage";
import { InboxPage } from "./features/inbox/InboxPage";
import { IssueDetailPage } from "./features/issue/IssueDetail";
import { MyIssuesPage, TeamBacklogPage, TeamBoardPage, TeamIssuesPage, ViewPage } from "./features/issues/pages";
import { SettingsPage } from "./features/settings/SettingsPage";
import { TimePage } from "./features/time/TimePage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { TimelinePage } from "./features/timeline/TimelinePage";
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
const financesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/finances", component: FinancesPage });
// Public request forms: no sign-in and no app shell.
const formRoute = createRoute({ getParentRoute: () => rootRoute, path: "/forms/$token", component: PublicFormPage });
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage });
const newWsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/new", component: NewWorkspacePage });

const wsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$slug", component: WorkspaceLayout });
const child = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => wsRoute, path, component });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  verifyRoute,
  inviteRoute,
  newWsRoute,
  financesRoute,
  formRoute,
  adminRoute,
  wsRoute.addChildren([
    child("/", WorkspaceIndex),
    child("inbox", InboxPage),
    child("my-issues", MyIssuesPage),
    child("team/$teamKey/issues", TeamIssuesPage),
    child("team/$teamKey/board", TeamBoardPage),
    child("team/$teamKey/backlog", TeamBacklogPage),
    child("team/$teamKey/cycles", CyclesPage),
    child("team/$teamKey/timeline", TimelinePage),
    child("view/$viewId", ViewPage),
    child("issue/$identifier", IssueDetailPage),
    child("time", TimePage),
    child("reports", ReportsPage),
    child("settings", SettingsPage),
    child("settings/$tab", SettingsPage),
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
  const s = p.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
  return s ? `?${s}` : "";
}

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: true, parseSearch, stringifySearch });
