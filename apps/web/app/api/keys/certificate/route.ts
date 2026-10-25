import { getDb, schema, eq } from "@veil/database";
import { fromB64, issueSenderCertificate, signingPublicKey } from "@veil/crypto";
import { SENDER_CERT_TTL_MS } from "@veil/shared";
import { authenticate, HttpError, json, route } from "@/lib/server/http";
import { env } from "@/lib/server/env";

/** Short-lived sender certificate for sealed-sender delivery. */
export const GET = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  if (!env.sealedSenderKey) throw new HttpError(503, "sealed sender not configured");
  const [ik] = await getDb().select().from(schema.identityKey).where(eq(schema.identityKey.deviceId, ctx.deviceId!));
  const seed = fromB64(env.sealedSenderKey);
  const cert = issueSenderCertificate(
    { privateKey: seed, publicKey: signingPublicKey(seed) },
    { userId: ctx.userId, deviceId: ctx.deviceId!, identityKey: ik.publicKey, expires: Date.now() + SENDER_CERT_TTL_MS },
  );
  return json({ certificate: cert });
});
