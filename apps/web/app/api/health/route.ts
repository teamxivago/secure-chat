import { getSql } from "@veil/database";
import { redis } from "@/lib/server/redis";

export async function GET() {
  const [db, r] = await Promise.allSettled([getSql()`select 1`, redis().ping()]);
  const ok = db.status === "fulfilled" && r.status === "fulfilled";
  return Response.json({ ok, db: db.status, redis: r.status }, { status: ok ? 200 : 503 });
}
