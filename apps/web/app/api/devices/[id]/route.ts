import { z } from "zod";
import { getDb, schema, and, eq } from "@veil/database";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { revokeDevice } from "@/lib/server/devices";

/** Terminates a session: deletes the device + its keys and forces it to wipe local data. */
export const DELETE = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  const target = id === "current" ? ctx.deviceId : id;
  if (!target) throw new HttpError(404, "device not found");
  // Only active devices may terminate other devices; any device may log itself out.
  if (target !== ctx.deviceId && ctx.deviceStatus !== "active") throw new HttpError(403, "device not active");
  if (!(await revokeDevice(ctx.userId, target))) throw new HttpError(404, "device not found");
  return json({ ok: true });
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const ctx = await authenticate(req);
  const { id } = await params;
  if (id !== "current" && id !== ctx.deviceId) throw new HttpError(403, "can only update the current device");
  if (!ctx.deviceId) throw new HttpError(404, "device not registered");
  const body = await parseBody(
    req,
    z.object({
      name: z.string().trim().min(1).max(64).optional(),
      pushToken: z.string().max(4096).nullable().optional(),
      pushPlatform: z.enum(["fcm", "apns", "web"]).nullable().optional(),
      voipToken: z.string().max(512).nullable().optional(),
    }),
  );
  await getDb()
    .update(schema.device)
    .set(body)
    .where(and(eq(schema.device.id, ctx.deviceId), eq(schema.device.userId, ctx.userId)));
  return json({ ok: true });
});
