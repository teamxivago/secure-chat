import { z } from "zod";
import { getDb, schema, and, eq, inArray } from "@veil/database";
import { authenticate, json, limit, parseBody, route } from "@/lib/server/http";
import { publicUsers } from "@/lib/server/users";

export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const { tokens } = await parseBody(req, z.object({ tokens: z.array(z.string().max(100)).min(1).max(2000) }));
  await limit(`cmatch:${ctx.userId}`, 50, 3600);
  const rows = await getDb()
    .select()
    .from(schema.user)
    .where(and(inArray(schema.user.discoveryToken, tokens), eq(schema.user.phoneDiscoverable, true)));
  const users = await publicUsers(ctx.userId, rows.filter((r) => r.id !== ctx.userId));
  const byId = new Map(rows.map((r) => [r.id, r.discoveryToken!]));
  return json({ matches: users.filter((u) => !u.blockedMe).map((u) => ({ token: byId.get(u.id), user: u })) });
});
