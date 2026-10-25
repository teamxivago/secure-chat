import { z } from "zod";
import { getDb, schema, and, eq, count } from "@veil/database";
import { MAX_PINNED } from "@veil/shared";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { effectiveRights, memberCan, pinnedIds, requireMember } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";

async function authorize(chatId: string, userId: string) {
  const { chat, member } = await requireMember(chatId, userId);
  if (!effectiveRights(member).pinMessages && !memberCan(chat, member, "pinMessages")) throw new HttpError(403, "cannot pin messages");
}

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const { messageId } = await parseBody(req, z.object({ messageId: z.string().max(64) }));
  await authorize(id, ctx.userId);
  const db = getDb();
  const [{ n }] = await db.select({ n: count() }).from(schema.pinnedMessage).where(eq(schema.pinnedMessage.chatId, id));
  if (n >= MAX_PINNED) throw new HttpError(409, `up to ${MAX_PINNED} pinned messages`);
  await db.insert(schema.pinnedMessage).values({ chatId: id, messageId, pinnedBy: ctx.userId }).onConflictDoNothing();
  const pins = await pinnedIds(id);
  emitter().to(rooms.chat(id)).emit("chat:pins", { chatId: id, pinnedIds: pins });
  return json({ pinnedIds: pins });
});

export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  await authorize(id, ctx.userId);
  const messageId = req.nextUrl.searchParams.get("messageId");
  const db = getDb();
  if (messageId) {
    await db.delete(schema.pinnedMessage).where(and(eq(schema.pinnedMessage.chatId, id), eq(schema.pinnedMessage.messageId, messageId)));
  } else {
    await db.delete(schema.pinnedMessage).where(eq(schema.pinnedMessage.chatId, id));
  }
  const pins = await pinnedIds(id);
  emitter().to(rooms.chat(id)).emit("chat:pins", { chatId: id, pinnedIds: pins });
  return json({ pinnedIds: pins });
});
