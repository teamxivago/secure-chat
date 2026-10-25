import { getDb, getSql, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { addMembers, chatSummaryFor, loadChat, membership } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";

async function loadInvite(token: string) {
  const [l] = await getDb().select().from(schema.groupInviteLink).where(eq(schema.groupInviteLink.token, token));
  if (!l || l.revoked) throw new HttpError(404, "invite link is invalid or revoked");
  if (l.expiresAt && l.expiresAt < new Date()) throw new HttpError(410, "invite link expired");
  if (l.usageLimit && l.usageCount >= l.usageLimit) throw new HttpError(410, "invite link usage limit reached");
  return l;
}

/** Preview: title, avatar, member count (no message content). */
export const GET = route<{ token: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const l = await loadInvite((await params).token);
  const chat = await loadChat(l.chatId);
  return json({
    chatId: chat.id,
    type: chat.type,
    title: chat.title,
    description: chat.description,
    avatarMediaId: chat.avatarMediaId,
    avatarKey: chat.avatarKey,
    memberCount: chat.hideSubscriberCount ? -1 : chat.memberCount,
    requiresApproval: l.requiresApproval || chat.joinApproval,
    isMember: !!(await membership(chat.id, ctx.userId)),
  });
});

export const POST = route<{ token: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const l = await loadInvite((await params).token);
  const chat = await loadChat(l.chatId);
  if (await membership(chat.id, ctx.userId)) return json(await chatSummaryFor(chat.id, ctx.userId));
  const [banned] = await getDb().select().from(schema.chatBan).where(and(eq(schema.chatBan.chatId, chat.id), eq(schema.chatBan.userId, ctx.userId)));
  if (banned) throw new HttpError(403, "you were banned from this chat");
  if (l.requiresApproval || chat.joinApproval) {
    await getDb()
      .insert(schema.groupJoinRequest)
      .values({ chatId: chat.id, userId: ctx.userId, inviteId: l.id })
      .onConflictDoUpdate({ target: [schema.groupJoinRequest.chatId, schema.groupJoinRequest.userId], set: { status: "pending", createdAt: new Date() } });
    emitter().to(rooms.chat(chat.id)).emit("chat:joinRequest", { chatId: chat.id, userId: ctx.userId });
    return json({ requested: true }, 202);
  }
  // Atomic usage accounting so limits can't be exceeded under concurrency.
  const [ok] = await getSql()`update group_invite_link set usage_count = usage_count + 1
    where id = ${l.id} and (usage_limit = 0 or usage_count < usage_limit) returning id`;
  if (!ok) throw new HttpError(410, "invite link usage limit reached");
  await addMembers(chat, [ctx.userId], l.createdBy);
  return json(await chatSummaryFor(chat.id, ctx.userId));
});
