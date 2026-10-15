import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { IssueDetail, IssueLink, IssueRelation } from "@glasstrack/shared";
import { Archive, Bell, BellOff, ChevronRight, Copy, Ellipsis, ExternalLink, FileText, GitPullRequest, Link2, Paperclip, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { AvatarStack, StatusIcon } from "../../components/icons";
import { Markdown, MarkdownEditor } from "../../components/MarkdownEditor";
import { Popover } from "../../components/Picker";
import { ApiError, api, errorMessage, uploadAttachment } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { useArchiveIssue, useDeleteIssue, useUpdateIssue } from "../../lib/mutations";
import { paths } from "../../lib/paths";
import { keys, useIssue, useMembers, useStates, useTeams } from "../../lib/queries";
import { currentIssueStore, ui } from "../../lib/store";
import { toast, toastError } from "../../lib/toast";
import { MenuList } from "../shell/AppShell";
import { useWs } from "../shell/context";
import { IssueSearchPopover, Properties } from "./Properties";
import { TimeSection } from "./TimeSection";
import { Timeline } from "./Timeline";

export function IssueDetailPage() {
  const { slug } = useWs();
  const { identifier } = useParams({ strict: false }) as { identifier: string };
  const q = useIssue(slug, identifier);
  const issue = q.data;

  const issueId = issue?.id;
  useEffect(() => {
    if (!issueId) return;
    currentIssueStore.set(issueId);
    return () => {
      if (currentIssueStore.get() === issueId) currentIssueStore.set(null);
    };
  }, [issueId]);

  if (q.isPending) return <Skeleton rows={4} />;
  if (q.error || !issue) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Empty title={notFound ? "Issue not found" : "Could not load the issue"}>
        {notFound ? "It may have been deleted, or you no longer have access." : errorMessage(q.error)}
      </Empty>
    );
  }
  return <IssueView issue={issue} />;
}

function IssueView({ issue }: { issue: IssueDetail }) {
  const { slug, canEdit } = useWs();
  const teams = useTeams(slug);
  const team = teams.data?.find((t) => t.id === issue.teamId);
  return (
    <div className="page issue-page">
      <IssueHeader issue={issue} teamName={team?.name} teamKey={team?.key} />
      {issue.archivedAt && <div className="banner subtle">This issue is archived.</div>}
      <div className="issue-layout">
        <div className="issue-main">
          <TitleEditor issue={issue} disabled={!canEdit} />
          <Description issue={issue} disabled={!canEdit} />
          <SubIssues issue={issue} />
          <Relations issue={issue} />
          <PullRequests issue={issue} />
          <Attachments issue={issue} />
          <TimeSection issue={issue} />
          <Timeline issue={issue} />
        </div>
        <Properties issue={issue} />
      </div>
    </div>
  );
}

function IssueHeader({ issue, teamName, teamKey }: { issue: IssueDetail; teamName?: string; teamKey?: string }) {
  const { slug, canEdit, me, isAdmin } = useWs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const archive = useArchiveIssue(slug);
  const del = useDeleteIssue(slug);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const subscribe = useMutation({
    mutationFn: (subscribed: boolean) => api.ws(slug).subscribe(issue.id, subscribed),
    onMutate: (subscribed) => {
      qc.setQueryData<IssueDetail>(keys.issue(slug, issue.identifier), (d) => (d ? { ...d, subscribed } : d));
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: keys.issue(slug, issue.identifier) });
      toastError(errorMessage(e));
    },
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${paths.issue(slug, issue.identifier)}`);
      toast("Link copied", "success");
    } catch {
      toastError("Could not copy the link");
    }
  };
  const canDelete = issue.creatorId === me.id || isAdmin;
  return (
    <header className="page-header issue-header">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        {teamKey ? <Link to={paths.teamIssues(slug, teamKey)}>{teamName}</Link> : <span>{teamName}</span>}
        <ChevronRight size={13} aria-hidden="true" />
        <span aria-current="page">{issue.identifier}</span>
      </nav>
      <div className="page-actions">
        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={issue.subscribed}
          onClick={() => subscribe.mutate(!issue.subscribed)}
          title={issue.subscribed ? "You get notified about changes" : "Get notified about changes"}
        >
          {issue.subscribed ? <BellOff size={14} aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
          {issue.subscribed ? "Unsubscribe" : "Subscribe"}
        </button>
        <button type="button" className="icon-btn" aria-label="Copy link" onClick={copy}>
          <Copy size={15} />
        </button>
        {canEdit && (
          <button
            ref={moreBtn}
            type="button"
            className="icon-btn"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <Ellipsis size={16} />
          </button>
        )}
        {menu && (
          <Popover
            anchor={moreBtn.current}
            onClose={() => {
              setMenu(false);
              moreBtn.current?.focus();
            }}
            width={200}
            label="Issue actions"
          >
            <MenuList
              onClose={() => setMenu(false)}
              items={[
                {
                  id: "archive",
                  label: issue.archivedAt ? "Restore issue" : "Archive issue",
                  icon: issue.archivedAt ? <RotateCcw size={14} /> : <Archive size={14} />,
                  onSelect: () => archive.mutate({ issue, archived: !issue.archivedAt }),
                },
                ...(canDelete
                  ? [{ id: "delete", label: "Delete issue", icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirm(true) }]
                  : []),
              ]}
            />
          </Popover>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete ${issue.identifier}?`}
          message="The issue, its comments and attachments are removed for good. Archiving keeps them."
          confirmLabel="Delete issue"
          danger
          onConfirm={() => {
            del.mutate(issue, {
              onSuccess: () => {
                toast(`Deleted ${issue.identifier}`, "success");
                navigate({ to: teamKey ? paths.teamIssues(slug, teamKey) : paths.myIssues(slug) });
              },
            });
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </header>
  );
}

function TitleEditor({ issue, disabled }: { issue: IssueDetail; disabled: boolean }) {
  const { slug } = useWs();
  const update = useUpdateIssue(slug);
  const [title, setTitle] = useState(issue.title);
  useEffect(() => setTitle(issue.title), [issue.title]);
  const save = () => {
    const t = title.trim();
    if (!t) return setTitle(issue.title);
    if (t !== issue.title) update.mutate({ issue, patch: { title: t } });
  };
  return (
    <textarea
      className="title-edit"
      aria-label="Title"
      value={title}
      rows={1}
      maxLength={300}
      disabled={disabled}
      onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setTitle(issue.title);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

function Description({ issue, disabled }: { issue: IssueDetail; disabled: boolean }) {
  const { slug } = useWs();
  const members = useMembers(slug);
  const update = useUpdateIssue(slug);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.description);
  const start = () => {
    setDraft(issue.description);
    setEditing(true);
  };
  const save = () => {
    setEditing(false);
    if (draft !== issue.description) update.mutate({ issue, patch: { description: draft } });
  };
  if (editing) {
    return (
      <div className="description editing">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          members={members.data}
          onSubmit={save}
          onCancel={() => setEditing(false)}
          label="Description"
          rows={10}
          autoFocus
          placeholder="Add a description"
        />
        <div className="row-end">
          <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="description">
      {issue.description.trim() ? <Markdown source={issue.description} /> : <p className="muted">No description yet.</p>}
      {!disabled && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={start}>
          {issue.description.trim() ? "Edit description" : "Add description"}
        </button>
      )}
    </div>
  );
}

function SubIssues({ issue }: { issue: IssueDetail }) {
  const { slug, canEdit } = useWs();
  const states = useStates(slug);
  const members = useMembers(slug);
  return (
    <section className="detail-section" aria-labelledby="subissues-title">
      <div className="section-head">
        <h2 className="section-title" id="subissues-title">
          Sub-issues {issue.children.length > 0 && <span className="group-count">{issue.children.length}</span>}
        </h2>
        {canEdit && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => ui.openCreate({ teamId: issue.teamId, parentId: issue.id })}
          >
            <Plus size={13} aria-hidden="true" />
            Add sub-issue
          </button>
        )}
      </div>
      {issue.children.length > 0 && (
        <ul className="mini-list">
          {issue.children.map((c) => (
            <li key={c.id}>
              <Link to={paths.issue(slug, c.identifier)} className="mini-row" data-issue-row>
                <StatusIcon state={states.data?.find((s) => s.id === c.statusId)} />
                <span className="issue-id">{c.identifier}</span>
                <span className="issue-title">{c.title}</span>
                <AvatarStack ids={c.assigneeIds ?? []} members={members.data} size={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const RELATION_KINDS = [
  { id: "blocks", label: "Blocks" },
  { id: "blocked_by", label: "Blocked by" },
  { id: "related", label: "Related to" },
  { id: "duplicate", label: "Duplicate of" },
] as const;

function relationLabel(r: IssueRelation): string {
  if (r.type === "blocks") return r.direction === "outgoing" ? "Blocks" : "Blocked by";
  if (r.type === "duplicate") return r.direction === "outgoing" ? "Duplicate of" : "Duplicated by";
  return "Related to";
}

function Relations({ issue }: { issue: IssueDetail }) {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const states = useStates(slug);
  const [kind, setKind] = useState<(typeof RELATION_KINDS)[number]["id"]>("related");
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.issueAll(slug) });
    qc.invalidateQueries({ queryKey: keys.activity(slug, issue.id) });
  };
  const add = async (otherId: string) => {
    try {
      if (kind === "blocked_by") await api.ws(slug).addRelation(otherId, issue.id, "blocks");
      else await api.ws(slug).addRelation(issue.id, otherId, kind);
      refresh();
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const remove = async (r: IssueRelation) => {
    qc.setQueryData<IssueDetail>(keys.issue(slug, issue.identifier), (d) =>
      d ? { ...d, relations: d.relations.filter((x) => x.id !== r.id) } : d,
    );
    try {
      await api.ws(slug).removeRelation(issue.id, r.id);
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  return (
    <section className="detail-section" aria-labelledby="links-title">
      <div className="section-head">
        <h2 className="section-title" id="links-title">
          Links
        </h2>
        {canEdit && (
          <div className="inline-form">
            <label className="sr-only" htmlFor="rel-kind">
              Link type
            </label>
            <select id="rel-kind" className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {RELATION_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <button
              ref={btn}
              type="button"
              className="btn btn-ghost btn-sm"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <Link2 size={13} aria-hidden="true" />
              Add link
            </button>
          </div>
        )}
      </div>
      {open && (
        <IssueSearchPopover
          anchor={btn.current}
          label="Link an issue"
          exclude={[issue.id]}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
          onPick={(r) => {
            setOpen(false);
            void add(r.id);
          }}
        />
      )}
      {issue.relations.length > 0 && (
        <ul className="mini-list">
          {issue.relations.map((r) => (
            <li key={r.id} className="mini-row-wrap">
              <span className="rel-kind">{relationLabel(r)}</span>
              <Link to={paths.issue(slug, r.issue.identifier)} className="mini-row">
                <StatusIcon state={states.data?.find((s) => s.id === r.issue.statusId)} />
                <span className="issue-id">{r.issue.identifier}</span>
                <span className="issue-title">{r.issue.title}</span>
              </Link>
              {canEdit && (
                <button
                  type="button"
                  className="icon-btn small"
                  aria-label={`Remove link to ${r.issue.identifier}`}
                  onClick={() => remove(r)}
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PR_STATE: Record<IssueLink["state"], string> = { open: "Open", merged: "Merged", closed: "Closed" };

function PullRequests({ issue }: { issue: IssueDetail }) {
  const links = (issue.links ?? []).filter((l) => l.provider === "github");
  if (links.length === 0) return null;
  return (
    <section className="detail-section" aria-labelledby="prs-title">
      <div className="section-head">
        <h2 className="section-title" id="prs-title">
          Pull requests <span className="group-count">{links.length}</span>
        </h2>
      </div>
      <ul className="mini-list">
        {links.map((l) => (
          <li key={l.id} className="mini-row-wrap">
            <span className={`pr-state pr-${l.state}`}>
              <GitPullRequest size={12} aria-hidden="true" />
              {PR_STATE[l.state] ?? l.state}
            </span>
            <a href={l.url} target="_blank" rel="noreferrer" className="mini-row">
              <span className="issue-title">{l.title}</span>
              <ExternalLink size={12} aria-hidden="true" />
              <span className="sr-only">(opens GitHub)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Attachments({ issue }: { issue: IssueDetail }) {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.issueAll(slug) });
    qc.invalidateQueries({ queryKey: keys.activity(slug, issue.id) });
  };
  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        await uploadAttachment(slug, issue.id, f);
      } catch (e) {
        toastError(`${f.name}: ${errorMessage(e)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    refresh();
  };
  const remove = async (id: string) => {
    qc.setQueryData<IssueDetail>(keys.issue(slug, issue.identifier), (d) =>
      d ? { ...d, attachments: d.attachments.filter((a) => a.id !== id) } : d,
    );
    try {
      await api.ws(slug).deleteAttachment(id);
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  return (
    <section
      className={`detail-section attachments${dragOver ? " drag-over" : ""}`}
      aria-labelledby="files-title"
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragOver(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="section-head">
        <h2 className="section-title" id="files-title">
          Attachments
        </h2>
        {canEdit && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label="Upload files"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => input.current?.click()}>
              {uploading > 0 ? <Spinner label="Uploading" /> : <Paperclip size={13} aria-hidden="true" />}
              {uploading > 0 ? "Uploading..." : "Upload"}
            </button>
          </>
        )}
      </div>
      {issue.attachments.length > 0 && (
        <ul className="attachment-grid">
          {issue.attachments.map((a) => (
            <li key={a.id} className="attachment">
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="attachment-link">
                {a.contentType.startsWith("image/") ? (
                  <img src={a.url} alt={a.filename} loading="lazy" className="attachment-thumb" />
                ) : (
                  <span className="attachment-icon" aria-hidden="true">
                    <FileText size={22} />
                  </span>
                )}
                <span className="attachment-name">{a.filename}</span>
                <span className="muted small">{formatBytes(a.size)}</span>
              </a>
              {canEdit && (
                <button
                  type="button"
                  className="icon-btn small attachment-del"
                  aria-label={`Delete ${a.filename}`}
                  onClick={() => remove(a.id)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && issue.attachments.length === 0 && <p className="muted small">Drop files here or use Upload.</p>}
    </section>
  );
}
