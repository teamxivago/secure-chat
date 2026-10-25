import "server-only";
import { getDb, schema, and, eq, ne } from "@veil/database";
import { emitter, rooms } from "./redis";

export async function revokeDevice(userId: string, deviceId: string) {
  const db = getDb();
  const [d] = await db
    .delete(schema.device)
    .where(and(eq(schema.device.id, deviceId), eq(schema.device.userId, userId)))
    .returning();
  if (!d) return false;
  if (d.sessionId) await db.delete(schema.session).where(eq(schema.session.id, d.sessionId));
  // Tell the device to wipe its local keys and data, then drop its sockets.
  emitter().to(rooms.device(deviceId)).emit("device:revoked", { deviceId });
  emitter().in(rooms.device(deviceId)).disconnectSockets(true);
  emitter().to(rooms.user(userId)).emit("devices:changed", { userId });
  return true;
}

export async function revokeOtherDevices(userId: string, keepDeviceId: string) {
  const others = await getDb()
    .select({ id: schema.device.id })
    .from(schema.device)
    .where(and(eq(schema.device.userId, userId), ne(schema.device.id, keepDeviceId)));
  for (const o of others) await revokeDevice(userId, o.id);
}

export async function activateDevice(userId: string, deviceId: string) {
  await getDb().update(schema.device).set({ status: "active" }).where(eq(schema.device.id, deviceId));
  emitter().to(rooms.device(deviceId)).emit("device:activated", { deviceId });
  emitter().to(rooms.user(userId)).emit("devices:changed", { userId });
}
