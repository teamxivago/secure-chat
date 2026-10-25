import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, json, route } from "@/lib/server/http";

export const POST = route<{ packId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  await getDb().insert(schema.userStickerPack).values({ userId: ctx.userId, packId: (await params).packId }).onConflictDoNothing();
  return json({ ok: true });
});

export const DELETE = route<{ packId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { packId } = await params;
  await getDb().delete(schema.userStickerPack).where(and(eq(schema.userStickerPack.userId, ctx.userId), eq(schema.userStickerPack.packId, packId)));
  return json({ ok: true });
});
