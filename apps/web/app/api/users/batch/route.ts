import { z } from "zod";
import { getDb, schema, inArray } from "@veil/database";
import { authenticate, json, parseBody, route } from "@/lib/server/http";
import { publicUsers } from "@/lib/server/users";

export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  const { ids } = await parseBody(req, z.object({ ids: z.array(z.string().max(64)).max(500) }));
  if (!ids.length) return json({ users: [] });
  const rows = await getDb().select().from(schema.user).where(inArray(schema.user.id, ids));
  return json({ users: await publicUsers(ctx.userId, rows) });
});
