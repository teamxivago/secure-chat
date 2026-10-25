import { getDb, schema, eq } from "@veil/database";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { publicUser, publicUsers } from "@/lib/server/users";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  if (id.startsWith("@")) {
    const rows = await getDb().select().from(schema.user).where(eq(schema.user.username, id.slice(1).toLowerCase())).limit(1);
    if (!rows[0]) throw new HttpError(404, "user not found");
    return json((await publicUsers(ctx.userId, rows))[0]);
  }
  const u = await publicUser(ctx.userId, id);
  if (!u) throw new HttpError(404, "user not found");
  return json(u);
});
