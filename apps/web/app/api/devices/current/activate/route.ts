import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb, schema, eq } from "@veil/database";
import { authenticate, HttpError, json, limit, parseBody, route } from "@/lib/server/http";
import { activateDevice, revokeOtherDevices } from "@/lib/server/devices";

/**
 * Activates a pending device without another device's approval:
 *  - recovery: the device proves knowledge of the Account Storage Key (restored with the
 *    user's recovery key) by revealing the verifier preimage.
 *  - fresh: re-registers the account's encryption (like Signal re-registration). All other
 *    devices are logged out and the encrypted history vault is discarded, since it can no
 *    longer be decrypted. Contacts will see a safety-number change.
 */
export const POST = route(async (req) => {
  const ctx = await authenticate(req);
  if (!ctx.deviceId) throw new HttpError(400, "device not registered");
  await limit(`activate:${ctx.userId}`, 10, 3600);
  const body = await parseBody(req, z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("recovery"), verifier: z.string().max(200) }),
    z.object({ mode: z.literal("fresh") }),
  ]));
  const db = getDb();
  if (body.mode === "recovery") {
    const [u] = await db.select({ v: schema.user.accountKeyVerifier }).from(schema.user).where(eq(schema.user.id, ctx.userId));
    const digest = createHash("sha256").update(body.verifier).digest("base64");
    if (!u?.v || u.v !== digest) throw new HttpError(403, "recovery key does not match");
    await activateDevice(ctx.userId, ctx.deviceId);
    return json({ ok: true });
  }
  await revokeOtherDevices(ctx.userId, ctx.deviceId);
  await db.delete(schema.vaultRecord).where(eq(schema.vaultRecord.userId, ctx.userId));
  await db.update(schema.user).set({ accountKeyBackup: null, accountKeyVerifier: null }).where(eq(schema.user.id, ctx.userId));
  await activateDevice(ctx.userId, ctx.deviceId);
  return json({ ok: true });
});
