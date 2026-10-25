import { z } from "zod";
import { getDb, schema, and, eq, desc, inArray } from "@veil/database";
import { authenticate, json, parseBody, route } from "@/lib/server/http";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const rows = await getDb()
    .select()
    .from(schema.notification)
    .where(eq(schema.notification.userId, ctx.userId))
    .orderBy(desc(schema.notification.id))
    .limit(100);
  return json({ notifications: rows.map((r) => ({ id: r.id, kind: r.kind, data: r.data, read: r.read, createdAt: r.createdAt.getTime() })) });
});

export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const { ids } = await parseBody(req, z.object({ ids: z.array(z.number()).max(500) }));
  if (ids.length) {
    await getDb()
      .update(schema.notification)
      .set({ read: true })
      .where(and(eq(schema.notification.userId, ctx.userId), inArray(schema.notification.id, ids)));
  }
  return json({ ok: true });
});
