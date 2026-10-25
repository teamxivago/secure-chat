import { getDb, schema, and, eq, ne, asc } from "@veil/database";
import { authenticate, json, route } from "@/lib/server/http";
import { OWNER_RIGHTS, removeMember, requireMember } from "@/lib/server/chats";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  const { chat, member } = await requireMember(id, ctx.userId);
  const db = getDb();
  if (member.role === "owner") {
    // Hand ownership to the longest-serving admin, else the oldest member.
    const [next] = await db
      .select()
      .from(schema.chatMember)
      .where(and(eq(schema.chatMember.chatId, id), ne(schema.chatMember.userId, ctx.userId)))
      .orderBy(asc(schema.chatMember.role), asc(schema.chatMember.joinedAt))
      .limit(1);
    if (!next) {
      await db.delete(schema.chat).where(eq(schema.chat.id, id));
      return json({ ok: true, deleted: true });
    }
    await db
      .update(schema.chatMember)
      .set({ role: "owner", rights: OWNER_RIGHTS })
      .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, next.userId)));
  }
  await removeMember(chat, ctx.userId, ctx.userId, "left");
  return json({ ok: true });
});
