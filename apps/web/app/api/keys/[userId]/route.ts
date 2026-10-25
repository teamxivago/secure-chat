import { getDb, getSql, schema, and, eq } from "@veil/database";
import type { PreKeyBundleWireT } from "@veil/shared";
import { authenticate, HttpError, json, limit, route } from "@/lib/server/http";
import { emitter, rooms } from "@/lib/server/redis";

const LOW_WATERMARK = 20;

/**
 * Returns a pre-key bundle for every ACTIVE device of the user (or one device with ?deviceId=).
 * Each call atomically consumes one one-time pre-key per device.
 */
export const GET = route<{ userId: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const { userId } = await params;
  await limit(`bundles:${ctx.userId}`, 600, 3600);
  const db = getDb();
  if (userId !== ctx.userId) {
    const [blocked] = await db
      .select()
      .from(schema.blockedUser)
      .where(and(eq(schema.blockedUser.userId, userId), eq(schema.blockedUser.blockedUserId, ctx.userId)));
    if (blocked) throw new HttpError(403, "unavailable");
  }
  const onlyDevice = req.nextUrl.searchParams.get("deviceId");
  const devices = await db
    .select({ d: schema.device, ik: schema.identityKey })
    .from(schema.device)
    .innerJoin(schema.identityKey, eq(schema.identityKey.deviceId, schema.device.id))
    .where(and(eq(schema.device.userId, userId), eq(schema.device.status, "active"), ...(onlyDevice ? [eq(schema.device.id, onlyDevice)] : [])));
  const sql = getSql();
  const bundles: PreKeyBundleWireT[] = [];
  for (const { d, ik } of devices) {
    if (userId === ctx.userId && d.id === ctx.deviceId) continue;
    const [spk] = await sql<{ key_id: number; public_key: string; signature: string }[]>`
      select key_id, public_key, signature from signed_pre_key where device_id = ${d.id} order by created_at desc limit 1`;
    if (!spk) continue;
    const [otpk] = await sql<{ key_id: number; public_key: string }[]>`
      delete from one_time_pre_key where id = (
        select id from one_time_pre_key where device_id = ${d.id} order by id limit 1 for update skip locked
      ) returning key_id, public_key`;
    const [{ remaining }] = await sql<{ remaining: number }[]>`select count(*)::int as remaining from one_time_pre_key where device_id = ${d.id}`;
    if (remaining < LOW_WATERMARK) emitter().to(rooms.device(d.id)).emit("keys:low", { remaining });
    bundles.push({
      registrationId: d.registrationId,
      deviceId: d.id,
      identityKey: ik.publicKey,
      signedPreKey: { keyId: spk.key_id, publicKey: spk.public_key, signature: spk.signature },
      oneTimePreKey: otpk ? { keyId: otpk.key_id, publicKey: otpk.public_key } : null,
    });
  }
  return json({ userId, bundles });
});
