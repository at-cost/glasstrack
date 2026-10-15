import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleUser,
  Columns3,
  Inbox,
  Landmark,
  ShieldCheck,
  Layers,
  ListTodo,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Archive,
  Eye,
  Clock,
  KeyRound,
  ChartColumn,
  ChartGantt,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FullPageLoading } from "../../components/Feedback";
import { Popover } from "../../components/Picker";
import { ApiError, api, errorMessage } from "../../lib/api";
import { lastWorkspace, paths, rememberWorkspace } from "../../lib/paths";
import { keys, useBilling, useMe, useOperator, useTeams, useUnreadCount, useViews, useWorkspace } from "../../lib/queries";
import { useRealtime } from "../../lib/realtime";
import { setReadOnly, ui, useReadOnly, useSsoRequired, useUi } from "../../lib/store";
import { effectiveTheme, toggleTheme, useTheme } from "../../lib/theme";
import { CreateIssueDialog } from "../issue/CreateIssueDialog";
import { QuickPicker } from "../issue/QuickPicker";
import { CommandPalette } from "../palette/CommandPalette";
import { ShortcutsHelp, useGlobalShortcuts } from "../palette/shortcuts";
import { type WsContext, WorkspaceCtx, useWs } from "./context";
import { TimerPill } from "./TimerPill";

export function WorkspaceLayout() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useMe();
  const ws = useWorkspace(slug);
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const location = useRouterState({ select: (s) => s.location.href });
  const ssoRequired = useSsoRequired();

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      navigate({ to: "/login", search: { redirect: location }, replace: true });
    }
  }, [me.error, navigate, location]);

  useEffect(() => {
    if (ws.data) {
      rememberWorkspace(slug);
      setReadOnly(ws.data.status === "read_only");
    }
  }, [ws.data, slug]);

  useRealtime(slug, Boolean(ws.data));

  const ctx = useMemo<WsContext | null>(
    () => (me.data && ws.data ? { slug, workspace: ws.data, me: me.data, isAdmin: ws.data.role === "admin", canEdit: !readOnly } : null),
    [me.data, ws.data, slug, readOnly],
  );

  if (ssoRequired === slug || (ws.error instanceof ApiError && ws.error.code === "sso_required")) {
    return <SsoRequiredPage slug={slug} redirectTo={location} />;
  }
  if (ws.error) {
    const notFound = ws.error instanceof ApiError && ws.error.status === 404;
    if (ws.error instanceof ApiError && ws.error.status === 401) return <FullPageLoading />;
    return (
      <main className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">{notFound ? "Workspace not found" : "Could not load"}</h1>
          <p className="muted center">{notFound ? "It may not exist, or you are not a member." : errorMessage(ws.error)}</p>
          <Link to="/" className="btn btn-primary btn-block" onClick={() => lastWorkspace() === slug && rememberWorkspace("")}>
            Go to your workspaces
          </Link>
        </div>
      </main>
    );
  }
  if (!ctx) return <FullPageLoading />;
  return (
    <WorkspaceCtx.Provider value={ctx}>
      <Shell />
    </WorkspaceCtx.Provider>
  );
}

/** Shown when the workspace only allows members who signed in through its SSO. */
function SsoRequiredPage({ slug, redirectTo }: { slug: string; redirectTo: string }) {
  const href = `/api/v1/auth/sso/${encodeURIComponent(slug)}/start?redirectTo=${encodeURIComponent(redirectTo || `/${slug}`)}`;
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden="true">
          <KeyRound size={26} />
        </div>
        <h1 className="auth-title">This workspace requires single sign-on</h1>
        <p className="muted center">Sign in with your company account to continue.</p>
        <a href={href} className="btn btn-primary btn-block">
          Sign in with SSO
        </a>
        <Link to="/" className="btn btn-block">
          Go to your workspaces
        </Link>
      </div>
    </main>
  );
}

function Shell() {
  const state = useUi();
  const readOnly = useReadOnly();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useGlobalShortcuts();
  // On small screens the menu is a drawer: move focus into it and let Escape close it.
  useEffect(() => {
    if (!state.navOpen) return;
    document.querySelector<HTMLElement>(".sidebar .close-nav")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ui.setNav(false);
        document.querySelector<HTMLElement>(".mobile-bar .icon-btn")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.navOpen]);
  // Close the mobile menu after each navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    ui.setNav(false);
  }, [pathname]);
  return (
    <div className={`app${state.navOpen ? " nav-open" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Sidebar />
      {state.navOpen && <div className="nav-scrim" onClick={() => ui.setNav(false)} aria-hidden="true" />}
      <div className="main-col">
        <div className="mobile-bar">
          <button type="button" className="icon-btn" aria-label="Open menu" aria-expanded={state.navOpen} onClick={() => ui.setNav(true)}>
            <Menu size={18} />
          </button>
          <span className="mobile-title">Glasstrack</span>
          <TimerPill compact />
          <button type="button" className="icon-btn" aria-label="Search" onClick={ui.openPalette}>
            <Search size={18} />
          </button>
        </div>
        {readOnly && <ReadOnlyBanner />}
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {state.createOpen && <CreateIssueDialog defaults={state.createDefaults} onClose={ui.closeCreate} />}
      {state.paletteOpen && <CommandPalette onClose={ui.closePalette} />}
      {state.helpOpen && <ShortcutsHelp onClose={ui.closeHelp} />}
      {state.picker && <QuickPicker kind={state.picker.kind} issueRef={state.picker.issueRef} onClose={ui.closePicker} />}
    </div>
  );
}

function ReadOnlyBanner() {
  const { slug, isAdmin } = useWs();
  const billing = useBilling(slug);
  return (
    <div className="banner" role="status">
      This workspace is read-only. You can view and export everything, but changes are turned off.
      {billing.data?.enabled &&
        (isAdmin ? (
          <>
            {" "}
            <Link to={paths.settings(slug, "billing")}>Add credit to turn editing back on</Link>.
          </>
        ) : (
          " An admin can add credit to turn editing back on."
        ))}
    </div>
  );
}

function NavLink({
  to,
  icon,
  children,
  badge,
  exact,
}: {
  to: string;
  icon: React.ReactNode;
  children: string;
  badge?: number;
  exact?: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [base] = to.split("?");
  const active = exact ? pathname === base : pathname === base || pathname.startsWith(`${base}/`);
  return (
    <Link to={to} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
      <span className="nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-text">{children}</span>
      {badge ? (
        <>
          <span className="nav-badge" aria-hidden="true">
            {badge > 99 ? "99+" : badge}
          </span>
          <span className="sr-only">, {badge} unread</span>
        </>
      ) : null}
    </Link>
  );
}

function Sidebar() {
  const { slug, me } = useWsSafe();
  const readOnly = useReadOnly();
  const teams = useTeams(slug);
  const views = useViews(slug);
  const unread = useUnreadCount(slug);
  const billing = useBilling(slug);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const themeChoice = useTheme();
  const dark = effectiveTheme(themeChoice) === "dark";

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-top">
        <WorkspaceSwitcher />
        <button type="button" className="icon-btn close-nav" aria-label="Close menu" onClick={() => ui.setNav(false)}>
          <X size={18} />
        </button>
      </div>
      <div className="sidebar-actions">
        <button
          type="button"
          className="btn btn-primary new-issue"
          data-testid="new-issue-button"
          disabled={readOnly}
          onClick={() => ui.openCreate()}
        >
          <Plus size={15} aria-hidden="true" />
          New issue
        </button>
        <button
          type="button"
          className="icon-btn bordered"
          aria-label="Search and commands"
          title="Search (Ctrl K)"
          onClick={ui.openPalette}
        >
          <Search size={16} />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className="nav-section">
          <NavLink to={paths.inbox(slug)} icon={<Inbox size={16} />} badge={unread.data?.count}>
            Inbox
          </NavLink>
          <NavLink to={paths.myIssues(slug)} icon={<CircleUser size={16} />}>
            My issues
          </NavLink>
        </div>
        <div className="nav-section">
          <div className="nav-heading">Teams</div>
          {teams.data?.map((t) => {
            const isCollapsed = collapsed[t.id];
            return (
              <div key={t.id} className="nav-team">
                <button
                  type="button"
                  className="nav-team-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((c) => ({ ...c, [t.id]: !c[t.id] }))}
                >
                  {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  <span className="team-key">{t.key}</span>
                  <span className="nav-text">{t.name}</span>
                </button>
                {!isCollapsed && (
                  <div className="nav-team-links">
                    <NavLink to={paths.teamIssues(slug, t.key)} icon={<ListTodo size={15} />}>
                      Issues
                    </NavLink>
                    <NavLink to={paths.teamBoard(slug, t.key)} icon={<Columns3 size={15} />}>
                      Board
                    </NavLink>
                    <NavLink to={paths.teamBacklog(slug, t.key)} icon={<Archive size={15} />}>
                      Backlog
                    </NavLink>
                    <NavLink to={paths.teamCycles(slug, t.key)} icon={<RefreshCw size={15} />}>
                      Cycles
                    </NavLink>
                    <NavLink to={paths.teamTimeline(slug, t.key)} icon={<ChartGantt size={15} />}>
                      Timeline
                    </NavLink>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {(views.data?.length ?? 0) > 0 && (
          <div className="nav-section">
            <div className="nav-heading">Views</div>
            {views.data!.map((v) => (
              <NavLink key={v.id} to={paths.view(slug, v.id)} icon={v.shared ? <Layers size={15} /> : <Eye size={15} />}>
                {v.name}
              </NavLink>
            ))}
          </div>
        )}
      </div>
      <div className="sidebar-bottom">
        <TimerPill />
        <NavLink to={paths.time(slug)} icon={<Clock size={16} />}>
          Time
        </NavLink>
        <NavLink to={paths.reports(slug)} icon={<ChartColumn size={16} />}>
          Reports
        </NavLink>
        <NavLink to={paths.settings(slug)} icon={<Settings size={16} />}>
          Settings
        </NavLink>
        {billing.data?.enabled && (
          <NavLink to={paths.finances()} icon={<Landmark size={16} />}>
            Public finances
          </NavLink>
        )}
        <div className="sidebar-bottom-row">
          <UserMenu name={me.name} email={me.email} />
          <button
            type="button"
            className="icon-btn"
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            title={dark ? "Light theme" : "Dark theme"}
            onClick={toggleTheme}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>
    </nav>
  );
}

function useWsSafe() {
  const ctx = useMe();
  const { slug } = useParams({ strict: false }) as { slug: string };
  return { slug, me: ctx.data! };
}

function WorkspaceSwitcher() {
  const { slug, me } = useWsSafe();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const current = me.workspaces.find((w) => w.slug === slug);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <>
      <button ref={btn} type="button" className="ws-switcher" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ws-badge" aria-hidden="true">
          {(current?.name ?? slug).slice(0, 1).toUpperCase()}
        </span>
        <span className="ws-name">{current?.name ?? slug}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={close} label="Workspaces" width={240}>
          <MenuList
            items={[
              ...me.workspaces.map((w) => ({
                id: w.slug,
                label: w.name,
                icon: w.slug === slug ? <Check size={14} /> : <span style={{ width: 14 }} />,
                onSelect: () => navigate({ to: paths.home(w.slug) }),
              })),
              { id: "__new", label: "New workspace", icon: <Plus size={14} />, onSelect: () => navigate({ to: "/new" }) },
            ]}
            onClose={() => setOpen(false)}
          />
        </Popover>
      )}
    </>
  );
}

export function MenuList({
  items,
  onClose,
}: {
  items: { id: string; label: string; icon?: React.ReactNode; onSelect: () => void; danger?: boolean }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  };
  return (
    <div ref={ref} role="menu" className="menu" onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          className={`menu-item${it.danger ? " danger" : ""}`}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.icon && (
            <span className="option-icon" aria-hidden="true">
              {it.icon}
            </span>
          )}
          {it.label}
        </button>
      ))}
    </div>
  );
}

function UserMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const operator = useOperator();
  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      qc.clear();
      navigate({ to: "/login" });
    }
  };
  return (
    <>
      <button ref={btn} type="button" className="user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="user-name">{name}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <Popover
          anchor={btn.current}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
          label="Account"
          width={220}
        >
          <div className="menu-caption">{email}</div>
          <MenuList
            items={[
              {
                id: "profile",
                label: "Profile",
                icon: <CircleUser size={14} />,
                onSelect: () => navigate({ to: paths.settings(slug, "profile") }),
              },
              ...(operator.data?.operator
                ? [{ id: "admin", label: "Operator admin", icon: <ShieldCheck size={14} />, onSelect: () => navigate({ to: paths.admin() }) }]
                : []),
              { id: "out", label: "Sign out", icon: <LogOut size={14} />, onSelect: signOut },
            ]}
            onClose={() => setOpen(false)}
          />
        </Popover>
      )}
    </>
  );
}

/** Redirect /:slug to the default page. */
export function WorkspaceIndex() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: paths.myIssues(slug), replace: true });
  }, [slug, navigate]);
  return null;
}

export { keys };
