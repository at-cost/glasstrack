import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Activity, type Comment, type IssueDetail, type Member, PRIORITY_LABELS, type Priority } from "@glasstrack/shared";
import { Bot, Mail, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { Avatar } from "../../components/icons";
import { Markdown, MentionTextarea } from "../../components/MarkdownEditor";
import { api, errorMessage } from "../../lib/api";
import { formatDueDate, fullTime, relativeTime } from "../../lib/format";
import { keys, useActivity, useComments, useCycles, useFields, useLabels, useMembers, useStates } from "../../lib/queries";
import { formatMinutes } from "../../lib/time";
import { toastError } from "../../lib/toast";
import { useWs } from "../shell/context";
import { fieldValueText } from "./fields";
import { cycleLabel } from "./options";

const SOURCE_NAME: Record<string, string> = { linear: "Linear", jira: "Jira", trello: "Trello" };

type Provider = "github" | "gitlab" | "gitea";
const PROVIDER_NAME: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };

/** Which git host a pull/merge request URL belongs to: the issue's own links first, then the URL shape. */
function providerOf(d: Record<string, unknown>, links: IssueDetail["links"]): Provider {
  if (d.provider === "gitlab" || d.provider === "gitea" || d.provider === "github") return d.provider;
  if (d.via === "gitlab" || d.via === "gitea") return d.via;
  const url = typeof d.url === "string" ? d.url : "";
  const link = links?.find((l) => l.url === url);
  if (link) return link.provider;
  if (url.includes("/-/merge_requests/")) return "gitlab";
  if (/\/pulls\/\d+/.test(url)) return "gitea";
  return "github";
}

/** Activity written by a request form or email inbox rather than a person. */
const fromRequest = (a: Activity) => {
  const d = a.data as Record<string, unknown>;
  return a.actorId === null && ((a.kind === "created" && (d.via === "form" || d.via === "email")) || a.kind === "email_reply");
};

/** Who did it. Automated entries have no actor. */
function actorName(a: Activity, name: string | undefined, links: IssueDetail["links"]): string {
  if (a.actorId === null) {
    const d = a.data as Record<string, unknown>;
    if (d.via === "automation" || a.kind === "automation_comment") return d.rule ? `Automation "${String(d.rule)}"` : "Automation";
    if (a.kind === "pr_linked" || a.kind === "pr_merged" || d.via === "github" || d.via === "gitlab" || d.via === "gitea") {
      return PROVIDER_NAME[providerOf(d, links)];
    }
    return "Glasstrack";
  }
  return name ?? "A former member";
}

/** Replies by email are stored as comments without an author, ending with "_Email from x_". */
const EMAIL_TRAILER = /\s*_Email from (\S+?)_\s*$/;
export function emailAuthor(c: Pick<Comment, "authorId" | "body">): { from: string; body: string } | null {
  if (c.authorId) return null;
  const m = EMAIL_TRAILER.exec(c.body);
  return m ? { from: m[1]!, body: c.body.slice(0, m.index) } : null;
}

type Item = { kind: "comment"; at: string; c: Comment } | { kind: "activity"; at: string; a: Activity };

function useDescribe(links: IssueDetail["links"]) {
  const { slug } = useWs();
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const cycles = useCycles(slug);
  const fields = useFields(slug);
  const stateName = (id: unknown) => states.data?.find((s) => s.id === id)?.name ?? "a removed status";
  const memberName = (id: unknown) => members.data?.find((m) => m.userId === id)?.name ?? "a former member";
  const memberNames = (ids: unknown) => (Array.isArray(ids) ? ids : []).map(memberName).join(", ");
  const labelNames = (ids: unknown) =>
    (Array.isArray(ids) ? ids : []).map((id) => labels.data?.find((l) => l.id === id)?.name ?? "a removed label").join(", ");
  const cycleName = (id: unknown) => {
    const c = cycles.data?.find((x) => x.id === id);
    return c ? cycleLabel(c) : "a removed cycle";
  };
  const changeName = (d: Record<string, unknown>) => (providerOf(d, links) === "gitlab" ? "merge request" : "pull request");
  const prLink = (d: Record<string, unknown>) => {
    const url = typeof d.url === "string" && /^https?:\/\//.test(d.url) ? d.url : null;
    const title = String(d.title ?? `a ${changeName(d)}`);
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        {title}
      </a>
    ) : (
      title
    );
  };
  return (a: Activity): ReactNode => {
    const d = a.data as Record<string, unknown>;
    switch (a.kind) {
      case "imported":
        return `imported this from ${SOURCE_NAME[String(d.source)] ?? "another tracker"}${d.externalId ? ` (${String(d.externalId)})` : ""}`;
      case "pr_linked":
        return (
          <>
            linked {changeName(d)} {prLink(d)}
          </>
        );
      case "pr_merged":
        return (
          <>
            merged {changeName(d)} {prLink(d)}
          </>
        );
      case "email_reply":
        return `Email reply from ${String(d.from ?? "the requester")}`;
      case "created":
        if (d.via === "form") return `Created from ${d.channel ? `the ${String(d.channel)} form` : "a request form"}`;
        if (d.via === "email") return `Created from an email${d.from ? ` from ${String(d.from)}` : ""}`;
        return d.recurringId ? "created this from a recurring template" : d.templateId ? "created the issue from a template" : "created the issue";
      case "title":
        return `renamed it to "${String(d.to ?? "")}"`;
      case "description":
        return "updated the description";
      case "status":
        if (d.via === "github" || d.via === "gitea") return `moved this to ${stateName(d.to)} after a pull request was merged`;
        if (d.via === "gitlab") return `moved this to ${stateName(d.to)} after a merge request was merged`;
        return `changed status from ${stateName(d.from)} to ${stateName(d.to)}`;
      case "priority":
        return `set priority to ${PRIORITY_LABELS[(Number(d.to) || 0) as Priority]}`;
      case "assignee":
        return d.to ? `assigned it to ${memberName(d.to)}` : "removed the assignee";
      case "assignees": {
        const parts = [];
        if (Array.isArray(d.added) && d.added.length) parts.push(`assigned ${memberNames(d.added)}`);
        if (Array.isArray(d.removed) && d.removed.length) parts.push(`removed ${memberNames(d.removed)}`);
        return parts.join(" and ") || "changed assignees";
      }
      case "field": {
        const f = fields.data?.find((x) => x.id === d.fieldId);
        const name = f?.name ?? "a removed field";
        const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);
        if (empty(d.to)) return `cleared ${name}`;
        if (empty(d.from)) return `set ${name} to ${fieldValueText(f, d.to, members.data)}`;
        return `changed ${name} from ${fieldValueText(f, d.from, members.data)} to ${fieldValueText(f, d.to, members.data)}`;
      }
      case "time_logged":
        return `logged ${formatMinutes(Number(d.minutes) || 0)}`;
      case "labels": {
        const parts = [];
        if (Array.isArray(d.added) && d.added.length) parts.push(`added ${labelNames(d.added)}`);
        if (Array.isArray(d.removed) && d.removed.length) parts.push(`removed ${labelNames(d.removed)}`);
        return parts.join(" and ") || "changed labels";
      }
      case "start_date":
        return d.to ? `set the start date to ${formatDueDate(String(d.to))}` : "removed the start date";
      case "automation_comment":
        return "added a comment";
      case "due_date":
        return d.to ? `set the due date to ${formatDueDate(String(d.to))}` : "removed the due date";
      case "estimate":
        return d.to === null || d.to === undefined ? "removed the estimate" : `set the estimate to ${d.to}`;
      case "cycle":
        return d.to ? `moved it to ${cycleName(d.to)}` : "removed it from the cycle";
      case "parent":
        return d.to ? "changed the parent issue" : "removed the parent issue";
      case "relation_added": {
        const other = String(d.issue ?? "another issue");
        const t = d.type;
        if (t === "blocks") return d.incoming ? `marked this as blocked by ${other}` : `marked this as blocking ${other}`;
        if (t === "duplicate") return d.incoming ? `marked ${other} as a duplicate of this` : `marked this as a duplicate of ${other}`;
        return `linked this to ${other}`;
      }
      case "relation_removed":
        return d.issue ? `removed the link to ${String(d.issue)}` : "removed a link";
      case "archived":
        return "archived the issue";
      case "unarchived":
        return "restored the issue";
      case "attachment_added":
        return `attached ${String(d.filename ?? "a file")}`;
      default:
        return `made a change (${a.kind})`;
    }
  };
}

export function Timeline({ issue }: { issue: IssueDetail }) {
  const { slug, isViewer } = useWs();
  const comments = useComments(slug, issue.id);
  const activity = useActivity(slug, issue.id);
  const members = useMembers(slug);
  const describe = useDescribe(issue.links);
  const items: Item[] = [
    ...(comments.data ?? []).map((c): Item => ({ kind: "comment", at: c.createdAt, c })),
    ...(activity.data ?? []).map((a): Item => ({ kind: "activity", at: a.createdAt, a })),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const member = (id: string | null) => members.data?.find((m) => m.userId === id);

  return (
    <section className="timeline" aria-label="Activity">
      <h2 className="section-title">Activity</h2>
      {(comments.isPending || activity.isPending) && <p className="muted small">Loading activity...</p>}
      <ol className="timeline-list">
        {items.map((it) =>
          it.kind === "activity" ? (
            <li key={`a${it.a.id}`} className="tl-activity">
              <span className="tl-dot" aria-hidden="true" />
              {fromRequest(it.a) ? (
                <span>{describe(it.a)}</span>
              ) : (
                <span>
                  <strong>{actorName(it.a, member(it.a.actorId)?.name, issue.links)}</strong> {describe(it.a)}
                </span>
              )}
              <time dateTime={it.a.createdAt} title={fullTime(it.a.createdAt)} className="tl-time">
                {relativeTime(it.a.createdAt)}
              </time>
            </li>
          ) : (
            <li key={`c${it.c.id}`}>
              <CommentItem comment={it.c} issueId={issue.id} author={member(it.c.authorId)} members={members.data} />
            </li>
          ),
        )}
      </ol>
      {isViewer ? (
        <p className="muted small">Viewers can read comments but not write them.</p>
      ) : (
        <CommentBox issueId={issue.id} members={members.data} />
      )}
    </section>
  );
}

function CommentItem({ comment, issueId, author, members }: { comment: Comment; issueId: string; author?: Member; members?: Member[] }) {
  const { slug, me, isAdmin, canEdit } = useWs();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirm, setConfirm] = useState(false);
  const key = keys.comments(slug, issueId);
  const edit = useMutation({
    mutationFn: (body: string) => api.ws(slug).editComment(comment.id, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Comment[]>(key);
      qc.setQueryData<Comment[]>(key, (list) =>
        list?.map((c) => (c.id === comment.id ? { ...c, body, editedAt: new Date().toISOString() } : c)),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      toastError(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: () => api.ws(slug).deleteComment(comment.id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Comment[]>(key);
      qc.setQueryData<Comment[]>(key, (list) => list?.filter((c) => c.id !== comment.id));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      toastError(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  const automated = !comment.authorId;
  const email = emailAuthor(comment);
  const authorName = email ? email.from : automated ? "Automation" : (author?.name ?? "Former member");
  const mine = !automated && comment.authorId === me.id;
  const pending = comment.id.startsWith("temp-");
  const save = () => {
    const b = draft.trim();
    if (!b) return;
    setEditing(false);
    if (b !== comment.body) edit.mutate(b);
  };
  return (
    <article
      className={`comment${pending ? " pending" : ""}`}
      data-testid="comment"
      aria-label={`Comment by ${email ? email.from : automated ? "Automation" : (author?.name ?? "a former member")}`}
    >
      <header className="comment-head">
        {email ? (
          <span className="avatar automation-avatar" style={{ width: 22, height: 22 }} aria-hidden="true">
            <Mail size={13} />
          </span>
        ) : automated ? (
          <span className="avatar automation-avatar" style={{ width: 22, height: 22 }} aria-hidden="true">
            <Bot size={14} />
          </span>
        ) : (
          <Avatar member={author ?? { name: "?", avatarUrl: null }} size={22} />
        )}
        <strong>{authorName}</strong>
        <time dateTime={comment.createdAt} title={fullTime(comment.createdAt)} className="tl-time">
          {relativeTime(comment.createdAt)}
        </time>
        {comment.editedAt && <span className="muted small">(edited)</span>}
        <span className="comment-actions">
          {mine && canEdit && !pending && !editing && (
            <button type="button" className="icon-btn small" aria-label="Edit" title="Edit" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </button>
          )}
          {(mine || isAdmin) && canEdit && !pending && (
            <button type="button" className="icon-btn small" aria-label="Delete" title="Delete" onClick={() => setConfirm(true)}>
              <Trash2 size={13} />
            </button>
          )}
        </span>
      </header>
      {editing ? (
        <div className="comment-edit">
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            members={members}
            label="Edit text"
            autoFocus
            onSubmit={save}
            onCancel={() => {
              setDraft(comment.body);
              setEditing(false);
            }}
          />
          <div className="row-end">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!draft.trim()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <Markdown source={email ? email.body : comment.body} className="comment-body" />
      )}
      {confirm && (
        <ConfirmDialog
          title="Delete comment?"
          message="This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirm(false)}
        />
      )}
    </article>
  );
}

function CommentBox({ issueId, members }: { issueId: string; members?: Member[] }) {
  const { slug, me, canEdit } = useWs();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const key = keys.comments(slug, issueId);
  const add = useMutation({
    mutationFn: (text: string) => api.ws(slug).addComment(issueId, text),
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Comment[]>(key);
      const temp: Comment = {
        id: `temp-${Date.now()}`,
        issueId,
        authorId: me.id,
        body: text,
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      qc.setQueryData<Comment[]>(key, (list) => [...(list ?? []), temp]);
      return { prev, text };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(key, ctx?.prev);
      if (ctx?.text) setBody((b) => b || ctx.text);
      toastError(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  const send = () => {
    const text = body.trim();
    if (!text || !canEdit) return;
    setBody("");
    add.mutate(text);
  };
  return (
    <div className="comment-box">
      <MentionTextarea
        value={body}
        onChange={setBody}
        members={members}
        onSubmit={send}
        label="Write a comment"
        placeholder="Leave a comment. Type @ to mention someone."
        rows={3}
        disabled={!canEdit}
      />
      <div className="row-end">
        <span className="muted small hide-mobile">Ctrl Enter to send</span>
        <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={!body.trim() || !canEdit}>
          Comment
        </button>
      </div>
    </div>
  );
}
