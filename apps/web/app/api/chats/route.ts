import { getDb, schema, eq, inArray, desc } from "@veil/database";
import { createChatSchema, DEFAULT_MEMBER_PERMISSIONS } from "@veil/shared";
import { authenticate, HttpError, json, limit, parseBody, route } from "@/lib/server/http";
import { addMembers, newId, OWNER_RIGHTS, summarize } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";
import { indexChat } from "@/lib/server/search";
import { randomBytes } from "node:crypto";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const db = getDb();
  const rows = await db
    .select({ c: schema.chat, m: schema.chatMember })
    .from(schema.chatMember)
    .innerJoin(schema.chat, eq(schema.chat.id, schema.chatMember.chatId))
    .where(eq(schema.chatMember.userId, ctx.userId))
    .orderBy(desc(schema.chat.updatedAt));
  const ids = rows.map((r) => r.c.id);
  const pins = ids.length
    ? await db.select().from(schema.pinnedMessage).where(inArray(schema.pinnedMessage.chatId, ids)).orderBy(desc(schema.pinnedMessage.pinnedAt))
    : [];
  return json({
    chats: rows.map(({ c, m }) => summarize(c, m, pins.filter((p) => p.chatId === c.id).map((p) => p.messageId))),
  });
});

export const POST = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  await limit(`chatcreate:${ctx.userId}`, 30, 3600);
  const body = await parseBody(req, createChatSchema);
  const db = getDb();
  if (body.username) {
    const lower = body.username.toLowerCase();
    const [u] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.username, lower));
    const [c] = await db.select({ id: schema.chat.id }).from(schema.chat).where(eq(schema.chat.username, lower));
    if (u || c) throw new HttpError(409, "username is taken");
  }
  if (body.isPublic && !body.username) throw new HttpError(400, "public chats need a username");
  const id = newId(body.type === "channel" ? "ch" : "gr");
  const [chat] = await db
    .insert(schema.chat)
    .values({
      id,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      username: body.username?.toLowerCase() ?? null,
      isPublic: body.isPublic,
      avatarMediaId: body.avatarMediaId ?? null,
      avatarKey: body.avatarKey ?? null,
      createdBy: ctx.userId,
      memberCount: 1,
      defaultPermissions: DEFAULT_MEMBER_PERMISSIONS,
    })
    .returning();
  await db.insert(schema.chatMember).values({ chatId: id, userId: ctx.userId, role: "owner", rights: OWNER_RIGHTS, joinedSeq: 0 });
  await db.insert(schema.groupInviteLink).values({
    id: newId("inv"),
    chatId: id,
    token: randomBytes(12).toString("base64url"),
    createdBy: ctx.userId,
    isPrimary: true,
  });
  emitter().in(rooms.user(ctx.userId)).socketsJoin(rooms.chat(id));
  const others = [...new Set(body.memberIds)].filter((u) => u !== ctx.userId);
  if (others.length) {
    const blockers = await db.select({ u: schema.blockedUser.userId }).from(schema.blockedUser).where(eq(schema.blockedUser.blockedUserId, ctx.userId));
    const blocked = new Set(blockers.map((b) => b.u));
    const added = await addMembers(chat, others.filter((u) => !blocked.has(u)), ctx.userId);
    for (const u of added) emitter().to(rooms.user(u)).emit("chat:added", { chatId: id, by: ctx.userId });
  }
  await indexChat(chat);
  const [fresh] = await db.select().from(schema.chat).where(eq(schema.chat.id, id));
  const [m] = await db.select().from(schema.chatMember).where(eq(schema.chatMember.chatId, id));
  return json(summarize(fresh, m, []), 201);
});
