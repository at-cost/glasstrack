import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { KeyRound, Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Focuses the first [data-autofocus] field inside the card once it renders. */
function useAutoFocusIn(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [ref]);
}
import { estimateEmails, monthlyCost, type PricingSettings } from "@glasstrack/shared";
import { FullPageLoading, Spinner } from "../../components/Feedback";
import { ApiError, api, errorMessage } from "../../lib/api";
import { slugify } from "../../lib/format";
import { lastWorkspace, paths } from "../../lib/paths";
import { keys, useMe } from "../../lib/queries";

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useAutoFocusIn(ref);
  return (
    <main className="auth-page">
      <div className="auth-card" ref={ref}>
        <div className="brand-mark" aria-hidden="true">
          <img src="/favicon.svg" alt="" width={28} height={28} />
        </div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  oauth_state: "Sign-in was interrupted. Please try again.",
  oauth_provider: "That sign-in method is not available.",
  oauth_failed: "We could not sign you in with that account.",
  sso_not_configured: "Single sign-on isn't set up for that workspace.",
  sso_provider: "We couldn't reach your company's sign-in provider. Try again, or ask an admin to check the setup.",
  sso_state: "Sign-in was interrupted. Please try again.",
  sso_denied: "Sign-in was cancelled at your company's sign-in page.",
  sso_failed: "We couldn't sign you in with single sign-on. Try again, or ask an admin to check the setup.",
  sso_no_email: "Your company's sign-in didn't share an email address. Ask an admin to allow the email scope.",
  sso_email_unverified: "Your email address isn't verified with your company's sign-in provider.",
  sso_domain: "Your email domain isn't allowed for this workspace.",
  sso_not_member: "You're not a member of this workspace yet. Ask an admin to invite you.",
};

const ssoStart = (slug: string, redirectTo: string) =>
  `/api/v1/auth/sso/${encodeURIComponent(slug)}/start?redirectTo=${encodeURIComponent(redirectTo === "/" || redirectTo === "/app" ? `/${slug}` : redirectTo)}`;

/** Finds the workspaces that offer SSO for a work email, then hands over to the provider. */
function SsoLookup({ redirect, onBack }: { redirect: string; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ slug: string; name: string }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const r = await api.ssoDiscover(email.trim());
      if (r.workspaces.length === 1) {
        window.location.assign(ssoStart(r.workspaces[0]!.slug, redirect));
        return;
      }
      if (r.workspaces.length === 0) setError("No single sign-on is set up for that email domain.");
      else setFound(r.workspaces);
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">Work email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            ref={input}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="you@company.com"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email.trim()}>
          {busy ? <Spinner label="Looking up" /> : <KeyRound size={15} aria-hidden="true" />}
          Find my workspace
        </button>
      </form>
      {found && (
        <div className="stack-sm">
          <p className="muted small">Pick a workspace to sign in to:</p>
          {found.map((w) => (
            <a key={w.slug} className="btn btn-block" href={ssoStart(w.slug, redirect)}>
              {w.name}
            </a>
          ))}
        </div>
      )}
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        Use another way to sign in
      </button>
    </>
  );
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { redirect?: string; error?: string; signup?: string };
  // "/" is the public website, so signing in from it lands in the app instead.
  const redirect = typeof search.redirect === "string" && search.redirect.startsWith("/") && search.redirect !== "/" ? search.redirect : "/app";
  const signup = search.signup !== undefined && search.signup !== "0";
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, staleTime: Infinity });
  const me = useMe();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(search.error ? (OAUTH_ERRORS[search.error] ?? "Sign-in failed.") : null);
  const [sso, setSso] = useState(false);

  useEffect(() => {
    if (me.data) navigate({ to: redirect, replace: true });
  }, [me.data, redirect, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.magicLink(email.trim(), redirect);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="muted center">
          We sent a sign-in link to <strong>{email}</strong>. It works once and expires in 15 minutes.
        </p>
        <button type="button" className="btn btn-block" onClick={() => setSent(false)}>
          Use a different email
        </button>
      </AuthCard>
    );
  }

  const oauth = (p: "google" | "github") => `/api/v1/auth/oauth/${p}?redirectTo=${encodeURIComponent(redirect)}`;
  if (sso) {
    return (
      <AuthCard title="Sign in with SSO">
        <SsoLookup
          redirect={redirect}
          onBack={() => {
            setSso(false);
            setError(null);
          }}
        />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={signup ? "Create your account" : "Sign in"}>
      {signup && <p className="muted center">Enter your email and we'll send you a link to get started.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {(providers.data?.google || providers.data?.github) && (
        <div className="stack-sm">
          {providers.data.google && (
            <a className="btn btn-block" href={oauth("google")}>
              Continue with Google
            </a>
          )}
          {providers.data.github && (
            <a className="btn btn-block" href={oauth("github")}>
              Continue with GitHub
            </a>
          )}
          <div className="divider">
            <span>or</span>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            data-autofocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email.trim()}>
          {busy ? <Spinner label="Sending" /> : <Mail size={15} aria-hidden="true" />}
          {signup ? "Email me a sign-up link" : "Email me a sign-in link"}
        </button>
      </form>
      <button
        type="button"
        className="btn btn-block"
        onClick={() => {
          setSso(true);
          setError(null);
        }}
      >
        <KeyRound size={15} aria-hidden="true" />
        Sign in with SSO
      </button>
    </AuthCard>
  );
}

export function VerifyPage() {
  const search = useSearch({ strict: false }) as { token?: unknown };
  const token = search.token === undefined ? "" : String(search.token);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setError("This sign-in link is missing its token.");
      return;
    }
    api
      .verifyMagicLink(token)
      .then(async (r) => {
        await qc.invalidateQueries({ queryKey: keys.me });
        navigate({ to: r.redirectTo && r.redirectTo !== "/" ? r.redirectTo : "/app", replace: true });
      })
      .catch((e) => setError(errorMessage(e)));
  }, [token, navigate, qc]);
  if (!error) return <FullPageLoading />;
  return (
    <AuthCard title="Sign-in link problem">
      <p className="muted center">{error}</p>
      <Link to="/login" className="btn btn-primary btn-block">
        Back to sign in
      </Link>
    </AuthCard>
  );
}

export function InvitePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.invitePreview(token),
    enabled: Boolean(me.data),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      navigate({ to: "/login", search: { redirect: `/invite/${token}` }, replace: true });
    }
  }, [me.error, token, navigate]);

  if (me.isPending || (me.data && preview.isPending)) return <FullPageLoading />;
  if (preview.error) {
    return (
      <AuthCard title="Invite not found">
        <p className="muted center">{errorMessage(preview.error)}</p>
        <Link to="/app" className="btn btn-block">
          Go to your workspaces
        </Link>
      </AuthCard>
    );
  }
  if (!preview.data) return <FullPageLoading />;
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.acceptInvite(token);
      await qc.invalidateQueries({ queryKey: keys.me });
      navigate({ to: paths.home(r.slug), replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <AuthCard title={`Join ${preview.data.workspaceName}`}>
      <p className="muted center">
        You were invited as {preview.data.role === "admin" ? "an admin" : `a ${preview.data.role}`}. You are signed in as{" "}
        <strong>{me.data?.email}</strong>.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-block" onClick={accept} disabled={busy}>
        Accept invite
      </button>
    </AuthCard>
  );
}

export function IndexPage() {
  const me = useMe();
  const navigate = useNavigate();
  useEffect(() => {
    if (me.error) {
      if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login", replace: true });
      return;
    }
    if (!me.data) return;
    const ws = me.data.workspaces;
    if (ws.length === 0) {
      navigate({ to: "/new", replace: true });
      return;
    }
    const last = lastWorkspace();
    const pick = ws.find((w) => w.slug === last) ?? ws[0]!;
    navigate({ to: paths.home(pick.slug), replace: true });
  }, [me.data, me.error, navigate]);
  if (me.error && !(me.error instanceof ApiError && me.error.status === 401)) {
    return (
      <AuthCard title="Could not load">
        <p className="muted center">{errorMessage(me.error)}</p>
        <button type="button" className="btn btn-block" onClick={() => me.refetch()}>
          Try again
        </button>
      </AuthCard>
    );
  }
  return <FullPageLoading />;
}

const usdWhole = (micro: number) => `$${Math.round(micro / 1_000_000).toLocaleString("en-US")}`;

/**
 * Only on servers with billing on: the new workspace's credit and what a typical
 * team (20 people, 5 GB, the default emails) pays, from the shared pricing module.
 */
async function creditWelcome(slug: string): Promise<{ balanceMicro: number; typicalMicro: number } | null> {
  try {
    const billing = await api.ws(slug).billing();
    if (!billing.enabled || billing.balanceMicro <= 0) return null;
    const res = await fetch("/api/v1/public/pricing", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const p = (await res.json()) as { settings: PricingSettings; sharedFixedMonthMicro: number; activeWorkspaces: number };
    const typical = monthlyCost({
      settings: p.settings,
      sharedFixedMonthMicro: p.sharedFixedMonthMicro,
      activeWorkspaces: p.activeWorkspaces,
      storageGb: 5,
      emailsPerMonth: estimateEmails(20),
    });
    return { balanceMicro: billing.balanceMicro, typicalMicro: typical.totalMicro };
  } catch {
    return null;
  }
}

export function NewWorkspacePage() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [welcome, setWelcome] = useState<{ slug: string; balanceMicro: number; typicalMicro: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) navigate({ to: "/login", search: { redirect: "/new" }, replace: true });
  }, [me.error, navigate]);

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugValid = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(effectiveSlug);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slugValid) {
      setError("The URL needs 3 to 40 lowercase letters, digits or dashes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await api.createWorkspace(name.trim(), effectiveSlug);
      await qc.invalidateQueries({ queryKey: keys.me });
      const credit = await creditWelcome(ws.slug);
      if (credit) setWelcome({ slug: ws.slug, ...credit });
      else navigate({ to: paths.home(ws.slug), replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  if (me.isPending) return <FullPageLoading />;
  if (welcome) {
    return (
      <AuthCard title="Your workspace is ready">
        <p className="center">
          You have {usdWhole(welcome.balanceMicro)} of credit. A typical team uses about {usdWhole(welcome.typicalMicro)} a month.
        </p>
        <p className="muted center small">
          <a href="/pricing">How the price is worked out</a>
        </p>
        <Link to={paths.home(welcome.slug)} className="btn btn-primary btn-block" data-autofocus>
          Open workspace
        </Link>
      </AuthCard>
    );
  }
  const hasWorkspaces = (me.data?.workspaces.length ?? 0) > 0;
  return (
    <AuthCard title={hasWorkspaces ? "New workspace" : "Create your workspace"}>
      <p className="muted center">A workspace holds your teams and their issues.</p>
      <form onSubmit={submit} className="stack">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor="ws-name">
            Workspace name
          </label>
          <input
            id="ws-name"
            className="input"
            required
            data-autofocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="ws-slug">
            URL
          </label>
          <span className="input-prefix">
            <span className="prefix" aria-hidden="true">
              {window.location.host}/
            </span>
            <input
              id="ws-slug"
              className="input"
              required
              maxLength={40}
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              aria-invalid={effectiveSlug.length > 0 && !slugValid}
              aria-describedby="ws-slug-hint"
              placeholder="acme"
            />
          </span>
          <span className="field-hint" id="ws-slug-hint">
            Lowercase letters, digits and dashes.
          </span>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !name.trim()}>
          Create workspace
        </button>
        {hasWorkspaces && (
          <Link to="/app" className="btn btn-ghost btn-block">
            Cancel
          </Link>
        )}
      </form>
    </AuthCard>
  );
}
