import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Notification } from "@glasstrack/shared";
import { CheckCheck, Settings } from "lucide-react";
import { Empty, Skeleton } from "../../components/Feedback";
import { Avatar } from "../../components/icons";
import { api, errorMessage } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useMembers, useNotifications } from "../../lib/queries";
import { toastError } from "../../lib/toast";
import { PageHeader } from "../issues/pages";
import { useWs } from "../shell/context";

const VERB: Record<Notification["kind"], string> = {
  assigned: "assigned you to",
  mentioned: "mentioned you in",
  commented: "commented on",
  status_changed: "changed the status of",
};

export function InboxPage() {
  const { slug } = useWs();
  const list = useNotifications(slug);
  const members = useMembers(slug);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const markRead = useMutation({
    mutationFn: (b: { ids?: string[]; all?: boolean; unread?: boolean }) => api.ws(slug).markRead(b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: keys.notifications(slug) });
      const prev = qc.getQueryData<Notification[]>(keys.notifications(slug));
      const prevCount = qc.getQueryData<{ count: number }>(keys.unread(slug));
      const at = b.unread ? null : new Date().toISOString();
      qc.setQueryData<Notification[]>(keys.notifications(slug), (l) =>
        l?.map((n) => (b.all || b.ids?.includes(n.id) ? { ...n, readAt: at } : n)),
      );
      const unread = qc.getQueryData<Notification[]>(keys.notifications(slug))?.filter((n) => !n.readAt).length;
      if (unread !== undefined) qc.setQueryData(keys.unread(slug), { count: unread });
      return { prev, prevCount };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(keys.notifications(slug), ctx?.prev);
      qc.setQueryData(keys.unread(slug), ctx?.prevCount);
      toastError(errorMessage(e));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.notifications(slug) });
      qc.invalidateQueries({ queryKey: keys.unread(slug) });
    },
  });

  const unreadCount = list.data?.filter((n) => !n.readAt).length ?? 0;
  const open = (n: Notification) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    navigate({ to: paths.issue(slug, n.issueIdentifier) });
  };

  return (
    <div className="page">
      <PageHeader title="Inbox" sub={unreadCount ? `${unreadCount} unread` : undefined}>
        <Link to={paths.settings(slug)} search={{ tab: "notifications" }} className="btn btn-sm btn-ghost">
          <Settings size={14} aria-hidden="true" />
          <span className="hide-mobile">Settings</span>
        </Link>
        <button type="button" className="btn btn-sm" disabled={unreadCount === 0} onClick={() => markRead.mutate({ all: true })}>
          <CheckCheck size={14} aria-hidden="true" />
          Mark all read
        </button>
      </PageHeader>
      <div className="page-body">
        {list.isPending ? (
          <Skeleton />
        ) : list.error ? (
          <Empty title="Could not load your inbox">{errorMessage(list.error)}</Empty>
        ) : list.data.length === 0 ? (
          <Empty title="You're all caught up">Updates on issues you follow will show up here.</Empty>
        ) : (
          <ul className="inbox-list">
            {list.data.map((n) => {
              const actor = members.data?.find((m) => m.userId === n.actorId);
              const excerpt = typeof n.data.excerpt === "string" ? n.data.excerpt : null;
              return (
                <li key={n.id}>
                  <button type="button" className={`inbox-row${n.readAt ? "" : " unread"}`} onClick={() => open(n)} data-issue-row>
                    <span className="unread-dot" aria-hidden="true" />
                    <Avatar member={actor ?? { name: "?", avatarUrl: null }} size={24} />
                    <span className="inbox-text">
                      <span className="inbox-line">
                        <strong>{actor?.name ?? "Someone"}</strong> {VERB[n.kind]} <span className="issue-id">{n.issueIdentifier}</span>{" "}
                        <span className="inbox-title">{n.issueTitle}</span>
                      </span>
                      {excerpt && <span className="inbox-excerpt">{excerpt}</span>}
                    </span>
                    <time dateTime={n.createdAt} title={fullTime(n.createdAt)} className="tl-time">
                      {relativeTime(n.createdAt)}
                    </time>
                    {!n.readAt && <span className="sr-only">Unread</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
