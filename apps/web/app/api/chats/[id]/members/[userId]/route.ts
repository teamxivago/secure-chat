import { z } from "zod";
import { getDb, schema, and, eq } from "@veil/database";
import { ADMIN_RIGHTS } from "@veil/shared";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { DEFAULT_ADMIN_RIGHTS, effectiveRights, membership, notifyChatUpdated, removeMember, requireMember } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";

const rightsSchema = z.object(Object.fromEntries(ADMIN_RIGHTS.map((r) => [r, z.boolean().optional()])) as Record<(typeof ADMIN_RIGHTS)[number], z.ZodOptional<z.ZodBoolean>>);

/** Promote / demote / edit admin rights / transfer ownership. */
export const PATCH = route<{ id: string; userId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id, userId } = await params;
  const body = await parseBody(
    req,
    z.object({ role: z.enum(["admin", "member", "owner"]), rights: rightsSchema.optional(), title: z.string().max(16).nullable().optional() }),
  );
  const { chat, member } = await requireMember(id, ctx.userId);
  const target = await membership(id, userId);
  if (!target) throw new HttpError(404, "not a member");
  const myRights = effectiveRights(member);
  const db = getDb();
  if (body.role === "owner") {
    if (member.role !== "owner") throw new HttpError(403, "only the owner can transfer ownership");
    await db.update(schema.chatMember).set({ role: "owner", rights: {} }).where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, userId)));
    await db
      .update(schema.chatMember)
      .set({ role: "admin", rights: DEFAULT_ADMIN_RIGHTS })
      .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, ctx.userId)));
  } else {
    if (!myRights.addAdmins) throw new HttpError(403, "missing right: addAdmins");
    if (target.role === "owner") throw new HttpError(403, "cannot change the owner");
    // Admins can only grant rights they hold themselves.
    const requested = body.role === "admin" ? { ...DEFAULT_ADMIN_RIGHTS, ...(chat.type === "channel" ? { postMessages: true } : {}), ...(body.rights ?? {}) } : {};
    const granted = Object.fromEntries(Object.entries(requested).filter(([k, v]) => v && (member.role === "owner" || myRights[k as keyof typeof myRights])));
    await db
      .update(schema.chatMember)
      .set({ role: body.role, rights: granted, customTitle: body.title ?? target.customTitle })
      .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, userId)));
  }
  emitter().to(rooms.chat(id)).emit("chat:members", { chatId: id, roles: [userId], by: ctx.userId });
  notifyChatUpdated(id);
  return json({ ok: true });
});

/** Remove (kick) or ban a member. */
export const DELETE = route<{ id: string; userId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id, userId } = await params;
  const ban = req.nextUrl.searchParams.get("ban") === "1";
  const { chat, member } = await requireMember(id, ctx.userId);
  if (!effectiveRights(member).banUsers) throw new HttpError(403, "missing right: banUsers");
  const target = await membership(id, userId);
  if (target?.role === "owner") throw new HttpError(403, "cannot remove the owner");
  if (target?.role === "admin" && member.role !== "owner") throw new HttpError(403, "only the owner can remove admins");
  if (ban) await getDb().insert(schema.chatBan).values({ chatId: id, userId, bannedBy: ctx.userId }).onConflictDoNothing();
  await removeMember(chat, userId, ctx.userId, ban ? "banned" : "removed");
  return json({ ok: true });
});
