import { z } from "zod";
import { getDb, schema, eq } from "@veil/database";
import { authenticate, json, limit, parseBody, route } from "@/lib/server/http";

/** Recovery-key wrapped Account Storage Key. The server cannot unwrap it. */
export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  await limit(`akget:${ctx.userId}`, 10, 3600);
  const [u] = await getDb()
    .select({ wrapped: schema.user.accountKeyBackup })
    .from(schema.user)
    .where(eq(schema.user.id, ctx.userId));
  return json({ wrapped: u?.wrapped ?? null });
});

export const PUT = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const body = await parseBody(req, z.object({ wrapped: z.string().max(2000).nullable(), verifier: z.string().max(200) }));
  await getDb()
    .update(schema.user)
    .set({ accountKeyBackup: body.wrapped, accountKeyVerifier: body.verifier })
    .where(eq(schema.user.id, ctx.userId));
  return json({ ok: true });
});
