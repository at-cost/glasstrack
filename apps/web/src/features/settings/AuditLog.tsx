import { useInfiniteQuery } from "@tanstack/react-query";
import type { AuditEntry, Member } from "@glasstrack/shared";
import { Download } from "lucide-react";
import { useId, useState } from "react";
import { Card } from "../../components/Card";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { api, errorMessage } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { keys, useFields, useMembers, useTeams } from "../../lib/queries";
import { useWs } from "../shell/context";

const GROUPS = [
  { id: "", label: "All activity" },
  { id: "member", label: "Members" },
  { id: "invite", label: "Invites" },
  { id: "team", label: "Teams" },
  { id: "token", label: "API tokens" },
  { id: "webhook", label: "Webhooks" },
  { id: "sso", label: "Single sign-on" },
  { id: "billing", label: "Billing" },
  { id: "export", label: "Exports" },
  { id: "field", label: "Custom fields" },
  { id: "github", label: "GitHub" },
  { id: "import", label: "Imports" },
  { id: "workspace", label: "Workspace" },
];

const SOURCE: Record<string, string> = { linear: "Linear", jira: "Jira", trello: "Trello" };
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function useDescribe() {
  const { slug } = useWs();
  const members = useMembers(slug);
  const teams = useTeams(slug);
  const fields = useFields(slug);
  const person = (id: string | null) => {
    const m: Member | undefined = members.data?.find((x) => x.userId === id);
    return m ? m.name : "a former member";
  };
  return (e: AuditEntry): string => {
    const d = e.data ?? {};
    const self = e.targetId && e.targetId === e.actorId;
    switch (e.action) {
      case "member.role_changed":
        return self
          ? `changed their own role from ${str(d.from)} to ${str(d.to)}`
          : `changed ${person(e.targetId)}'s role from ${str(d.from)} to ${str(d.to)}`;
      case "member.removed":
        return `removed ${person(e.targetId)} from the workspace`;
      case "member.left":
        return "left the workspace";
      case "member.joined_via_sso":
        return `joined through single sign-on as ${str(d.role) || "a member"}`;
      case "invite.created":
        return d.email ? `invited ${str(d.email)} as ${str(d.role)}` : `created an invite link for a ${str(d.role)}`;
      case "invite.revoked":
        return "revoked an invite";
      case "invite.accepted":
        return `accepted an invite as ${str(d.role)}`;
      case "team.created":
        return `created the team ${str(d.name)}${d.key ? ` (${str(d.key)})` : ""}`;
      case "team.archived": {
        const t = teams.data?.find((x) => x.id === e.targetId);
        return t ? `archived the team ${t.name}` : "archived a team";
      }
      case "token.created":
        return `created the API token "${str(d.name)}"`;
      case "token.revoked":
        return "revoked an API token";
      case "webhook.created":
        return `added a webhook to ${str(d.url)}`;
      case "webhook.updated":
        return d.active === false ? "turned off a webhook" : d.active === true ? "turned on a webhook" : "changed a webhook";
      case "webhook.deleted":
        return "deleted a webhook";
      case "sso.configured":
        return `set up single sign-on with ${str(d.issuer)}`;
      case "sso.updated": {
        const bits = [];
        if (d.enabled === false) bits.push("turned it off");
        if (d.enforce === true) bits.push("requires it for members");
        if (d.secretChanged) bits.push("changed the client secret");
        return `changed single sign-on settings${bits.length ? ` (${bits.join(", ")})` : ""}`;
      }
      case "sso.removed":
        return "removed single sign-on";
      case "sso.login":
        return "signed in with single sign-on";
      case "billing.topup_started":
        return `started a top-up of $${Number(d.amountUsd ?? 0).toLocaleString()}`;
      case "billing.auto_topup_changed":
        return d.enabled ? "turned on automatic top-ups" : "turned off automatic top-ups";
      case "export.requested":
        return "exported the workspace";
      case "field.created":
        return `created the field ${str(d.name)}`;
      case "field.updated": {
        const f = fields.data?.find((x) => x.id === e.targetId);
        return d.name ? `renamed a field to ${str(d.name)}` : `changed the field ${f?.name ?? ""}`.trim();
      }
      case "field.deleted":
        return `deleted the field ${str(d.name)}`;
      case "github.enabled":
        return "turned on the GitHub integration";
      case "github.updated":
        return d.rotatedSecret ? "changed GitHub settings and made a new secret" : "changed GitHub settings";
      case "github.disabled":
        return "turned off the GitHub integration";
      case "import.completed":
        return `imported ${plural(Number(d.issues ?? 0), "issue")} from ${SOURCE[str(d.source)] ?? "another tracker"}`;
      case "workspace.renamed":
        return `renamed the workspace from ${str(d.from)} to ${str(d.to)}`;
      case "workspace.deletion_requested":
        return "asked to delete the workspace";
      case "recurring.created":
        return "added a recurring issue schedule";
      case "recurring.deleted":
        return "deleted a recurring issue schedule";
      default:
        return e.action.replace(/[._]/g, " ");
    }
  };
}

export function AuditLog() {
  const { slug } = useWs();
  const id = useId();
  const [group, setGroup] = useState("");
  const describe = useDescribe();
  const q = useInfiniteQuery({
    queryKey: keys.audit(slug, group),
    queryFn: ({ pageParam }) => api.ws(slug).audit({ before: pageParam ?? undefined, action: group ? `${group}.` : undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <Card
      title="Audit log"
      actions={
        <a className="btn btn-sm" href={api.ws(slug).auditCsvUrl()} download>
          <Download size={14} aria-hidden="true" />
          Download CSV
        </a>
      }
    >
      <p className="muted small">Who changed members, access, integrations and billing, newest first.</p>
      <div className="field audit-filter">
        <label className="field-label" htmlFor={`${id}-group`}>
          Show
        </label>
        <select id={`${id}-group`} className="select select-sm" value={group} onChange={(e) => setGroup(e.target.value)}>
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {q.isPending ? (
        <Skeleton rows={5} />
      ) : q.error ? (
        <Empty title="Could not load the audit log">{errorMessage(q.error)}</Empty>
      ) : entries.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <>
          <ol className="audit-list" aria-label="Audit entries">
            {entries.map((e) => (
              <li key={e.id} className="audit-row">
                <span className="audit-text">
                  <strong className="audit-actor">{e.actorLabel}</strong> {describe(e)}
                </span>
                <span className="audit-meta muted small">
                  <time dateTime={e.createdAt} title={fullTime(e.createdAt)}>
                    {relativeTime(e.createdAt)}
                  </time>
                  {e.ip && <span className="mono"> · {e.ip}</span>}
                </span>
              </li>
            ))}
          </ol>
          {q.hasNextPage && (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage && <Spinner label="Loading" />}
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
