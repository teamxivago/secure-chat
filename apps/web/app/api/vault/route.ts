import { z } from "zod";
import { getDb, getSql, schema, and, eq, gt, asc } from "@veil/database";
import { authenticate, json, limit, parseBody, route } from "@/lib/server/http";
import { emitter, rooms } from "@/lib/server/redis";

/**
 * Multi-device encrypted vault. Records are sealed with the Account Storage Key that only the
 * user's linked devices hold. Sync is cursor-based on a monotonic version.
 */
export const GET = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  const since = Number(req.nextUrl.searchParams.get("since") ?? 0) || 0;
  const lim = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 500) || 500, 1000);
  const kind = req.nextUrl.searchParams.get("kind");
  const rows = await getDb()
    .select()
    .from(schema.vaultRecord)
    .where(and(eq(schema.vaultRecord.userId, ctx.userId), gt(schema.vaultRecord.version, since), ...(kind ? [eq(schema.vaultRecord.kind, kind)] : [])))
    .orderBy(asc(schema.vaultRecord.version))
    .limit(lim);
  return json({
    records: rows.map((r) => ({ recordId: r.recordId, kind: r.kind, data: r.data, deleted: r.deleted, version: r.version })),
    cursor: rows.length ? rows[rows.length - 1].version : since,
    more: rows.length === lim,
  });
});

const putSchema = z.object({
  records: z
    .array(
      z.object({
        recordId: z.string().min(10).max(64),
        kind: z.string().max(16),
        data: z.string().max(2_000_000).nullable(),
        onlyIfAbsent: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const POST = route(async (req) => {
  const ctx = await authenticate(req, { requireActiveDevice: true });
  await limit(`vault:${ctx.userId}`, 3000, 60);
  const { records } = await parseBody(req, putSchema);
  const sql = getSql();
  let changed = 0;
  for (const r of records) {
    const deleted = r.data === null;
    const res = r.onlyIfAbsent
      ? await sql`insert into vault_record (user_id, record_id, kind, data, deleted, version, updated_at)
          values (${ctx.userId}, ${r.recordId}, ${r.kind}, ${r.data}, ${deleted}, nextval('vault_version_seq'), now())
          on conflict (user_id, record_id) do nothing`
      : await sql`insert into vault_record (user_id, record_id, kind, data, deleted, version, updated_at)
          values (${ctx.userId}, ${r.recordId}, ${r.kind}, ${r.data}, ${deleted}, nextval('vault_version_seq'), now())
          on conflict (user_id, record_id) do update set data = excluded.data, deleted = excluded.deleted,
            kind = excluded.kind, version = excluded.version, updated_at = now()
          where vault_record.data is distinct from excluded.data or vault_record.deleted <> excluded.deleted`;
    changed += res.count;
  }
  if (changed) emitter().to(rooms.user(ctx.userId)).except(rooms.device(ctx.deviceId!)).emit("vault:changed", {});
  return json({ ok: true, changed });
});
