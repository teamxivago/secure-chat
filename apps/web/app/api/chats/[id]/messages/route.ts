import { getDb, schema, and, eq, gt, lt, gte, asc, desc } from "@veil/database";
import type { GroupMessageWire } from "@veil/shared";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { loadChat, membership } from "@/lib/server/chats";

/** Encrypted history of a group/channel (members only; public channels readable after joining). */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { id } = await params;
  const chat = await loadChat(id);
  const m = await membership(id, ctx.userId);
  if (!m) throw new HttpError(403, "not a member");
  const sp = req.nextUrl.searchParams;
  const after = sp.get("after");
  const before = sp.get("before");
  const lim = Math.min(500, Number(sp.get("limit") ?? 200) || 200);
  const floor = chat.type === "channel" ? 0 : m.joinedSeq;
  const rows = await getDb()
    .select()
    .from(schema.groupMessage)
    .where(
      and(
        eq(schema.groupMessage.chatId, id),
        gt(schema.groupMessage.seq, floor),
        ...(after ? [gt(schema.groupMessage.seq, Number(after))] : []),
        ...(before ? [lt(schema.groupMessage.seq, Number(before))] : []),
        ...(sp.get("fromSeq") ? [gte(schema.groupMessage.seq, Number(sp.get("fromSeq")))] : []),
      ),
    )
    .orderBy(before ? desc(schema.groupMessage.seq) : asc(schema.groupMessage.seq))
    .limit(lim);
  if (before) rows.reverse();
  const messages: GroupMessageWire[] = rows.map((r) => ({
    id: r.id,
    chatId: r.chatId,
    seq: r.seq,
    ciphertext: r.ciphertext.toString("base64"),
    ts: r.createdAt.getTime(),
    editedAt: r.editedAt?.getTime() ?? null,
    deleteIds: r.deleteIds ?? undefined,
    views: chat.type === "channel" ? r.viewCount : undefined,
  }));
  return json({ messages, lastSeq: chat.lastSeq, more: rows.length === lim });
});
