import { authenticate, json, limit, route } from "@/lib/server/http";
import { searchDirectory } from "@/lib/server/search";

/** Global directory search: users by username/name, public groups & channels. */
export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  await limit(`search:${ctx.userId}`, 60, 60);
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return json({ users: [], chats: [] });
  return json(await searchDirectory(ctx.userId, q));
});
