import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __veilDb: ReturnType<typeof createDb> | undefined;
}

function createDb(url: string) {
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10), prepare: true, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}

/** Lazily created singleton (survives Next.js dev hot reloads). */
export function getDb() {
  if (!globalThis.__veilDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalThis.__veilDb = createDb(url);
  }
  return globalThis.__veilDb.db;
}

export function getSql() {
  getDb();
  return globalThis.__veilDb!.client;
}

export type Db = ReturnType<typeof getDb>;
