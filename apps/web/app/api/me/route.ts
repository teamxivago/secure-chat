import { z } from "zod";
import { getDb, schema, and, eq, ne } from "@veil/database";
import { profileUpdateSchema, privacySchema, USERNAME_COOLDOWN_MS } from "@veil/shared";
import { authenticate, HttpError, json, parseBody, route } from "@/lib/server/http";
import { meUser } from "@/lib/server/users";
import { emitter, rooms } from "@/lib/server/redis";
import { indexUser } from "@/lib/server/search";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  return json(await meUser(ctx.userId));
});

const patchSchema = profileUpdateSchema.extend({
  privacy: privacySchema.optional(),
  onboarded: z.literal(true).optional(),
});

export const PATCH = route(async (req) => {
  const ctx = await authenticate(req);
  const body = await parseBody(req, patchSchema);
  const db = getDb();
  const [current] = await db.select().from(schema.user).where(eq(schema.user.id, ctx.userId));
  const set: Partial<typeof schema.user.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.lastName !== undefined) set.lastName = body.lastName || null;
  if (body.bio !== undefined) set.bio = body.bio || null;
  if (body.emojiStatus !== undefined) set.emojiStatus = body.emojiStatus;
  if (body.avatarMediaId !== undefined) {
    set.avatarMediaId = body.avatarMediaId;
    set.avatarKey = body.avatarKey ?? null;
  }
  if (body.onboarded) set.onboarded = true;
  if (body.username !== undefined) {
    const lower = body.username.toLowerCase();
    if (lower !== current.username) {
      if (current.username && current.usernameChangedAt && Date.now() - current.usernameChangedAt.getTime() < USERNAME_COOLDOWN_MS) {
        const next = new Date(current.usernameChangedAt.getTime() + USERNAME_COOLDOWN_MS);
        throw new HttpError(429, "username can be changed once every 30 days", { availableAt: next.getTime() });
      }
      const taken = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(and(eq(schema.user.username, lower), ne(schema.user.id, ctx.userId)));
      const takenByChat = await db.select({ id: schema.chat.id }).from(schema.chat).where(eq(schema.chat.username, lower));
      if (taken.length || takenByChat.length) throw new HttpError(409, "username is taken");
      set.username = lower;
      set.displayUsername = body.username;
      if (current.username) set.usernameChangedAt = new Date();
    } else if (body.username !== current.displayUsername) {
      set.displayUsername = body.username;
    }
  }
  if (body.privacy) {
    const p = body.privacy;
    if (p.phoneVisibility) set.phoneVisibility = p.phoneVisibility;
    if (p.lastSeenVisibility) set.lastSeenVisibility = p.lastSeenVisibility;
    if (p.profilePhotoVisibility) set.profilePhotoVisibility = p.profilePhotoVisibility;
    if (p.phoneDiscoverable !== undefined) set.phoneDiscoverable = p.phoneDiscoverable;
  }
  try {
    await db.update(schema.user).set(set).where(eq(schema.user.id, ctx.userId));
  } catch (e) {
    if (String(e).includes("unique")) throw new HttpError(409, "username is taken");
    throw e;
  }
  const me = await meUser(ctx.userId);
  await indexUser(me);
  emitter().to(rooms.user(ctx.userId)).emit("me:updated", {});
  emitter().to(`presence:${ctx.userId}`).emit("profile:updated", { userId: ctx.userId });
  return json(me);
});
