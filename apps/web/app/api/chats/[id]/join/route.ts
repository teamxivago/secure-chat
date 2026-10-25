import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { addMembers, chatSummaryFor, loadChat, membership } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";

/** Join a public group or subscribe to a public channel. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const chat = await loadChat(id);
  if (!chat.isPublic) throw new HttpError(403, "this chat is private; use an invite link");
  if (await membership(id, ctx.userId)) return json(await chatSummaryFor(id, ctx.userId));
  const [banned] = await getDb().select().from(schema.chatBan).where(and(eq(schema.chatBan.chatId, id), eq(schema.chatBan.userId, ctx.userId)));
  if (banned) throw new HttpError(403, "you were banned from this chat");
  if (chat.joinApproval && chat.type === "group") {
    await getDb().insert(schema.groupJoinRequest).values({ chatId: id, userId: ctx.userId }).onConflictDoNothing();
    emitter().to(rooms.chat(id)).emit("chat:joinRequest", { chatId: id, userId: ctx.userId });
    return json({ requested: true }, 202);
  }
  await addMembers(chat, [ctx.userId], null);
  return json(await chatSummaryFor(id, ctx.userId));
});
