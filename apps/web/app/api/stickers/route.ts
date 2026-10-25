import { getDb, schema, eq, or, inArray, asc } from "@veil/database";
import { authenticate, json, route } from "@/lib/server/http";

/** Sticker packs are public assets (like Telegram sticker sets); which sticker is sent stays E2EE. */
export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const db = getDb();
  const mine = await db.select({ p: schema.userStickerPack.packId }).from(schema.userStickerPack).where(eq(schema.userStickerPack.userId, ctx.userId));
  const ids = mine.map((m) => m.p);
  const packs = await db
    .select()
    .from(schema.stickerPack)
    .where(ids.length ? or(eq(schema.stickerPack.isDefault, true), inArray(schema.stickerPack.id, ids)) : eq(schema.stickerPack.isDefault, true));
  const stickers = packs.length
    ? await db.select().from(schema.sticker).where(inArray(schema.sticker.packId, packs.map((p) => p.id))).orderBy(asc(schema.sticker.position))
    : [];
  const all = req.nextUrl.searchParams.get("catalog") === "1" ? await db.select().from(schema.stickerPack) : [];
  return json({
    packs: packs.map((p) => ({ ...p, installed: ids.includes(p.id) || p.isDefault, stickers: stickers.filter((s) => s.packId === p.id) })),
    catalog: all.map((p) => ({ id: p.id, name: p.name, title: p.title, installed: ids.includes(p.id) || p.isDefault })),
  });
});
