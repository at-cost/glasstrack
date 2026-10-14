import { sql } from "kysely";
import { extractMentions, type NotificationKind } from "@tracker/shared";
import { notify, type Tx } from "../db/tenant";
import { uuid7 } from "../lib/ids";

/** Maps @handles (email local parts) to member user ids in the current workspace. */
export async function resolveMentions(trx: Tx, markdown: string): Promise<string[]> {
  const handles = extractMentions(markdown);
  if (handles.length === 0) return [];
  const rows = await trx
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select("u.id")
    .where("m.workspaceId", "=", sql<string>`app.ws()`)
    .where(sql<string>`lower(split_part(u.email, '@', 1))`, "in", handles)
    .execute();
  return rows.map((r) => r.id);
}

export async function subscribe(trx: Tx, workspaceId: string, issueId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
  if (ids.length === 0) return;
  await trx
    .insertInto("issueSubscribers")
    .values(ids.map((userId) => ({ workspaceId, issueId, userId })))
    .onConflict((oc) => oc.columns(["issueId", "userId"]).doNothing())
    .execute();
}

export async function subscribersOf(trx: Tx, issueId: string): Promise<string[]> {
  const rows = await trx.selectFrom("issueSubscribers").select("userId").where("issueId", "=", issueId).execute();
  return rows.map((r) => r.userId);
}

/**
 * Creates in-app notifications, skipping the actor and anyone who turned that
 * event type off. Email delivery happens later in the digest job.
 */
export async function createNotifications(
  trx: Tx,
  p: {
    workspaceId: string;
    issueId: string;
    actorId: string;
    kind: NotificationKind;
    userIds: string[];
    data?: Record<string, unknown>;
  },
): Promise<string[]> {
  const targets = [...new Set(p.userIds)].filter((u) => u !== p.actorId);
  if (targets.length === 0) return [];
  const settings = await trx
    .selectFrom("notificationSettings")
    .select(["userId", "events"])
    .where("userId", "in", targets)
    .execute();
  const off = new Set(settings.filter((s) => s.events?.[p.kind] === false).map((s) => s.userId));
  const recipients = targets.filter((u) => !off.has(u));
  if (recipients.length === 0) return [];
  await trx
    .insertInto("notifications")
    .values(
      recipients.map((userId) => ({
        id: uuid7(),
        workspaceId: p.workspaceId,
        userId,
        issueId: p.issueId,
        kind: p.kind,
        actorId: p.actorId,
        data: JSON.stringify(p.data ?? {}),
      })),
    )
    .execute();
  for (const userId of recipients) await notify(trx, p.workspaceId, { t: "notification", id: p.issueId, userId });
  return recipients;
}
