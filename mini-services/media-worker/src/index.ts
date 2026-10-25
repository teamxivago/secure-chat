import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { getDb, schema, and, eq, lt, isNotNull, verifySessionToken, inArray } from "@veil/database";
import { MAX_FILE_SIZE } from "@veil/shared";
import { LocalDriver, R2Driver, type StorageDriver } from "./storage";

/**
 * media-worker: issues signed upload/download URLs for client-side-encrypted blobs, finalizes
 * multipart uploads, and permanently deletes once-view / expired media.
 *
 * Part size equals the client's encrypted chunk size (8 MiB plaintext + 64 bytes of IV/padding/MAC),
 * so every part but the last is identical in size (an R2 requirement).
 */

const PORT = Number(process.env.PORT ?? 4002);
const PART_SIZE = 8 * 1024 * 1024 + 64;
const MAX_ENCRYPTED = MAX_FILE_SIZE + Math.ceil(MAX_FILE_SIZE / (8 * 1024 * 1024)) * 64 + 64;
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,capacitor://localhost,https://localhost,http://localhost").split(",");

const driver: StorageDriver & { handle?: LocalDriver["handle"]; sweepOrphans?: LocalDriver["sweepOrphans"] } =
  process.env.STORAGE_DRIVER === "r2"
    ? new R2Driver(process.env.R2_BUCKET ?? "veil-media")
    : new LocalDriver(
        process.env.LOCAL_STORAGE_DIR ?? `${process.cwd()}/.data/media`,
        process.env.MEDIA_PUBLIC_URL ?? `http://localhost:${PORT}`,
        process.env.MEDIA_URL_SECRET ?? "dev-media-secret",
      );

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function cors(req: IncomingMessage): Record<string, string> {
  const o = req.headers.origin;
  return o && ORIGINS.includes(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
    : {};
}

function send(req: IncomingMessage, res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) }).end(JSON.stringify(data));
}

async function body<T>(req: IncomingMessage, schemaDef: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const r = schemaDef.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
  if (!r.success) throw new HttpError(400, "invalid body");
  return r.data;
}

async function auth(req: IncomingMessage) {
  const h = req.headers.authorization;
  let token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7) : null;
  if (!token) token = req.headers.cookie?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1] ?? null;
  const a = await verifySessionToken(token);
  if (!a || a.deviceStatus !== "active") throw new HttpError(401, "unauthorized");
  return a;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64");

async function rateLimit(key: string, max: number, windowSec: number) {
  // Lightweight in-process limiter; the authoritative limits live in chat-ws/web (Redis).
  const now = Math.floor(Date.now() / 1000 / windowSec);
  const k = `${key}:${now}`;
  const n = (counters.get(k) ?? 0) + 1;
  counters.set(k, n);
  if (counters.size > 50000) counters.clear();
  if (n > max) throw new HttpError(429, "too many requests");
}
const counters = new Map<string, number>();

const createSchema = z.object({
  size: z.number().int().positive().max(MAX_ENCRYPTED),
  /** once-view / disappearing: server-enforced hard delete deadline (seconds from now) */
  ttl: z.number().int().positive().max(31 * 86400).optional(),
  /** sha256(deleteToken) — the token itself is shared only inside the E2EE message */
  deleteTokenHash: z.string().max(100).optional(),
  public: z.boolean().optional(),
});

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const db = getDb();

  if (req.method === "OPTIONS") {
    res
      .writeHead(204, { ...cors(req), "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "authorization,content-type,x-delete-token", "Access-Control-Max-Age": "600" })
      .end();
    return;
  }
  if (url.pathname === "/health") return send(req, res, 200, { ok: true });

  // POST /uploads → create media + signed upload URL(s)
  if (req.method === "POST" && parts[0] === "uploads" && parts.length === 1) {
    const a = await auth(req);
    await rateLimit(`up:${a.userId}`, 600, 3600);
    const b = await body(req, createSchema);
    const id = randomBytes(18).toString("base64url");
    const objectKey = `m/${id.slice(0, 2)}/${id}`;
    const multipart = b.size > PART_SIZE;
    const uploadId = multipart ? await driver.createMultipart(objectKey) : null;
    await db.insert(schema.media).values({
      id,
      ownerUserId: a.userId,
      objectKey,
      size: b.size,
      partSize: multipart ? PART_SIZE : null,
      uploadId,
      expiresAt: b.ttl ? new Date(Date.now() + b.ttl * 1000) : null,
      deleteTokenHash: b.deleteTokenHash ?? null,
      isPublic: !!b.public,
    });
    if (!multipart) return send(req, res, 201, { mediaId: id, url: await driver.putUrl(objectKey, b.size) });
    const count = Math.ceil(b.size / PART_SIZE);
    const urls: string[] = [];
    for (let i = 1; i <= count; i++) urls.push(await driver.partUrl(objectKey, uploadId!, i));
    return send(req, res, 201, { mediaId: id, partSize: PART_SIZE, partUrls: urls });
  }

  // POST /uploads/:id/complete
  if (req.method === "POST" && parts[0] === "uploads" && parts[2] === "complete") {
    const a = await auth(req);
    const b = await body(req, z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().max(200) })).max(10000).optional() }));
    const [m] = await db.select().from(schema.media).where(and(eq(schema.media.id, parts[1]), eq(schema.media.ownerUserId, a.userId)));
    if (!m) throw new HttpError(404, "not found");
    if (m.uploadId) {
      if (!b.parts?.length) throw new HttpError(400, "parts required");
      await driver.completeMultipart(m.objectKey, m.uploadId, b.parts);
    }
    const actual = await driver.size(m.objectKey);
    if (actual === null || actual !== m.size) {
      await driver.delete(m.objectKey);
      await db.delete(schema.media).where(eq(schema.media.id, m.id));
      throw new HttpError(400, "uploaded size mismatch");
    }
    await db.update(schema.media).set({ status: "complete", completedAt: new Date(), uploadId: null }).where(eq(schema.media.id, m.id));
    return send(req, res, 200, { ok: true });
  }

  // GET /media/:id → signed download URL (ciphertext only)
  if (req.method === "GET" && parts[0] === "media" && parts.length === 2) {
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, parts[1]));
    if (!m || m.status !== "complete" || (m.expiresAt && m.expiresAt < new Date())) throw new HttpError(404, "media not found or expired");
    if (!m.isPublic) await auth(req);
    return send(req, res, 200, { url: await driver.getUrl(m.objectKey, m.expiresAt ? 300 : 3600), size: m.size });
  }

  // DELETE /media/:id — owner, or anyone holding the delete token (once-view recipients)
  if (req.method === "DELETE" && parts[0] === "media" && parts.length === 2) {
    const [m] = await db.select().from(schema.media).where(eq(schema.media.id, parts[1]));
    if (!m) return send(req, res, 200, { ok: true });
    const token = req.headers["x-delete-token"];
    const byToken = typeof token === "string" && m.deleteTokenHash && sha256(token) === m.deleteTokenHash;
    if (!byToken) {
      const a = await auth(req);
      if (a.userId !== m.ownerUserId) throw new HttpError(403, "forbidden");
    }
    await purge([m]);
    return send(req, res, 200, { ok: true });
  }

  throw new HttpError(404, "not found");
}

async function purge(rows: (typeof schema.media.$inferSelect)[]) {
  if (!rows.length) return;
  for (const m of rows) {
    if (m.uploadId) await driver.abortMultipart(m.objectKey, m.uploadId);
    await driver.delete(m.objectKey);
  }
  await getDb().delete(schema.media).where(inArray(schema.media.id, rows.map((r) => r.id)));
}

/** Hard-deletes expired once-view media and abandoned uploads. */
async function sweep() {
  const db = getDb();
  const expired = await db.select().from(schema.media).where(and(isNotNull(schema.media.expiresAt), lt(schema.media.expiresAt, new Date()))).limit(500);
  const abandoned = await db
    .select()
    .from(schema.media)
    .where(and(eq(schema.media.status, "pending"), lt(schema.media.createdAt, new Date(Date.now() - 24 * 3600 * 1000))))
    .limit(500);
  await purge([...expired, ...abandoned]);
  if (expired.length || abandoned.length) console.log(`[media] swept ${expired.length} expired, ${abandoned.length} abandoned`);
  await driver.sweepOrphans?.(48 * 3600 * 1000);
}

const server = createServer(async (req, res) => {
  try {
    if (driver.handle && (await driver.handle.call(driver, req, res, PART_SIZE + 1024))) return;
    await route(req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(req, res, e.status, { error: e.message });
    console.error("[media]", e);
    send(req, res, 500, { error: "internal error" });
  }
});
server.requestTimeout = 0;
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

server.listen(PORT, () => console.log(`[media-worker] listening on :${PORT} (${process.env.STORAGE_DRIVER === "r2" ? "R2" : "local"} storage)`));
setInterval(() => sweep().catch((e) => console.error("[media] sweep", e)), 15_000).unref();
