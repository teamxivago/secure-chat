import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { getDb, getSql } from "./client";

const folder = fileURLToPath(new URL("../migrations", import.meta.url));
await migrate(getDb(), { migrationsFolder: folder });
await getSql()`CREATE EXTENSION IF NOT EXISTS pg_trgm`.catch(() => {});
await getSql()`CREATE INDEX IF NOT EXISTS user_username_trgm_gin ON "user" USING gin (lower(username) gin_trgm_ops)`.catch(() => {});
await getSql()`CREATE INDEX IF NOT EXISTS chat_title_trgm_gin ON chat USING gin (lower(title) gin_trgm_ops)`.catch(() => {});
await getSql()`CREATE SEQUENCE IF NOT EXISTS vault_version_seq`;
console.log("migrations applied");
await getSql().end();
