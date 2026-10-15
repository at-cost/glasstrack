import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  DIGEST_FREQUENCIES,
  type ExportJob,
  type Label,
  type Member,
  NOTIFICATION_KINDS,
  type NotificationSettings,
  type Role,
  STATE_CATEGORIES,
  type StateCategory,
  type Team,
  type WorkflowState,
} from "@glasstrack/shared";
import { ArrowDown, ArrowUp, Copy, Download, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { Avatar, LabelDot, LockIcon, StatusIcon } from "../../components/icons";
import { ApiError, api, errorMessage } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useBilling, useLabels, useMembers, useStates, useTeams } from "../../lib/queries";
import { setTheme, THEMES, type ThemeChoice, useTheme } from "../../lib/theme";
import { toast, toastError } from "../../lib/toast";
import { PageHeader } from "../issues/pages";
import { useWs } from "../shell/context";
import { Billing } from "./Billing";
import { GitHub } from "./GitHub";
import { Import } from "./Import";
import { Tokens } from "./Tokens";
import { Webhooks } from "./Webhooks";
import { AuditLog } from "./AuditLog";
import { Fields } from "./Fields";
import { InlineText } from "./InlineText";
import { Sso } from "./Sso";
import { Templates } from "./Templates";
import { Automations } from "./Automations";
import { GitForge } from "./GitForge";
import { Requests } from "./Requests";

const ALL_TABS = [
  { id: "general", label: "General" },
  { id: "members", label: "Members" },
  { id: "teams", label: "Teams" },
  { id: "fields", label: "Fields" },
  { id: "templates", label: "Templates" },
  { id: "automations", label: "Automations" },
  { id: "requests", label: "Requests" },
  { id: "notifications", label: "Notifications" },
  { id: "profile", label: "Profile" },
  { id: "billing", label: "Billing" },
  { id: "tokens", label: "API tokens" },
  { id: "webhooks", label: "Webhooks" },
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "gitea", label: "Gitea and Forgejo" },
  { id: "sso", label: "Single sign-on" },
  { id: "audit", label: "Audit log" },
  { id: "import", label: "Import" },
  { id: "data", label: "Data" },
] as const;
type TabId = (typeof ALL_TABS)[number]["id"];

export function SettingsPage() {
  const search = useSearch({ strict: false }) as { tab?: string };
  const params = useParams({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const { slug, isAdmin, workspace } = useWs();
  const billing = useBilling(slug);
  const tabs = ALL_TABS.filter((t) => {
    if (t.id === "billing") return billing.data?.enabled === true;
    if (["webhooks", "github", "gitlab", "gitea", "fields", "sso", "audit"].includes(t.id)) return isAdmin;
    if (t.id === "import" || t.id === "tokens" || t.id === "requests") return workspace.role === "admin" || workspace.role === "member";
    if (t.id === "templates") return workspace.role !== "guest";
    return true;
  });
  const wanted = params.tab ?? search.tab;
  const tab: TabId = (tabs.find((t) => t.id === wanted)?.id ?? "general") as TabId;
  // Old links used ?tab=; move them to the path form.
  useEffect(() => {
    if (!params.tab && search.tab && search.tab !== "general") {
      navigate({ to: paths.settings(slug, search.tab), replace: true });
    }
  }, [params.tab, search.tab, slug, navigate]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // On narrow screens the tabs scroll sideways; keep the current one in view.
  useEffect(() => {
    tabRefs.current[tab]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const go = (id: TabId) => navigate({ to: paths.settings(slug, id), replace: true });
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    go(id);
    tabRefs.current[id]?.focus();
  };
  const waitingForBilling = wanted === "billing" && billing.isPending;
  return (
    <div className="page settings">
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" className="settings-tabs" onKeyDown={onKey}>
          {tabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              onClick={() => go(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="settings-panel">
          {waitingForBilling ? (
            <Skeleton rows={4} />
          ) : (
            <>
              {tab === "general" && <General />}
              {tab === "members" && <Members />}
              {tab === "teams" && <Teams />}
              {tab === "notifications" && <Notifications />}
              {tab === "profile" && <Profile />}
              {tab === "billing" && <Billing />}
              {tab === "tokens" && <Tokens />}
              {tab === "webhooks" && <Webhooks />}
              {tab === "github" && <GitHub />}
              {tab === "gitlab" && <GitForge provider="gitlab" />}
              {tab === "gitea" && <GitForge provider="gitea" />}
              {tab === "requests" && <Requests />}
              {tab === "fields" && <Fields />}
              {tab === "templates" && <Templates />}
              {tab === "automations" && <Automations />}
              {tab === "sso" && <Sso />}
              {tab === "audit" && <AuditLog />}
              {tab === "import" && <Import />}
              {tab === "data" && <Data />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function General() {
  const { slug, workspace, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.ws(slug).rename(name.trim());
      await qc.invalidateQueries({ queryKey: keys.ws(slug) });
      await qc.invalidateQueries({ queryKey: keys.me });
      toast("Workspace renamed", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Workspace">
      <form className="stack" onSubmit={save}>
        <div className="field">
          <label className="field-label" htmlFor="ws-rename">
            Name
          </label>
          <input
            id="ws-rename"
            className="input"
            value={name}
            maxLength={80}
            disabled={!isAdmin || !canEdit}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <span className="field-label">URL</span>
          <span className="readonly-value">
            {window.location.host}/{slug}
          </span>
        </div>
        <p className="muted small">
          Your role: {ROLE_INFO[workspace.role].label}. {ROLE_INFO[workspace.role].text}
        </p>
        {isAdmin && canEdit && (
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === workspace.name}>
              Save
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function Members() {
  const { slug, me, isAdmin, isViewer, canEdit } = useWs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const members = useMembers(slug);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [guestTeams, setGuestTeams] = useState<Member | null>(null);
  const setRole = useMutation({
    mutationFn: ({ m, role }: { m: Member; role: Role }) => api.ws(slug).setRole(m.userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(slug) }),
    onError: (e) => {
      toastError(errorMessage(e));
      qc.invalidateQueries({ queryKey: keys.members(slug) });
    },
  });
  const remove = async (m: Member) => {
    try {
      await api.ws(slug).removeMember(m.userId);
      if (m.userId === me.id) {
        await qc.invalidateQueries({ queryKey: keys.me });
        navigate({ to: "/" });
        return;
      }
      await qc.invalidateQueries({ queryKey: keys.members(slug) });
      toast(`${m.name} was removed`, "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <>
      {isAdmin && canEdit && <InviteForm />}
      <Card title="Members">
        {members.isPending ? (
          <Skeleton rows={3} />
        ) : (
          <ul className="member-list">
            {members.data?.map((m) => (
              <li key={m.userId} className="member-row">
                <Avatar member={m} size={28} />
                <span className="member-info">
                  <span className="member-name">
                    {m.name}
                    {m.userId === me.id && <span className="muted"> (you)</span>}
                  </span>
                  <span className="muted small">
                    {m.email} · @{m.handle}
                  </span>
                </span>
                {isAdmin && canEdit ? (
                  <label>
                    <span className="sr-only">Role for {m.name}</span>
                    <select
                      className="select select-sm"
                      value={m.role}
                      title={ROLE_INFO[m.role].text}
                      onChange={(e) => setRole.mutate({ m, role: e.target.value as Role })}
                    >
                      {ROLE_ORDER.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_INFO[r].label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="badge" title={ROLE_INFO[m.role].text}>
                    {ROLE_INFO[m.role].label}
                  </span>
                )}
                {isAdmin && canEdit && m.role === "guest" && (
                  <button type="button" className="btn btn-sm" onClick={() => setGuestTeams(m)}>
                    Teams
                  </button>
                )}
                {((canEdit && isAdmin) || (m.userId === me.id && (canEdit || isViewer))) && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={m.userId === me.id ? "Leave workspace" : `Remove ${m.name}`}
                    onClick={() => setRemoving(m)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <RoleGuide />
      {isAdmin && <PendingInvites />}
      {removing && (
        <ConfirmDialog
          title={removing.userId === me.id ? "Leave this workspace?" : `Remove ${removing.name}?`}
          message={
            removing.userId === me.id
              ? "You lose access until someone invites you again."
              : "They lose access right away. Their issues are unassigned."
          }
          confirmLabel={removing.userId === me.id ? "Leave" : "Remove"}
          danger
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
      {guestTeams && <GuestTeamsDialog member={guestTeams} onClose={() => setGuestTeams(null)} />}
    </>
  );
}

/** Display order and one-line descriptions of the workspace roles. */
export const ROLE_ORDER: Role[] = ["admin", "member", "viewer", "guest"];
export const ROLE_INFO: Record<Role, { label: string; text: string }> = {
  admin: { label: "Admin", text: "Can change everything, including members, billing and settings." },
  member: { label: "Member", text: "Can create and change issues in every team they can see." },
  viewer: { label: "Viewer", text: "Can see everything members see. Can't change anything. Free." },
  guest: { label: "Guest", text: "Can work only in the teams they are added to." },
};

function RoleGuide() {
  return (
    <Card title="Roles">
      <dl className="role-guide">
        {ROLE_ORDER.map((r) => (
          <div key={r} className="role-guide-row">
            <dt className="role-guide-term">{ROLE_INFO[r].label}</dt>
            <dd className="role-guide-text">{ROLE_INFO[r].text}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">Private teams are only visible to the people added to them, and to admins.</p>
    </Card>
  );
}

function GuestTeamsDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const { slug } = useWs();
  const teams = useTeams(slug);
  const qc = useQueryClient();
  const results = useQueries({
    queries: (teams.data ?? []).map((t) => ({ queryKey: keys.teamMembers(slug, t.id), queryFn: () => api.ws(slug).teamMembers(t.id) })),
  });
  const toggle = async (t: Team, on: boolean) => {
    try {
      if (on) await api.ws(slug).addTeamMember(t.id, member.userId);
      else await api.ws(slug).removeTeamMember(t.id, member.userId);
      await qc.invalidateQueries({ queryKey: keys.teamMembers(slug, t.id) });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <Dialog title={`Teams ${member.name} can see`} onClose={onClose} size="sm">
      <p className="muted small">Guests only see issues of the teams checked here. Adding someone to a private team also lets them see it.</p>
      <ul className="check-list">
        {teams.data?.map((t, i) => (
          <li key={t.id}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={Boolean(results[i]?.data?.includes(member.userId))}
                disabled={results[i]?.isPending}
                onChange={(e) => toggle(t, e.target.checked)}
              />
              {t.name} <span className="muted">{t.key}</span>
              {t.private && <LockIcon label="Private team" />}
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function InviteForm() {
  const { slug } = useWs();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (withEmail: boolean) => {
    setBusy(true);
    try {
      const inv = await api.ws(slug).createInvite(withEmail ? email.trim() : undefined, role);
      await qc.invalidateQueries({ queryKey: keys.invites(slug) });
      if (withEmail) {
        toast(`Invite sent to ${inv.email}`, "success");
        setEmail("");
      } else {
        setLink(inv.url ?? null);
      }
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied", "success");
    } catch {
      toastError("Could not copy. Select the link and copy it by hand.");
    }
  };
  return (
    <Card title="Invite people">
      <form
        className="invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) void send(true);
        }}
      >
        <div className="field grow">
          <label className="field-label" htmlFor="inv-email">
            Email
          </label>
          <input
            id="inv-email"
            className="input"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="inv-role">
            Role
          </label>
          <select
            id="inv-role"
            className="select"
            value={role}
            aria-describedby="inv-role-hint"
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {ROLE_INFO[r].label}
              </option>
            ))}
          </select>
        </div>
        <div className="invite-buttons">
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
            Send invite
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => send(false)}>
            Create invite link
          </button>
        </div>
      </form>
      <p className="field-hint" id="inv-role-hint" aria-live="polite">
        {ROLE_INFO[role].label}: {ROLE_INFO[role].text}
      </p>
      {link && (
        <div className="invite-link">
          <label className="field-label" htmlFor="inv-link">
            Invite link (anyone with it can join as {ROLE_INFO[role].label.toLowerCase()} for 7 days)
          </label>
          <div className="row">
            <input id="inv-link" className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={copy}>
              <Copy size={14} aria-hidden="true" />
              Copy
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PendingInvites() {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const invites = useQuery({ queryKey: keys.invites(slug), queryFn: () => api.ws(slug).invites() });
  const revoke = async (id: string) => {
    try {
      await api.ws(slug).revokeInvite(id);
      await qc.invalidateQueries({ queryKey: keys.invites(slug) });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  if (!invites.data?.length) return null;
  return (
    <Card title="Pending invites">
      <ul className="member-list">
        {invites.data.map((i) => (
          <li key={i.id} className="member-row">
            <span className="member-info">
              <span className="member-name">{i.email ?? "Invite link"}</span>
              <span className="muted small">
                {ROLE_INFO[i.role].label} · expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
            </span>
            {canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => revoke(i.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Teams() {
  const { slug, isAdmin, canEdit } = useWs();
  const teams = useTeams(slug);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.ws(slug).createTeam(name.trim(), key.trim().toUpperCase(), isPrivate);
      await qc.invalidateQueries({ queryKey: keys.teams(slug) });
      await qc.invalidateQueries({ queryKey: keys.states(slug) });
      setName("");
      setKey("");
      setIsPrivate(false);
      toast("Team created", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {teams.isPending ? <Skeleton rows={3} /> : teams.data?.map((t) => <TeamCard key={t.id} team={t} />)}
      <WorkspaceLabels />
      {isAdmin && canEdit && (
        <Card title="New team">
          <form className="invite-form" id="new-team-form" onSubmit={create}>
            <div className="field grow">
              <label className="field-label" htmlFor="team-name">
                Team name
              </label>
              <input
                id="team-name"
                className="input"
                value={name}
                maxLength={60}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!key || key === deriveKey(name)) setKey(deriveKey(e.target.value));
                }}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="team-key">
                Key
              </label>
              <input
                id="team-key"
                className="input input-key"
                value={key}
                maxLength={5}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                aria-describedby="team-key-hint"
              />
            </div>
            <div className="field form-full">
              <label className="check-row">
                <input type="checkbox" checked={isPrivate} aria-describedby="team-private-hint" onChange={(e) => setIsPrivate(e.target.checked)} />
                Private team
              </label>
              <p className="field-hint" id="team-private-hint">
                Only people added to the team, and admins, can see it and its issues. You are added to it.
              </p>
            </div>
            <div className="invite-buttons">
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || key.length < 2}>
                Create team
              </button>
            </div>
          </form>
          <p className="muted small" id="team-key-hint">
            The key prefixes issue numbers, like {key || "ENG"}-12. 2 to 5 letters or digits.
          </p>
        </Card>
      )}
    </>
  );
}

function deriveKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 4);
}

function TeamCard({ team }: { team: Team }) {
  const { slug, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const [name, setName] = useState(team.name);
  const [key, setKey] = useState(team.key);
  const [archiving, setArchiving] = useState(false);
  useEffect(() => {
    setName(team.name);
    setKey(team.key);
  }, [team.name, team.key]);
  const editable = isAdmin && canEdit;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.ws(slug).updateTeam(team.id, { name: name.trim(), key: key.trim().toUpperCase() });
      await qc.invalidateQueries({ queryKey: keys.teams(slug) });
      qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
      toast("Team saved", "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const archive = async () => {
    try {
      await api.ws(slug).archiveTeam(team.id);
      await qc.invalidateQueries({ queryKey: keys.teams(slug) });
      toast(`${team.name} archived`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const [privacyTarget, setPrivacyTarget] = useState<boolean | null>(null);
  const setPrivate = async (value: boolean) => {
    try {
      await api.ws(slug).updateTeam(team.id, { private: value });
      await qc.invalidateQueries({ queryKey: keys.teams(slug) });
      qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
      toast(value ? `${team.name} is now private` : `${team.name} is now visible to everyone`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const dirty = name.trim() !== team.name || key.trim().toUpperCase() !== team.key;
  return (
    <Card
      title={
        <span className="team-title">
          {team.name}
          {team.private && <LockIcon size={13} label="Private team" />}
        </span>
      }
    >
      <form className="invite-form" onSubmit={save}>
        <div className="field grow">
          <label className="field-label" htmlFor={`tn-${team.id}`}>
            Name
          </label>
          <input
            id={`tn-${team.id}`}
            className="input"
            value={name}
            disabled={!editable}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`tk-${team.id}`}>
            Key
          </label>
          <input
            id={`tk-${team.id}`}
            className="input input-key"
            value={key}
            disabled={!editable}
            maxLength={5}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
          />
        </div>
        {editable && (
          <div className="invite-buttons">
            <button type="submit" className="btn btn-primary" disabled={!dirty || !name.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setArchiving(true)}>
              Archive
            </button>
          </div>
        )}
      </form>
      <div className="subsection">
        <h3 className="subsection-title">Who can see it</h3>
        {editable ? (
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={Boolean(team.private)}
              aria-describedby={`tp-${team.id}`}
              checked={Boolean(team.private)}
              onChange={(e) => setPrivacyTarget(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-text">Private team</span>
          </label>
        ) : null}
        <p className="muted small" id={`tp-${team.id}`}>
          {team.private
            ? "Private: only people in this team, and admins, can see it and its issues."
            : "Everyone in the workspace except guests can see this team and its issues."}
        </p>
      </div>
      <TeamPeople team={team} />
      <StatusEditor team={team} />
      <LabelEditor teamId={team.id} title="Team labels" />
      {privacyTarget !== null && (
        <ConfirmDialog
          title={privacyTarget ? `Make ${team.name} private?` : `Make ${team.name} visible to everyone?`}
          message={
            privacyTarget
              ? "Only people added to this team, and admins, will see it and its issues. Everyone else loses access right away, including links and notifications about its issues."
              : "All members and viewers will see this team and its issues. Guests still only see teams they are added to."
          }
          confirmLabel={privacyTarget ? "Make private" : "Make visible"}
          onConfirm={() => setPrivate(privacyTarget)}
          onClose={() => setPrivacyTarget(null)}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={`Archive ${team.name}?`}
          message="The team and its issues are hidden from lists. Issue links keep working."
          confirmLabel="Archive team"
          danger
          onConfirm={archive}
          onClose={() => setArchiving(false)}
        />
      )}
    </Card>
  );
}

/** The team's member list. It decides what guests see, and who sees a private team. */
function TeamPeople({ team }: { team: Team }) {
  const { slug, isAdmin, canEdit, me } = useWs();
  const qc = useQueryClient();
  const members = useMembers(slug);
  const list = useQuery({ queryKey: keys.teamMembers(slug, team.id), queryFn: () => api.ws(slug).teamMembers(team.id) });
  const [adding, setAdding] = useState("");
  const editable = isAdmin && canEdit;
  const ids = list.data ?? [];
  const inTeam = (members.data ?? []).filter((m) => ids.includes(m.userId));
  const others = (members.data ?? []).filter((m) => !ids.includes(m.userId));
  const refresh = () => qc.invalidateQueries({ queryKey: keys.teamMembers(slug, team.id) });
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    try {
      await api.ws(slug).addTeamMember(team.id, adding);
      setAdding("");
      await refresh();
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const remove = async (m: Member) => {
    try {
      await api.ws(slug).removeTeamMember(team.id, m.userId);
      await refresh();
      toast(`${m.name} removed from ${team.name}`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  return (
    <div className="subsection">
      <h3 className="subsection-title">People in this team</h3>
      <p className="muted small">
        Guests only see teams they are in.{" "}
        {team.private
          ? "This team is private, so only these people and admins can see it."
          : "If the team is made private, only these people and admins can see it."}
      </p>
      {list.isPending ? (
        <Skeleton rows={1} />
      ) : inTeam.length === 0 ? (
        <p className="muted small">No one is added yet.</p>
      ) : (
        <ul className="member-list compact">
          {inTeam.map((m) => (
            <li key={m.userId} className="member-row">
              <Avatar member={m} size={22} />
              <span className="member-info">
                <span className="member-name">
                  {m.name}
                  {m.userId === me.id && <span className="muted"> (you)</span>}
                </span>
              </span>
              <span className="badge">{ROLE_INFO[m.role].label}</span>
              {editable && (
                <button type="button" className="icon-btn small" aria-label={`Remove ${m.name} from ${team.name}`} onClick={() => remove(m)}>
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && others.length > 0 && (
        <form className="add-row" onSubmit={add}>
          <select
            className="select select-sm"
            aria-label={`Add someone to ${team.name}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">Pick a person</option>
            {others.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({ROLE_INFO[m.role].label})
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm" disabled={!adding}>
            Add to team
          </button>
        </form>
      )}
    </div>
  );
}

const CATEGORY_LABEL: Record<StateCategory, string> = {
  backlog: "Backlog",
  unstarted: "Not started",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

function StatusEditor({ team }: { team: Team }) {
  const { slug, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const states = useStates(slug);
  const list = (states.data ?? []).filter((s) => s.teamId === team.id).sort((a, b) => a.position - b.position);
  const [deleting, setDeleting] = useState<WorkflowState | null>(null);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState<StateCategory>("unstarted");
  const [newColor, setNewColor] = useState("#6b8f80");
  const editable = isAdmin && canEdit;
  const refresh = () => qc.invalidateQueries({ queryKey: keys.states(slug) });
  const patchState = async (s: WorkflowState, b: Partial<WorkflowState>) => {
    qc.setQueryData<WorkflowState[]>(keys.states(slug), (l) => l?.map((x) => (x.id === s.id ? { ...x, ...b } : x)));
    try {
      await api.ws(slug).updateState(s.id, b);
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  const moveBy = async (i: number, d: -1 | 1) => {
    const a = list[i];
    const b = list[i + d];
    if (!a || !b) return;
    qc.setQueryData<WorkflowState[]>(keys.states(slug), (l) =>
      l?.map((x) => (x.id === a.id ? { ...x, position: b.position } : x.id === b.id ? { ...x, position: a.position } : x)),
    );
    try {
      await api.ws(slug).updateState(a.id, { position: b.position });
      await api.ws(slug).updateState(b.id, { position: a.position });
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.ws(slug).createState(team.id, { name: newName.trim(), category: newCat, color: newColor });
      setNewName("");
      refresh();
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  return (
    <div className="subsection">
      <h3 className="subsection-title">Statuses</h3>
      <ul className="edit-list">
        {list.map((s, i) => (
          <li key={s.id} className="edit-row">
            <StatusIcon state={s} />
            <label className="color-swatch" style={{ background: s.color }}>
              <span className="sr-only">Color for {s.name}</span>
              <input type="color" value={s.color} disabled={!editable} onChange={(e) => patchState(s, { color: e.target.value })} />
            </label>
            <InlineText value={s.name} label={`Name of status ${s.name}`} disabled={!editable} onSave={(name) => patchState(s, { name })} />
            <label>
              <span className="sr-only">Category for {s.name}</span>
              <select
                className="select select-sm"
                value={s.category}
                disabled={!editable}
                onChange={(e) => patchState(s, { category: e.target.value as StateCategory })}
              >
                {STATE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
            {editable && (
              <span className="edit-actions">
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`Move ${s.name} up`}
                  disabled={i === 0}
                  onClick={() => moveBy(i, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`Move ${s.name} down`}
                  disabled={i === list.length - 1}
                  onClick={() => moveBy(i, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`Delete ${s.name}`}
                  disabled={list.length <= 1}
                  onClick={() => setDeleting(s)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="add-row" onSubmit={add}>
          <label className="color-swatch" style={{ background: newColor }}>
            <span className="sr-only">New status color</span>
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
          </label>
          <input
            className="input input-sm"
            placeholder="New status"
            aria-label="New status name"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            className="select select-sm"
            aria-label="New status category"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value as StateCategory)}
          >
            {STATE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm" disabled={!newName.trim()}>
            Add status
          </button>
        </form>
      )}
      {deleting && (
        <DeleteStatusDialog state={deleting} others={list.filter((s) => s.id !== deleting.id)} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function DeleteStatusDialog({ state, others, onClose }: { state: WorkflowState; others: WorkflowState[]; onClose: () => void }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const run = async () => {
    try {
      await api.ws(slug).deleteState(state.id, moveTo);
      await qc.invalidateQueries({ queryKey: keys.states(slug) });
      qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
      toast(`${state.name} deleted`, "success");
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <Dialog
      title={`Delete ${state.name}?`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={run} disabled={!moveTo}>
            Delete status
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label" htmlFor="move-to">
          Move its issues to
        </label>
        <select id="move-to" className="select" value={moveTo} data-autofocus onChange={(e) => setMoveTo(e.target.value)}>
          {others.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </Dialog>
  );
}

const LABEL_COLORS = ["#c0553f", "#d08a2e", "#b8a23a", "#5c9a5a", "#3f8f8a", "#4f74b5", "#7a5fb0", "#b05f8f", "#7d7a72"];

function LabelEditor({ teamId, title }: { teamId: string | null; title: string }) {
  const { slug, canEdit, workspace } = useWs();
  const qc = useQueryClient();
  const labels = useLabels(slug);
  const list = (labels.data ?? []).filter((l) => l.teamId === teamId);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[list.length % LABEL_COLORS.length]!);
  const [deleting, setDeleting] = useState<Label | null>(null);
  const editable = canEdit && workspace.role !== "guest";
  const refresh = () => qc.invalidateQueries({ queryKey: keys.labels(slug) });
  const patch = async (l: Label, b: { name?: string; color?: string }) => {
    qc.setQueryData<Label[]>(keys.labels(slug), (all) => all?.map((x) => (x.id === l.id ? { ...x, ...b } : x)));
    try {
      await api.ws(slug).updateLabel(l.id, b);
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.ws(slug).createLabel({ name: name.trim(), color, teamId });
      setName("");
      setColor(LABEL_COLORS[(list.length + 1) % LABEL_COLORS.length]!);
      refresh();
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const remove = async (l: Label) => {
    try {
      await api.ws(slug).deleteLabel(l.id);
      refresh();
      qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <div className="subsection">
      <h3 className="subsection-title">{title}</h3>
      {list.length === 0 && <p className="muted small">No labels yet.</p>}
      <ul className="edit-list">
        {list.map((l) => (
          <li key={l.id} className="edit-row">
            <LabelDot color={l.color} />
            <label className="color-swatch" style={{ background: l.color }}>
              <span className="sr-only">Color for {l.name}</span>
              <input type="color" value={l.color} disabled={!editable} onChange={(e) => patch(l, { color: e.target.value })} />
            </label>
            <InlineText value={l.name} label={`Name of label ${l.name}`} disabled={!editable} onSave={(n) => patch(l, { name: n })} />
            {editable && (
              <span className="edit-actions">
                <button type="button" className="icon-btn small" aria-label={`Delete label ${l.name}`} onClick={() => setDeleting(l)}>
                  <Trash2 size={13} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="add-row" onSubmit={add}>
          <label className="color-swatch" style={{ background: color }}>
            <span className="sr-only">New label color</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <input
            className="input input-sm"
            placeholder="New label"
            aria-label={`New label name (${title})`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
            Add label
          </button>
        </form>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete label ${deleting.name}?`}
          message="It is removed from every issue that has it."
          confirmLabel="Delete label"
          danger
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function WorkspaceLabels() {
  return (
    <Card title="Workspace labels">
      <p className="muted small">These labels can be used by every team.</p>
      <LabelEditor teamId={null} title="Labels" />
    </Card>
  );
}

const EVENT_LABEL: Record<(typeof NOTIFICATION_KINDS)[number], string> = {
  assigned: "Someone assigns an issue to me",
  mentioned: "Someone mentions me",
  commented: "Someone comments on an issue I follow",
  status_changed: "The status of an issue I follow changes",
};
const DIGEST_LABEL: Record<(typeof DIGEST_FREQUENCIES)[number], string> = {
  off: "Never",
  hourly: "Hourly",
  daily: "Daily",
};

function Notifications() {
  const { slug } = useWs();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.notifSettings(slug), queryFn: () => api.ws(slug).notificationSettings() });
  const save = useMutation({
    mutationFn: (s: NotificationSettings) => api.ws(slug).saveNotificationSettings(s),
    onMutate: (s) => {
      const prev = qc.getQueryData(keys.notifSettings(slug));
      qc.setQueryData(keys.notifSettings(slug), s);
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(keys.notifSettings(slug), ctx?.prev);
      toastError(errorMessage(e));
    },
    onSuccess: () => toast("Saved", "success"),
  });
  if (q.isPending) return <Skeleton rows={3} />;
  if (q.error) return <Empty title="Could not load settings">{errorMessage(q.error)}</Empty>;
  const s = q.data;
  return (
    <Card title="Notifications">
      <fieldset className="fieldset">
        <legend className="field-label">Email digest</legend>
        <div className="radio-row">
          {DIGEST_FREQUENCIES.map((d) => (
            <label key={d} className="check-row">
              <input type="radio" name="digest" value={d} checked={s.digest === d} onChange={() => save.mutate({ ...s, digest: d })} />
              {DIGEST_LABEL[d]}
            </label>
          ))}
        </div>
        <p className="muted small">A summary email of unread notifications in this workspace.</p>
      </fieldset>
      <fieldset className="fieldset">
        <legend className="field-label">Notify me when</legend>
        {NOTIFICATION_KINDS.map((k) => (
          <label key={k} className="check-row">
            <input
              type="checkbox"
              checked={s.events[k] !== false}
              onChange={(e) => save.mutate({ ...s, events: { ...s.events, [k]: e.target.checked } })}
            />
            {EVENT_LABEL[k]}
          </label>
        ))}
      </fieldset>
    </Card>
  );
}

function Profile() {
  const { me } = useWs();
  const qc = useQueryClient();
  const theme = useTheme();
  const [name, setName] = useState(me.name);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateMe(name.trim());
      await qc.invalidateQueries({ queryKey: keys.me });
      qc.invalidateQueries({ queryKey: ["members"] });
      toast("Profile saved", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Card title="Profile">
        <form className="stack" onSubmit={save}>
          <div className="field">
            <label className="field-label" htmlFor="me-name">
              Your name
            </label>
            <input id="me-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">Email</span>
            <span className="readonly-value">{me.email}</span>
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || name.trim() === me.name}>
              Save
            </button>
          </div>
        </form>
      </Card>
      <Card title="Theme">
        <fieldset className="fieldset">
          <legend className="sr-only">Theme</legend>
          <div className="theme-grid">
            {(["system", ...THEMES.map((t) => t.id)] as ThemeChoice[]).map((id) => {
              const t = THEMES.find((x) => x.id === id);
              const swatch = t ? t.swatch : ["#f5f2eb", "#2f5d50", "#1b1a18", "#7ab39f"];
              return (
                <label key={id} className={`theme-card${theme === id ? " is-selected" : ""}`}>
                  <input type="radio" name="theme" className="sr-only" checked={theme === id} onChange={() => setTheme(id)} />
                  <span className="theme-swatch" aria-hidden="true">
                    {(["bg", "surface", "accent", "text"] as const).map((slot, i) => (
                      <span key={slot} style={{ background: swatch[i] }} />
                    ))}
                  </span>
                  <span className="theme-name">{t ? t.label : "Match device"}</span>
                </label>
              );
            })}
          </div>
          <p className="muted small">Saved on this device. "Match device" switches between Light and Dark with your system setting.</p>
        </fieldset>
      </Card>
    </>
  );
}

function Data() {
  const { slug, isAdmin, workspace } = useWs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const exportsQ = useQuery({ queryKey: keys.exports(slug), queryFn: () => api.ws(slug).exports(), enabled: isAdmin });
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = exportsQ.data?.find((e) => e.status === "pending" || e.status === "running");
  const watchId = jobId ?? running?.id ?? null;
  const job = useQuery({
    queryKey: ["export", slug, watchId],
    queryFn: () => api.ws(slug).exportJob(watchId!),
    enabled: Boolean(watchId),
    refetchInterval: (q) => {
      const s = (q.state.data as ExportJob | undefined)?.status;
      return s === "done" || s === "failed" ? false : 1500;
    },
  });
  useEffect(() => {
    if (job.data?.status === "done" || job.data?.status === "failed") qc.invalidateQueries({ queryKey: keys.exports(slug) });
  }, [job.data?.status, qc, slug]);

  const start = async () => {
    setStarting(true);
    try {
      const j = await api.ws(slug).startExport();
      setJobId(j.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "export_running") {
        await qc.invalidateQueries({ queryKey: keys.exports(slug) });
      } else {
        toastError(errorMessage(e));
      }
    } finally {
      setStarting(false);
    }
  };

  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    setDeleting(true);
    try {
      await api.ws(slug).remove(confirmText);
      await qc.invalidateQueries({ queryKey: keys.me });
      toast("Workspace deleted", "success");
      navigate({ to: "/" });
    } catch (e) {
      toastError(errorMessage(e));
      setDeleting(false);
    }
  };

  if (!isAdmin) {
    return (
      <Card title="Data">
        <p className="muted">Only admins can export or delete this workspace.</p>
      </Card>
    );
  }
  const current = job.data;
  const busy = starting || current?.status === "pending" || current?.status === "running";
  const latestDone = exportsQ.data?.find((e) => e.status === "done" && e.downloadUrl);
  const downloadUrl = current?.status === "done" ? current.downloadUrl : latestDone?.downloadUrl;
  return (
    <>
      <Card title="Export">
        <p className="muted">
          Download every issue, comment and attachment as a JSON archive. Exports work even when the workspace is read-only.
        </p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
            {busy ? <Spinner label="Preparing export" /> : <Download size={14} aria-hidden="true" />}
            Export workspace
          </button>
          {busy && (
            <span className="muted small" role="status">
              Preparing your export...
            </span>
          )}
          {current?.status === "failed" && (
            <span className="form-error" role="alert">
              The export failed. Please try again.
            </span>
          )}
          {downloadUrl && !busy && (
            <a className="btn" href={downloadUrl} download>
              Download export
            </a>
          )}
        </div>
        {(exportsQ.data?.length ?? 0) > 0 && (
          <ul className="export-list">
            {exportsQ.data!.map((e) => (
              <li key={e.id} className="export-item">
                <span title={fullTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
                <span className="badge">{e.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Danger zone" danger>
        <p>
          Deleting <strong>{workspace.name}</strong> removes all teams, issues, comments and files for everyone. This cannot be undone.
        </p>
        <div className="field">
          <label className="field-label" htmlFor="del-confirm">
            Type <span className="mono">{slug}</span> to confirm
          </label>
          <input
            id="del-confirm"
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <button type="button" className="btn btn-danger" disabled={confirmText !== slug || deleting} onClick={del}>
            Delete workspace
          </button>
        </div>
      </Card>
    </>
  );
}
