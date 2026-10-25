import { z } from "zod";
import { getDb, schema, and, eq, gt } from "@veil/database";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { activateDevice } from "@/lib/server/devices";
import { emitter, rooms } from "@/lib/server/redis";

async function load(id: string, userId: string) {
  const [l] = await getDb()
    .select()
    .from(schema.deviceLink)
    .where(and(eq(schema.deviceLink.id, id), eq(schema.deviceLink.userId, userId), gt(schema.deviceLink.expiresAt, new Date())));
  if (!l) throw new HttpError(404, "link request not found or expired");
  return l;
}

/** The pending device polls for the encrypted provisioning payload. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const l = await load((await params).id, ctx.userId);
  if (l.deviceId !== ctx.deviceId) {
    // Active devices may read the public key (approval without camera).
    if (ctx.deviceStatus !== "active") throw new HttpError(403, "forbidden");
    return json({ status: l.status, publicKey: l.publicKey });
  }
  return json({ status: l.status, ephemeralKey: l.ephemeralKey, ciphertext: l.ciphertext });
});

/** An active device approves (uploading the payload encrypted to the new device's key) or rejects. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const l = await load((await params).id, ctx.userId);
  if (l.status !== "waiting") throw new HttpError(409, "already handled");
  const body = await parseBody(
    req,
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("approve"), ephemeralKey: z.string().max(100), ciphertext: z.string().max(20000) }),
      z.object({ action: z.literal("reject") }),
    ]),
  );
  const db = getDb();
  if (body.action === "reject") {
    await db.update(schema.deviceLink).set({ status: "rejected" }).where(eq(schema.deviceLink.id, l.id));
    emitter().to(rooms.device(l.deviceId)).emit("link:rejected", { linkId: l.id });
    return json({ ok: true });
  }
  await db
    .update(schema.deviceLink)
    .set({ status: "approved", ephemeralKey: body.ephemeralKey, ciphertext: body.ciphertext, approvedBy: ctx.deviceId })
    .where(eq(schema.deviceLink.id, l.id));
  await activateDevice(ctx.userId, l.deviceId);
  emitter().to(rooms.device(l.deviceId)).emit("link:approved", { linkId: l.id });
  return json({ ok: true });
});
