import { Hono } from "hono";
import { sql } from "kysely";
import { type Attachment, attachmentRequestSchema } from "@tracker/shared";
import { type AppEnv, type Ctx, requireRole, requireUser } from "../context";
import { notify } from "../db/tenant";
import { badRequest, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { workspacePrefix } from "../storage";
import { findIssue } from "./issues";

const MAX_WORKSPACE_BYTES_SELF_HOST = Number.POSITIVE_INFINITY;

export const safeFilename = (name: string) =>
  name.normalize("NFKC").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

export async function attachmentsFor(c: Ctx, issueId: string): Promise<Attachment[]> {
  const rows = await c.get("trx").selectFrom("attachments")
    .select(["id", "filename", "contentType", "sizeBytes", "storageKey", "createdAt"])
    .where("issueId", "=", issueId).where("deletedAt", "is", null).where("uploadedAt", "is not", null)
    .orderBy("createdAt").execute();
  const storage = c.get("deps").storage;
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      filename: r.filename,
      contentType: r.contentType,
      size: Number(r.sizeBytes),
      url: await storage.downloadUrl(r.storageKey, r.filename),
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

export const attachmentRoutes = new Hono<AppEnv>()
  .post("/issues/:ref/attachments", async (c) => {
    const user = requireUser(c);
    const body = attachmentRequestSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const issue = await findIssue(c, c.req.param("ref"));
    const used = await trx.selectFrom("attachments").select(sql<string>`coalesce(sum(size_bytes), 0)`.as("n"))
      .where("deletedAt", "is", null).executeTakeFirstOrThrow();
    if (Number(used.n) + body.size > MAX_WORKSPACE_BYTES_SELF_HOST) throw badRequest("Storage limit reached");
    const id = uuid7();
    const filename = safeFilename(body.filename);
    const storageKey = `${workspacePrefix(ws.id)}attachments/${id}/${filename}`;
    await trx.insertInto("attachments").values({
      id, workspaceId: ws.id, issueId: issue.id, uploaderId: user.id, storageKey, filename,
      contentType: body.contentType || "application/octet-stream", sizeBytes: body.size,
    }).execute();
    const upload = await c.get("deps").storage.uploadTarget(storageKey, body.contentType || "application/octet-stream", body.size);
    return c.json({ id, upload }, 201);
  })
  .post("/attachments/:id/complete", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const row = await trx.selectFrom("attachments").selectAll().where("id", "=", c.req.param("id"))
      .where("deletedAt", "is", null).executeTakeFirst();
    if (!row) throw notFound("Attachment not found");
    await findIssue(c, row.issueId);
    const size = await c.get("deps").storage.size(row.storageKey);
    if (size === null) throw badRequest("Upload not found. Please try again.");
    await trx.updateTable("attachments").set({ uploadedAt: new Date(), sizeBytes: size }).where("id", "=", row.id).execute();
    await trx.insertInto("activity").values({
      workspaceId: row.workspaceId, issueId: row.issueId, actorId: user.id, kind: "attachment_added",
      data: JSON.stringify({ filename: row.filename }),
    }).execute();
    await notify(trx, row.workspaceId, { t: "issue", id: row.issueId });
    return c.json({ ok: true });
  })
  .delete("/attachments/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const row = await trx.selectFrom("attachments").selectAll().where("id", "=", c.req.param("id"))
      .where("deletedAt", "is", null).executeTakeFirst();
    if (!row) throw notFound("Attachment not found");
    await findIssue(c, row.issueId);
    if (row.uploaderId !== user.id) requireRole(c, "admin");
    await trx.updateTable("attachments").set({ deletedAt: new Date() }).where("id", "=", row.id).execute();
    await c.get("deps").storage.delete(row.storageKey);
    await notify(trx, row.workspaceId, { t: "issue", id: row.issueId });
    return c.json({ ok: true });
  });
