import { z } from "zod";
import { getDb, schema, and, eq, gt } from "@veil/database";
import { fromB64, verificationCode } from "@veil/crypto";
import { authenticate, HttpError, json, limit, parseBody, route } from "@/lib/server/http";
import { newId } from "@/lib/server/chats";
import { emitter, rooms } from "@/lib/server/redis";

/** Pending device starts a link request (its QR code encodes linkId + publicKey). */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  if (!ctx.deviceId || ctx.deviceStatus !== "pending") throw new HttpError(400, "only pending devices can request linking");
  await limit(`link:${ctx.userId}`, 20, 3600);
  const { publicKey } = await parseBody(req, z.object({ publicKey: z.string().max(100) }));
  if (fromB64(publicKey).length !== 32) throw new HttpError(400, "invalid key");
  const db = getDb();
  await db.delete(schema.deviceLink).where(eq(schema.deviceLink.deviceId, ctx.deviceId));
  const id = newId("lnk");
  await db.insert(schema.deviceLink).values({
    id,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    publicKey,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  const [d] = await db.select().from(schema.device).where(eq(schema.device.id, ctx.deviceId));
  emitter().to(rooms.user(ctx.userId)).emit("link:request", { linkId: id, deviceName: d.name, platform: d.platform });
  return json({ linkId: id, code: verificationCode(fromB64(publicKey)), expiresAt: Date.now() + 600000 });
});

/** Active devices list pending link requests (for approval without scanning). */
export const GET = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const rows = await getDb()
    .select({ l: schema.deviceLink, d: schema.device })
    .from(schema.deviceLink)
    .innerJoin(schema.device, eq(schema.device.id, schema.deviceLink.deviceId))
    .where(and(eq(schema.deviceLink.userId, ctx.userId), eq(schema.deviceLink.status, "waiting"), gt(schema.deviceLink.expiresAt, new Date())));
  return json({
    requests: rows.map(({ l, d }) => ({
      linkId: l.id,
      publicKey: l.publicKey,
      deviceName: d.name,
      platform: d.platform,
      code: verificationCode(fromB64(l.publicKey)),
      createdAt: l.createdAt.getTime(),
    })),
  });
});
