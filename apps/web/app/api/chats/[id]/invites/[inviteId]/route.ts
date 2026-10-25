import { randomBytes } from "node:crypto";
import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { newId, requireRight } from "@/lib/server/chats";

/** Revoke an invite link. Revoking the primary link replaces it with a fresh one. */
export const DELETE = route<{ id: string; inviteId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id, inviteId } = await params;
  await requireRight(id, ctx.userId, "inviteUsers");
  const db = getDb();
  const [l] = await db
    .update(schema.groupInviteLink)
    .set({ revoked: true })
    .where(and(eq(schema.groupInviteLink.id, inviteId), eq(schema.groupInviteLink.chatId, id)))
    .returning();
  if (!l) throw new HttpError(404, "invite not found");
  if (l.isPrimary) {
    await db.update(schema.groupInviteLink).set({ isPrimary: false }).where(eq(schema.groupInviteLink.id, l.id));
    await db.insert(schema.groupInviteLink).values({
      id: newId("inv"),
      chatId: id,
      token: randomBytes(12).toString("base64url"),
      createdBy: ctx.userId,
      isPrimary: true,
    });
  }
  return json({ ok: true });
});
