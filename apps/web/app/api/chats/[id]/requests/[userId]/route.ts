import { z } from "zod";
import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { addMembers, requireRight } from "@/lib/server/chats";
import { emitter, enqueuePush, rooms } from "@/lib/server/redis";

export const POST = route<{ id: string; userId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id, userId } = await params;
  const { approve } = await parseBody(req, z.object({ approve: z.boolean() }));
  const { chat } = await requireRight(id, ctx.userId, "inviteUsers");
  const db = getDb();
  const [r] = await db
    .update(schema.groupJoinRequest)
    .set({ status: approve ? "approved" : "declined", decidedBy: ctx.userId })
    .where(and(eq(schema.groupJoinRequest.chatId, id), eq(schema.groupJoinRequest.userId, userId), eq(schema.groupJoinRequest.status, "pending")))
    .returning();
  if (!r) throw new HttpError(404, "no pending request");
  if (approve) {
    await addMembers(chat, [userId], ctx.userId);
    emitter().to(rooms.user(userId)).emit("chat:added", { chatId: id, by: ctx.userId });
  }
  await db.insert(schema.notification).values({ userId, kind: approve ? "join_approved" : "join_declined", data: { chatId: id, title: chat.title } });
  await enqueuePush({
    kind: "system",
    userIds: [userId],
    title: chat.title,
    body: approve ? "Your request to join was approved" : "Your request to join was declined",
    data: { chatId: id, type: "system" },
  });
  emitter().to(rooms.chat(id)).emit("chat:joinRequest", { chatId: id, userId, decided: true });
  return json({ ok: true });
});
