import { z } from "zod";
import { getDb, schema, and, eq, count } from "@veil/database";
import { fromB64, verifySignedPreKey } from "@veil/crypto";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  if (!ctx.deviceId) throw new HttpError(404, "device not registered");
  const [{ n }] = await getDb().select({ n: count() }).from(schema.oneTimePreKey).where(eq(schema.oneTimePreKey.deviceId, ctx.deviceId));
  const spk = await getDb().select().from(schema.signedPreKey).where(eq(schema.signedPreKey.deviceId, ctx.deviceId));
  const latest = spk.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return json({ oneTimePreKeys: n, signedPreKeyId: latest?.keyId ?? null, signedPreKeyCreatedAt: latest?.createdAt.getTime() ?? null });
});

/** Replenish one-time pre-keys and/or rotate the signed pre-key. */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  if (!ctx.deviceId) throw new HttpError(404, "device not registered");
  const body = await parseBody(
    req,
    z.object({
      signedPreKey: z.object({ keyId: z.number().int().min(0), publicKey: z.string().max(100), signature: z.string().max(200) }).optional(),
      oneTimePreKeys: z.array(z.object({ keyId: z.number().int().min(0), publicKey: z.string().max(100) })).max(200).optional(),
    }),
  );
  const db = getDb();
  if (body.signedPreKey) {
    const [ik] = await db.select().from(schema.identityKey).where(eq(schema.identityKey.deviceId, ctx.deviceId));
    const s = body.signedPreKey;
    if (!verifySignedPreKey(fromB64(ik.publicKey), fromB64(s.publicKey), fromB64(s.signature))) throw new HttpError(400, "invalid signature");
    await db.insert(schema.signedPreKey).values({ deviceId: ctx.deviceId, ...s }).onConflictDoNothing();
    // Keep the two most recent signed pre-keys so in-flight X3DH initiations still succeed.
    const all = await db.select().from(schema.signedPreKey).where(eq(schema.signedPreKey.deviceId, ctx.deviceId));
    const old = all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(2);
    for (const o of old) {
      await db
        .delete(schema.signedPreKey)
        .where(and(eq(schema.signedPreKey.deviceId, ctx.deviceId), eq(schema.signedPreKey.keyId, o.keyId)));
    }
  }
  if (body.oneTimePreKeys?.length) {
    await db.insert(schema.oneTimePreKey).values(body.oneTimePreKeys.map((k) => ({ deviceId: ctx.deviceId!, ...k }))).onConflictDoNothing();
  }
  return json({ ok: true });
});
