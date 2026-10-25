import { z } from "zod";
import { getDb, schema, eq } from "@veil/database";
import { authenticate, json, parseBody, route } from "@/lib/server/http";

export const GET = route(async (req) => {
  const ctx = await authenticate(req);
  const db = getDb();
  const [u] = await db.select({ s: schema.user.notificationSettings }).from(schema.user).where(eq(schema.user.id, ctx.userId));
  const prefs = await db.select().from(schema.notificationPreference).where(eq(schema.notificationPreference.userId, ctx.userId));
  return json({
    global: u?.s ?? {},
    scopes: prefs.map((p) => ({ scope: p.scope, mode: p.mode, mutedUntil: p.mutedUntil?.getTime() ?? null, sound: p.sound, vibrate: p.vibrate })),
  });
});

const schemaPut = z.object({
  global: z
    .object({
      dnd: z.boolean().optional(),
      quietHours: z.object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/), tz: z.string().max(64) }).nullable().optional(),
      previews: z.boolean().optional(),
      sound: z.string().max(32).optional(),
      groupSound: z.string().max(32).optional(),
      channelSound: z.string().max(32).optional(),
      vibrate: z.boolean().optional(),
    })
    .optional(),
  scope: z
    .object({
      scope: z.string().max(64),
      mode: z.enum(["all", "mentions", "none"]),
      mutedUntil: z.number().nullable().optional(),
      sound: z.string().max(32).nullable().optional(),
      vibrate: z.boolean().optional(),
    })
    .optional(),
});

export const PUT = route(async (req) => {
  const ctx = await authenticate(req);
  const body = await parseBody(req, schemaPut);
  const db = getDb();
  if (body.global) {
    const [u] = await db.select({ s: schema.user.notificationSettings }).from(schema.user).where(eq(schema.user.id, ctx.userId));
    await db
      .update(schema.user)
      .set({ notificationSettings: { ...(u?.s ?? {}), ...body.global } })
      .where(eq(schema.user.id, ctx.userId));
  }
  if (body.scope) {
    const s = body.scope;
    const values = {
      userId: ctx.userId,
      scope: s.scope,
      mode: s.mode,
      mutedUntil: s.mutedUntil ? new Date(s.mutedUntil) : null,
      sound: s.sound ?? null,
      vibrate: s.vibrate ?? true,
    };
    await db
      .insert(schema.notificationPreference)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.notificationPreference.userId, schema.notificationPreference.scope],
        set: { mode: values.mode, mutedUntil: values.mutedUntil, sound: values.sound, vibrate: values.vibrate },
      });
  }
  return json({ ok: true });
});
