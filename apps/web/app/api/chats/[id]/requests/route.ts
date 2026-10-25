import { getDb, schema, and, eq, desc } from "@veil/database";
import { authenticate, json, route } from "@/lib/server/http";
import { requireRight } from "@/lib/server/chats";
import { publicUsers } from "@/lib/server/users";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  await requireRight(id, ctx.userId, "inviteUsers");
  const rows = await getDb()
    .select({ r: schema.groupJoinRequest, u: schema.user })
    .from(schema.groupJoinRequest)
    .innerJoin(schema.user, eq(schema.user.id, schema.groupJoinRequest.userId))
    .where(and(eq(schema.groupJoinRequest.chatId, id), eq(schema.groupJoinRequest.status, "pending")))
    .orderBy(desc(schema.groupJoinRequest.createdAt));
  const users = await publicUsers(ctx.userId, rows.map((r) => r.u));
  return json({ requests: rows.map((r, i) => ({ userId: r.r.userId, createdAt: r.r.createdAt.getTime(), user: users[i] })) });
});
