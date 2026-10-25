import { getDb, schema, eq } from "@veil/database";
import { USERNAME_RE } from "@veil/shared";
import { authenticate, json, limit, route } from "@/lib/server/http";

const RESERVED = new Set(["admin", "administrator", "support", "veil", "veilapp", "security", "official", "system", "settings", "telegram"]);

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  await limit(`uname:${ctx.userId}`, 120, 60);
  const u = (req.nextUrl.searchParams.get("u") ?? "").trim();
  if (!USERNAME_RE.test(u)) return json({ available: false, reason: "invalid" });
  const lower = u.toLowerCase();
  if (RESERVED.has(lower)) return json({ available: false, reason: "reserved" });
  const db = getDb();
  const [user] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.username, lower)).limit(1);
  if (user && user.id !== ctx.userId) return json({ available: false, reason: "taken" });
  const [chat] = await db.select({ id: schema.chat.id }).from(schema.chat).where(eq(schema.chat.username, lower)).limit(1);
  if (chat) return json({ available: false, reason: "taken" });
  return json({ available: true });
});
