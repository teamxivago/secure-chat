import { randomBytes } from "node:crypto";
import { getDb, schema, eq, desc } from "@veil/database";
import { inviteLinkSchema } from "@veil/shared";
import { authenticate, json, parseBody, route } from "@/lib/server/http";
import { newId, requireRight } from "@/lib/server/chats";

const view = (l: typeof schema.groupInviteLink.$inferSelect) => ({
  id: l.id,
  token: l.token,
  name: l.name,
  expiresAt: l.expiresAt?.getTime() ?? null,
  usageLimit: l.usageLimit,
  usageCount: l.usageCount,
  requiresApproval: l.requiresApproval,
  revoked: l.revoked,
  isPrimary: l.isPrimary,
  createdAt: l.createdAt.getTime(),
});

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  await requireRight(id, ctx.userId, "inviteUsers");
  const rows = await getDb().select().from(schema.groupInviteLink).where(eq(schema.groupInviteLink.chatId, id)).orderBy(desc(schema.groupInviteLink.createdAt));
  return json({ invites: rows.map(view) });
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  await requireRight(id, ctx.userId, "inviteUsers");
  const body = await parseBody(req, inviteLinkSchema);
  const [l] = await getDb()
    .insert(schema.groupInviteLink)
    .values({
      id: newId("inv"),
      chatId: id,
      token: randomBytes(12).toString("base64url"),
      name: body.name ?? null,
      createdBy: ctx.userId,
      expiresAt: body.expiresIn ? new Date(Date.now() + body.expiresIn * 1000) : null,
      usageLimit: body.usageLimit,
      requiresApproval: body.requiresApproval,
    })
    .returning();
  return json(view(l), 201);
});
