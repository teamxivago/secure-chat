import { z } from "zod";
import { getDb, schema, and, eq, sql, asc, inArray } from "@veil/database";
import type { ChatMemberInfo } from "@veil/shared";
import { MAX_GROUP_MEMBERS } from "@veil/shared";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { addMembers, effectiveRights, memberCan, requireMember } from "@/lib/server/chats";
import { publicUsers } from "@/lib/server/users";
import { emitter, rooms } from "@/lib/server/redis";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  const { chat, member } = await requireMember(id, ctx.userId);
  const isAdmin = member.role !== "member";
  if (chat.type === "channel" && !isAdmin) throw new HttpError(403, "subscriber list is visible to admins only");
  const q = (req.nextUrl.searchParams.get("q") ?? "").toLowerCase().trim();
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") ?? 0) || 0);
  const lim = Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? 100) || 100);
  const role = req.nextUrl.searchParams.get("role");
  const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const rows = await getDb()
    .select({ m: schema.chatMember, u: schema.user })
    .from(schema.chatMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.chatMember.userId))
    .where(
      and(
        eq(schema.chatMember.chatId, id),
        ...(role === "admins" ? [sql`${schema.chatMember.role} in ('owner','admin')`] : []),
        ...(q ? [sql`(lower(${schema.user.name} || ' ' || coalesce(${schema.user.lastName},'')) like ${like} or lower(coalesce(${schema.user.username},'')) like ${like})`] : []),
      ),
    )
    .orderBy(sql`case ${schema.chatMember.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(schema.chatMember.joinedAt))
    .limit(lim)
    .offset(offset);
  const users = await publicUsers(ctx.userId, rows.map((r) => r.u));
  const members: ChatMemberInfo[] = rows.map((r, i) => ({
    userId: r.m.userId,
    role: r.m.role as ChatMemberInfo["role"],
    rights: effectiveRights(r.m),
    title: r.m.customTitle,
    joinedAt: r.m.joinedAt.getTime(),
    user: users[i],
  }));
  return json({ members, total: chat.memberCount });
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const { userIds } = await parseBody(req, z.object({ userIds: z.array(z.string()).min(1).max(200) }));
  const { chat, member } = await requireMember(id, ctx.userId);
  if (!effectiveRights(member).inviteUsers && !memberCan(chat, member, "addMembers")) throw new HttpError(403, "cannot add members");
  if (chat.type === "group" && chat.memberCount + userIds.length > MAX_GROUP_MEMBERS) throw new HttpError(400, "member limit reached");
  const db = getDb();
  // Users who blocked the inviter can't be added by them.
  const blockers = await db
    .select({ u: schema.blockedUser.userId })
    .from(schema.blockedUser)
    .where(and(eq(schema.blockedUser.blockedUserId, ctx.userId), inArray(schema.blockedUser.userId, userIds)));
  const blocked = new Set(blockers.map((b) => b.u));
  const added = await addMembers(chat, userIds.filter((u) => !blocked.has(u)), ctx.userId);
  for (const u of added) emitter().to(rooms.user(u)).emit("chat:added", { chatId: id, by: ctx.userId });
  return json({ added, skipped: userIds.filter((u) => !added.includes(u)) });
});
