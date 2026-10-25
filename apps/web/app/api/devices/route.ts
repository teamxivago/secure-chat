import { z } from "zod";
import { getDb, schema, and, eq, count, desc } from "@veil/database";
import { fromB64, verifySignedPreKey } from "@veil/crypto";
import type { DeviceInfo } from "@veil/shared";
import { authenticate, HttpError, json, limit, parseBody, route } from "@/lib/server/http";
import { newId } from "@/lib/server/chats";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const rows = await getDb()
    .select({ d: schema.device, s: schema.session })
    .from(schema.device)
    .leftJoin(schema.session, eq(schema.session.id, schema.device.sessionId))
    .where(eq(schema.device.userId, ctx.userId))
    .orderBy(desc(schema.device.lastSeenAt));
  const devices: DeviceInfo[] = rows.map(({ d, s }) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    status: d.status as DeviceInfo["status"],
    createdAt: d.createdAt.getTime(),
    lastSeenAt: d.lastSeenAt?.getTime() ?? null,
    current: d.id === ctx.deviceId,
    ip: s?.ipAddress ?? null,
  }));
  return json({ devices });
});

const b64 = (len: number) => z.string().max(200).refine((s) => {
  try {
    return fromB64(s).length === len;
  } catch {
    return false;
  }
}, "invalid key");

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: z.enum(["web", "ios", "android", "desktop"]),
  registrationId: z.number().int().min(1).max(0x3fff),
  identityKey: b64(32),
  signedPreKey: z.object({ keyId: z.number().int().min(0), publicKey: b64(32), signature: b64(64) }),
  oneTimePreKeys: z.array(z.object({ keyId: z.number().int().min(0), publicKey: b64(32) })).max(200),
});

/** Registers the device bound to the current session with its public key material. */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  await limit(`devreg:${ctx.userId}`, 20, 3600);
  const body = await parseBody(req, registerSchema);
  if (!verifySignedPreKey(fromB64(body.identityKey), fromB64(body.signedPreKey.publicKey), fromB64(body.signedPreKey.signature))) {
    throw new HttpError(400, "invalid signed pre-key signature");
  }
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // A session re-registering (e.g. local data was cleared) replaces its previous device.
    await tx.delete(schema.device).where(and(eq(schema.device.sessionId, ctx.sessionId), eq(schema.device.userId, ctx.userId)));
    const [{ active }] = await tx
      .select({ active: count() })
      .from(schema.device)
      .where(and(eq(schema.device.userId, ctx.userId), eq(schema.device.status, "active")));
    const [{ history }] = await tx.select({ history: count() }).from(schema.vaultRecord).where(eq(schema.vaultRecord.userId, ctx.userId));
    const [u] = await tx.select({ backup: schema.user.accountKeyBackup }).from(schema.user).where(eq(schema.user.id, ctx.userId));
    const brandNew = active === 0 && history === 0 && !u.backup;
    const id = newId("dev");
    await tx.insert(schema.device).values({
      id,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      name: body.name,
      platform: body.platform,
      status: brandNew ? "active" : "pending",
      registrationId: body.registrationId,
      lastSeenAt: new Date(),
    });
    await tx.insert(schema.identityKey).values({ deviceId: id, userId: ctx.userId, publicKey: body.identityKey });
    await tx.insert(schema.signedPreKey).values({ deviceId: id, ...body.signedPreKey });
    if (body.oneTimePreKeys.length) {
      await tx.insert(schema.oneTimePreKey).values(body.oneTimePreKeys.map((k) => ({ deviceId: id, ...k }))).onConflictDoNothing();
    }
    return { deviceId: id, status: brandNew ? "active" : "pending", activeDevices: active, hasBackup: !!u.backup, hasHistory: history > 0 };
  });
  return json(result, 201);
});
