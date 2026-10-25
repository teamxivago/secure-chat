import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { emitter, rooms } from "@/lib/server/redis";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  if (id === ctx.userId) throw new HttpError(400, "cannot block yourself");
  await getDb().insert(schema.blockedUser).values({ userId: ctx.userId, blockedUserId: id }).onConflictDoNothing();
  emitter().to(rooms.user(ctx.userId)).emit("blocks:updated", {});
  return json({ ok: true });
});

export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  await getDb()
    .delete(schema.blockedUser)
    .where(and(eq(schema.blockedUser.userId, ctx.userId), eq(schema.blockedUser.blockedUserId, id)));
  emitter().to(rooms.user(ctx.userId)).emit("blocks:updated", {});
  return json({ ok: true });
});
