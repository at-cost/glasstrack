import { useEffect } from "react";
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { Toaster } from "./components/Feedback";
import { IndexPage, InvitePage, LoginPage, NewWorkspacePage, VerifyPage } from "./features/auth/pages";
import { AdminPage } from "./features/admin/AdminPage";
import { CyclesPage } from "./features/cycles/CyclesPage";
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

/** Pages the server renders (the public website). A client-side link to one needs a full page load. */
const SERVER_PAGES = /^\/(|pricing|finances|about|how-its-run|self-host|terms|privacy|dpa|contact|status)$/;

function NotFound() {
  const serverPage = SERVER_PAGES.test(window.location.pathname);
  useEffect(() => {
    if (serverPage) window.location.replace(window.location.pathname + window.location.search + window.location.hash);
  }, [serverPage]);
  if (serverPage) return null;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Page not found</h1>
        <p className="muted center">The link may be old or mistyped.</p>
        <Link to="/app" className="btn btn-primary btn-block">
          Go to your workspaces
        </Link>
        <a href="/" className="btn btn-block">
          Glasstrack home
        </a>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

// "/" is the server-rendered public website; the app starts at /app.
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/app", component: IndexPage });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const verifyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/auth/verify", component: VerifyPage });
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/$token", component: InvitePage });
// Public request forms: no sign-in and no app shell.
const formRoute = createRoute({ getParentRoute: () => rootRoute, path: "/forms/$token", component: PublicFormPage });
const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage });
const newWsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/new", component: NewWorkspacePage });

const wsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug",
  component: WorkspaceLayout,
  // A client-side link to a public page (/finances, /pricing...) must load it from the server.
  beforeLoad: ({ location }) => {
    if (SERVER_PAGES.test(location.pathname)) {
      window.location.assign(location.href);
      return new Promise<never>(() => {});
    }
  },
});
const child = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => wsRoute, path, component });

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  verifyRoute,
  inviteRoute,
  newWsRoute,
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
