import { sql } from "kysely";
import { extractMentions, type NotificationKind } from "@glasstrack/shared";
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

/**
 * Of these users, those who can see the issue's team: admins, team members,
 * and members/viewers when the team isn't private. Guests only see their teams.
 */
export async function whoCanSee(trx: Tx, workspaceId: string, issueId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const r = await sql<{ userId: string }>`
    SELECT m.user_id FROM workspace_members m
    JOIN issues i ON i.id = ${issueId}
    JOIN teams t ON t.id = i.team_id
    WHERE m.workspace_id = ${workspaceId} AND m.user_id = ANY(${userIds}::uuid[])
      AND (m.role = 'admin'
        OR (m.role IN ('member', 'viewer') AND NOT t.private)
        OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = m.user_id))`.execute(trx);
  return r.rows.map((x) => x.userId);
}

export async function subscribe(trx: Tx, workspaceId: string, issueId: string, userIds: (string | null | undefined)[]) {
  const ids = await whoCanSee(trx, workspaceId, issueId, [...new Set(userIds.filter((u): u is string => Boolean(u)))]);
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
    /** null = done by an automation (see data.rule). */
    actorId: string | null;
    kind: NotificationKind;
    userIds: string[];
    data?: Record<string, unknown>;
  },
): Promise<string[]> {
  const targets = await whoCanSee(trx, p.workspaceId, p.issueId, [...new Set(p.userIds)].filter((u) => u !== p.actorId));
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
