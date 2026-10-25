import { and, eq, gt } from "drizzle-orm";
import { getDb } from "./client";
import { device, session, user } from "./schema";

export interface AuthedDevice {
  userId: string;
  sessionId: string;
  deviceId: string | null;
  deviceStatus: "pending" | "active" | null;
}

/**
 * Validates a better-auth session token (bearer token or the token part of the signed cookie)
 * and resolves the device bound to that session. Used by every mini-service.
 */
export async function verifySessionToken(rawToken: string | undefined | null): Promise<AuthedDevice | null> {
  if (!rawToken) return null;
  const token = decodeURIComponent(rawToken).split(".")[0];
  if (!token || token.length > 200) return null;
  const db = getDb();
  const rows = await db
    .select({ sessionId: session.id, userId: session.userId, deviceId: device.id, deviceStatus: device.status })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .leftJoin(device, eq(device.sessionId, session.id))
    .where(and(eq(session.token, token), gt(session.expiresAt, new Date())))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.userId,
    sessionId: r.sessionId,
    deviceId: r.deviceId ?? null,
    deviceStatus: (r.deviceStatus as AuthedDevice["deviceStatus"]) ?? null,
  };
}
