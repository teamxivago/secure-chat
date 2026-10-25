import { z } from "zod";
import { getDb, schema, and, eq, inArray } from "@veil/database";
import { authenticate, json, parseBody, route } from "@/lib/server/http";
import { publicUsers } from "@/lib/server/users";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const rows = await getDb()
    .select({ u: schema.user })
    .from(schema.contact)
    .innerJoin(schema.user, eq(schema.user.id, schema.contact.contactUserId))
    .where(eq(schema.contact.ownerId, ctx.userId));
  return json({ contacts: await publicUsers(ctx.userId, rows.map((r) => r.u)) });
});

const ids = z.object({ userIds: z.array(z.string().max(64)).min(1).max(1000) });

export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const { userIds } = await parseBody(req, ids);
  const valid = await getDb().select({ id: schema.user.id }).from(schema.user).where(inArray(schema.user.id, userIds));
  const values = valid.filter((v) => v.id !== ctx.userId).map((v) => ({ ownerId: ctx.userId, contactUserId: v.id }));
  if (values.length) await getDb().insert(schema.contact).values(values).onConflictDoNothing();
  return json({ added: values.length });
});

export const DELETE = route(async (req) => {
  const ctx = await authenticate(req);
  const { userIds } = await parseBody(req, ids);
  await getDb()
    .delete(schema.contact)
    .where(and(eq(schema.contact.ownerId, ctx.userId), inArray(schema.contact.contactUserId, userIds)));
  return json({ ok: true });
});
