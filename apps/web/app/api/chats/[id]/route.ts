import { getDb, schema, and, eq, ne } from "@veil/database";
import { updateChatSchema } from "@veil/shared";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { chatSummaryFor, loadChat, notifyChatUpdated, requireMember, requireRight, effectiveRights, memberCan } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";
import { indexChat } from "@/lib/server/search";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  return json(await chatSummaryFor((await params).id, ctx.userId));
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const body = await parseBody(req, updateChatSchema);
  const { chat, member } = await requireMember(id, ctx.userId);
  const rights = effectiveRights(member);
  const infoKeys = ["title", "description", "avatarMediaId", "avatarKey", "username", "isPublic", "joinApproval", "signMessages", "hideSubscriberCount", "linkedChatId", "defaultPermissions"] as const;
  const touchesInfo = infoKeys.some((k) => body[k] !== undefined);
  if (touchesInfo && !rights.changeInfo && !memberCan(chat, member, "changeInfo")) throw new HttpError(403, "missing right: changeInfo");
  if ((body.defaultPermissions || body.username !== undefined || body.isPublic !== undefined || body.linkedChatId !== undefined) && !rights.changeInfo) {
    throw new HttpError(403, "admins only");
  }
  if (body.slowModeSeconds !== undefined && !rights.setSlowMode) throw new HttpError(403, "missing right: setSlowMode");
  if ((body.reactionsMode !== undefined || body.allowedReactions !== undefined) && !rights.manageReactions) {
    throw new HttpError(403, "missing right: manageReactions");
  }
  const db = getDb();
  const set: Partial<typeof schema.chat.$inferInsert> = { updatedAt: new Date() };
  for (const k of Object.keys(body) as (keyof typeof body)[]) {
    if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
  }
  if (body.username !== undefined) {
    if (body.username) {
      const lower = body.username.toLowerCase();
      const [u] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.username, lower));
      const [c] = await db.select({ id: schema.chat.id }).from(schema.chat).where(and(eq(schema.chat.username, lower), ne(schema.chat.id, id)));
      if (u || c) throw new HttpError(409, "username is taken");
      set.username = lower;
    } else set.username = null;
  }
  const willBePublic = body.isPublic ?? chat.isPublic;
  const willHaveUsername = set.username !== undefined ? set.username : chat.username;
  if (willBePublic && !willHaveUsername) throw new HttpError(400, "public chats need a username");
  if (body.linkedChatId) {
    const linked = await loadChat(body.linkedChatId);
    if (chat.type !== "channel" || linked.type !== "group") throw new HttpError(400, "a channel can only link a discussion group");
    await requireRight(linked.id, ctx.userId, "changeInfo");
  }
  const [updated] = await db.update(schema.chat).set(set).where(eq(schema.chat.id, id)).returning();
  await indexChat(updated);
  notifyChatUpdated(id);
  return json(await chatSummaryFor(id, ctx.userId));
});

/** Owner deletes the group/channel for everyone. */
export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const { chat, member } = await requireMember(id, ctx.userId);
  if (member.role !== "owner") throw new HttpError(403, "only the owner can delete");
  emitter().to(rooms.chat(id)).emit("chat:deleted", { chatId: id });
  emitter().in(rooms.chat(id)).socketsLeave(rooms.chat(id));
  await getDb().delete(schema.chat).where(eq(schema.chat.id, id));
  await indexChat({ ...chat, isPublic: false });
  return json({ ok: true });
});
