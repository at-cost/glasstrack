import { Hono } from "hono";
import { type Comment, commentSchema } from "@glasstrack/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { notify } from "../db/tenant";
import { forbidden, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { findIssue } from "./issues";
import { queueWebhooks } from "./webhooks";
import { queueAutomation } from "./issueService";
import { createNotifications, resolveMentions, subscribe, subscribersOf } from "./notifyService";

const toComment = (r: { id: string; issueId: string; authorId: string | null; bodyMd: string; createdAt: Date; editedAt: Date | null }): Comment => ({
  id: r.id,
  issueId: r.issueId,
  authorId: r.authorId ?? "",
  body: r.bodyMd,
  createdAt: r.createdAt.toISOString(),
  editedAt: r.editedAt?.toISOString() ?? null,
});

const COLS = ["id", "issueId", "authorId", "bodyMd", "createdAt", "editedAt"] as const;

export const commentRoutes = new Hono<AppEnv>()
  .get("/issues/:ref/comments", async (c) => {
    const issue = await findIssue(c, c.req.param("ref"));
    const rows = await c.get("trx").selectFrom("comments").select(COLS).where("issueId", "=", issue.id)
      .where("deletedAt", "is", null).orderBy("createdAt").execute();
    return c.json(rows.map(toComment));
  })
  .post("/issues/:ref/comments", async (c) => {
    const user = requireUser(c);
    const { body } = commentSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const issue = await findIssue(c, c.req.param("ref"));
    const row = await trx.insertInto("comments")
      .values({ id: uuid7(), workspaceId: ws.id, issueId: issue.id, authorId: user.id, bodyMd: body })
      .returning(COLS).executeTakeFirstOrThrow();
    const mentioned = await resolveMentions(trx, body);
    const subscribers = await subscribersOf(trx, issue.id);
    await subscribe(trx, ws.id, issue.id, [user.id, ...mentioned]);
    const data = { commentId: row.id, excerpt: body.slice(0, 200) };
    const sentMention = await createNotifications(trx, { workspaceId: ws.id, issueId: issue.id, actorId: user.id, kind: "mentioned", userIds: mentioned, data });
    // Subscribers who were also mentioned get one notification, not two.
    await createNotifications(trx, {
      workspaceId: ws.id, issueId: issue.id, actorId: user.id, kind: "commented",
      userIds: subscribers.filter((u) => !sentMention.includes(u) && !mentioned.includes(u)), data,
    });
    await trx.updateTable("issues").set({ updatedAt: new Date() }).where("id", "=", issue.id).execute();
    await notify(trx, ws.id, { t: "comment", id: row.id, issueId: issue.id });
    queueWebhooks(c, "comment.created", { comment: toComment(row), issue: { id: issue.id, identifier: issue.identifier, title: issue.title } });
    queueAutomation(c, issue.id, user.id, [{ type: "comment_added" }]);
    return c.json(toComment(row), 201);
  })
  .patch("/comments/:id", async (c) => {
    const user = requireUser(c);
    const { body } = commentSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("comments").select(["authorId", "issueId", "bodyMd"]).where("id", "=", c.req.param("id"))
      .where("deletedAt", "is", null).executeTakeFirst();
    if (!cur) throw notFound("Comment not found");
    await findIssue(c, cur.issueId);
    if (cur.authorId !== user.id) throw forbidden("You can only edit your own comments");
    const row = await trx.updateTable("comments").set({ bodyMd: body, editedAt: new Date() }).where("id", "=", c.req.param("id"))
      .returning(COLS).executeTakeFirstOrThrow();
    const before = new Set(await resolveMentions(trx, cur.bodyMd));
    const fresh = (await resolveMentions(trx, body)).filter((u) => !before.has(u));
    await subscribe(trx, c.get("ws").id, cur.issueId, fresh);
    await createNotifications(trx, { workspaceId: c.get("ws").id, issueId: cur.issueId, actorId: user.id, kind: "mentioned", userIds: fresh, data: { commentId: row.id, excerpt: body.slice(0, 200) } });
    await notify(trx, c.get("ws").id, { t: "comment", id: row.id, issueId: cur.issueId });
    return c.json(toComment(row));
  })
  .delete("/comments/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const cur = await trx.selectFrom("comments").select(["authorId", "issueId"]).where("id", "=", c.req.param("id"))
      .where("deletedAt", "is", null).executeTakeFirst();
    if (!cur) throw notFound("Comment not found");
    await findIssue(c, cur.issueId);
    if (cur.authorId !== user.id) requireRole(c, "admin");
    await trx.updateTable("comments").set({ deletedAt: new Date(), bodyMd: "" }).where("id", "=", c.req.param("id")).execute();
    await notify(trx, c.get("ws").id, { t: "comment", id: c.req.param("id"), issueId: cur.issueId });
    return c.json({ ok: true });
  });
