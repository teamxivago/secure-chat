import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { getDb, schema, and, eq, sql, inArray, desc } from "@veil/database";
import {
  DEFAULT_MEMBER_PERMISSIONS,
  type AdminRight,
  type AdminRights,
  type ChatRole,
  type ChatSummary,
  type MemberPermission,
  type MemberPermissions,
} from "@veil/shared";
import { env } from "./env";
import { HttpError } from "./http";
import { emitter, rooms } from "./redis";

export type ChatRow = typeof schema.chat.$inferSelect;
export type MemberRow = typeof schema.chatMember.$inferSelect;

export const OWNER_RIGHTS: AdminRights = {
  changeInfo: true,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
  manageReactions: true,
  addAdmins: true,
  setSlowMode: true,
  manageBots: true,
  postMessages: true,
  manageCalls: true,
};

export const DEFAULT_ADMIN_RIGHTS: AdminRights = { ...OWNER_RIGHTS, addAdmins: false };

export function senderTag(userId: string, chatId: string) {
  return createHmac("sha256", env.senderTagPepper).update(`${userId}:${chatId}`).digest("base64url");
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;

export async function loadChat(chatId: string): Promise<ChatRow> {
  const [c] = await getDb().select().from(schema.chat).where(eq(schema.chat.id, chatId)).limit(1);
  if (!c) throw new HttpError(404, "chat not found");
  return c;
}

export async function membership(chatId: string, userId: string): Promise<MemberRow | null> {
  const [m] = await getDb()
    .select()
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, chatId), eq(schema.chatMember.userId, userId)))
    .limit(1);
  return m ?? null;
}

export function effectiveRights(m: MemberRow | null): AdminRights {
  if (!m) return {};
  if (m.role === "owner") return OWNER_RIGHTS;
  if (m.role === "admin") return m.rights as AdminRights;
  return {};
}

export function memberCan(chat: ChatRow, m: MemberRow | null, perm: MemberPermission): boolean {
  if (!m) return false;
  if (m.role === "owner" || m.role === "admin") return true;
  if (chat.type === "channel") return false;
  const perms = { ...DEFAULT_MEMBER_PERMISSIONS, ...(chat.defaultPermissions as Partial<MemberPermissions>) };
  return !!perms[perm];
}

export async function requireMember(chatId: string, userId: string) {
  const chat = await loadChat(chatId);
  const m = await membership(chatId, userId);
  if (!m) throw new HttpError(403, "not a member");
  return { chat, member: m };
}

export async function requireRight(chatId: string, userId: string, right: AdminRight) {
  const { chat, member } = await requireMember(chatId, userId);
  if (!effectiveRights(member)[right]) throw new HttpError(403, `missing admin right: ${right}`);
  return { chat, member };
}

export async function pinnedIds(chatId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: schema.pinnedMessage.messageId })
    .from(schema.pinnedMessage)
    .where(eq(schema.pinnedMessage.chatId, chatId))
    .orderBy(desc(schema.pinnedMessage.pinnedAt));
  return rows.map((r) => r.id);
}

export function summarize(c: ChatRow, m: MemberRow | null, pins: string[]): ChatSummary {
  const isAdmin = m && (m.role === "owner" || m.role === "admin");
  return {
    id: c.id,
    type: c.type as "group" | "channel",
    title: c.title,
    description: c.description,
    username: c.username,
    isPublic: c.isPublic,
    avatarMediaId: c.avatarMediaId,
    avatarKey: c.avatarKey,
    memberCount: c.hideSubscriberCount && !isAdmin ? -1 : c.memberCount,
    myRole: (m?.role as ChatRole) ?? null,
    myRights: effectiveRights(m),
    defaultPermissions: { ...DEFAULT_MEMBER_PERMISSIONS, ...(c.defaultPermissions as Partial<MemberPermissions>) },
    slowModeSeconds: c.slowModeSeconds,
    reactionsMode: c.reactionsMode as ChatSummary["reactionsMode"],
    allowedReactions: c.allowedReactions,
    joinApproval: c.joinApproval,
    signMessages: c.signMessages,
    hideSubscriberCount: c.hideSubscriberCount,
    linkedChatId: c.linkedChatId,
    keyEpoch: c.keyEpoch,
    lastSeq: c.lastSeq,
    joinedSeq: m?.joinedSeq ?? 0,
    pinnedIds: pins,
    createdAt: c.createdAt.getTime(),
  };
}

export async function chatSummaryFor(chatId: string, userId: string): Promise<ChatSummary> {
  const chat = await loadChat(chatId);
  const m = await membership(chatId, userId);
  if (!m && !chat.isPublic) throw new HttpError(403, "not a member");
  return summarize(chat, m, await pinnedIds(chatId));
}

/** Adds users, updates counts, subscribes their live sockets and notifies everyone. */
export async function addMembers(chat: ChatRow, userIds: string[], invitedBy: string | null) {
  if (!userIds.length) return [];
  const db = getDb();
  const banned = await db
    .select({ u: schema.chatBan.userId })
    .from(schema.chatBan)
    .where(and(eq(schema.chatBan.chatId, chat.id), inArray(schema.chatBan.userId, userIds)));
  const bannedSet = new Set(banned.map((b) => b.u));
  const toAdd = userIds.filter((u) => !bannedSet.has(u));
  if (!toAdd.length) return [];
  const inserted = await db
    .insert(schema.chatMember)
    .values(toAdd.map((userId) => ({ chatId: chat.id, userId, role: "member", joinedSeq: chat.lastSeq, invitedBy })))
    .onConflictDoNothing()
    .returning({ userId: schema.chatMember.userId });
  if (inserted.length) {
    await db
      .update(schema.chat)
      .set({ memberCount: sql`${schema.chat.memberCount} + ${inserted.length}` })
      .where(eq(schema.chat.id, chat.id));
    for (const { userId } of inserted) emitter().in(rooms.user(userId)).socketsJoin(rooms.chat(chat.id));
    emitter().to(rooms.chat(chat.id)).emit("chat:members", { chatId: chat.id, added: inserted.map((i) => i.userId), by: invitedBy });
  }
  return inserted.map((i) => i.userId);
}

/** Removes a member; rotates the group key epoch so remaining senders re-key (forward secrecy on removal). */
export async function removeMember(chat: ChatRow, userId: string, by: string, reason: "left" | "removed" | "banned") {
  const db = getDb();
  const deleted = await db
    .delete(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, chat.id), eq(schema.chatMember.userId, userId)))
    .returning();
  if (!deleted.length) return;
  await db.update(schema.chat).set({ memberCount: sql`greatest(${schema.chat.memberCount} - 1, 0)` }).where(eq(schema.chat.id, chat.id));
  emitter().in(rooms.user(userId)).socketsLeave(rooms.chat(chat.id));
  emitter().to(rooms.chat(chat.id)).emit("chat:members", { chatId: chat.id, removed: [userId], by, reason });
  emitter().to(rooms.user(userId)).emit("chat:removed", { chatId: chat.id, reason });
  if (chat.type === "group") await bumpEpoch(chat.id, `member_${reason}`, by);
}

export async function bumpEpoch(chatId: string, reason: string, by: string | null) {
  const db = getDb();
  const [c] = await db
    .update(schema.chat)
    .set({ keyEpoch: sql`${schema.chat.keyEpoch} + 1` })
    .where(eq(schema.chat.id, chatId))
    .returning({ epoch: schema.chat.keyEpoch });
  await db.insert(schema.senderKeyEpoch).values({ chatId, epoch: c.epoch, reason, rotatedBy: by });
  emitter().to(rooms.chat(chatId)).emit("chat:epoch", { chatId, epoch: c.epoch, reason });
  return c.epoch;
}

export function notifyChatUpdated(chatId: string) {
  emitter().to(rooms.chat(chatId)).emit("chat:updated", { chatId });
}
