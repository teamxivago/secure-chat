import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getDb, schema, eq, verifySessionToken } from "@veil/database";
import { LINK_PREVIEW_TTL_S, type LinkPreview } from "@veil/shared";
import { buildPreview } from "./preview";
import { safeFetch } from "./net";

/**
 * link-scraper: Open Graph previews (cached 7 days), an image proxy (so recipients never contact
 * third-party servers directly), GIF search and map tiles. It sees only the URL being previewed —
 * never the message or the conversation it belongs to.
 */

const PORT = Number(process.env.PORT ?? 4003);
const SECRET = process.env.LINK_PROXY_SECRET ?? "dev-link-secret";
const PUBLIC_BASE = process.env.LINK_PUBLIC_URL ?? "/svc/link";
const TILE_URL = process.env.MAP_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,capacitor://localhost,https://localhost,http://localhost").split(",");

const memo = new Map<string, { at: number; data: LinkPreview }>();

const sign = (u: string) => createHmac("sha256", SECRET).update(u).digest("base64url").slice(0, 32);
export const proxied = (u: string | undefined) => (u ? `${PUBLIC_BASE}/image?u=${encodeURIComponent(u)}&s=${sign(u)}` : undefined);

function cors(req: IncomingMessage): Record<string, string> {
  const o = req.headers.origin;
  return o && ORIGINS.includes(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
}

function json(req: IncomingMessage, res: ServerResponse, status: number, data: unknown, cache = "no-store") {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": cache, ...cors(req) }).end(JSON.stringify(data));
}

async function authed(req: IncomingMessage) {
  const h = req.headers.authorization;
  const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7) : req.headers.cookie?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1];
  return verifySessionToken(token);
}

const buckets = new Map<string, { n: number; reset: number }>();
function allow(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    if (buckets.size > 100_000) buckets.clear();
    return true;
  }
  return ++b.n <= max;
}

async function preview(url: string): Promise<LinkPreview> {
  const hash = createHash("sha256").update(url).digest("base64url");
  const hit = memo.get(hash);
  if (hit && Date.now() - hit.at < 600_000) return hit.data;
  const db = getDb();
  const [cached] = await db.select().from(schema.linkPreview).where(eq(schema.linkPreview.urlHash, hash));
  if (cached && cached.expiresAt > new Date()) {
    const data = cached.data as LinkPreview;
    memo.set(hash, { at: Date.now(), data });
    return data;
  }
  const raw = await buildPreview(url);
  const data: LinkPreview = { ...raw, image: proxied(raw.image), favicon: proxied(raw.favicon) };
  await db
    .insert(schema.linkPreview)
    .values({ urlHash: hash, url, data, expiresAt: new Date(Date.now() + LINK_PREVIEW_TTL_S * 1000) })
    .onConflictDoUpdate({ target: schema.linkPreview.urlHash, set: { data, fetchedAt: new Date(), expiresAt: new Date(Date.now() + LINK_PREVIEW_TTL_S * 1000) } });
  memo.set(hash, { at: Date.now(), data });
  if (memo.size > 5000) memo.clear();
  return data;
}

async function gifs(q: string | null, offset: number) {
  const giphy = process.env.GIPHY_API_KEY;
  const tenor = process.env.TENOR_API_KEY;
  if (giphy) {
    const ep = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${giphy}&q=${encodeURIComponent(q)}&limit=30&offset=${offset}&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${giphy}&limit=30&offset=${offset}&rating=pg-13`;
    const r = await safeFetch(ep, { maxBytes: 3_000_000, accept: "application/json" });
    const data = JSON.parse(r.body.toString("utf8")) as { data: { id: string; title: string; images: Record<string, { url?: string; mp4?: string; width: string; height: string }> }[] };
    return data.data.map((g) => ({
      id: g.id,
      title: g.title,
      url: proxied(g.images.original.mp4 ?? g.images.original.url)!,
      previewUrl: proxied(g.images.fixed_width_downsampled?.url ?? g.images.fixed_width.url)!,
      width: Number(g.images.original.width),
      height: Number(g.images.original.height),
      mp4: !!g.images.original.mp4,
    }));
  }
  if (tenor) {
    const ep = q
      ? `https://tenor.googleapis.com/v2/search?key=${tenor}&q=${encodeURIComponent(q)}&limit=30&pos=${offset}&media_filter=mp4,tinygif&contentfilter=medium`
      : `https://tenor.googleapis.com/v2/featured?key=${tenor}&limit=30&pos=${offset}&media_filter=mp4,tinygif&contentfilter=medium`;
    const r = await safeFetch(ep, { maxBytes: 3_000_000, accept: "application/json" });
    const data = JSON.parse(r.body.toString("utf8")) as { results: { id: string; content_description: string; media_formats: Record<string, { url: string; dims: number[] }> }[] };
    return data.results.map((g) => ({
      id: g.id,
      title: g.content_description,
      url: proxied(g.media_formats.mp4.url)!,
      previewUrl: proxied(g.media_formats.tinygif.url)!,
      width: g.media_formats.mp4.dims[0],
      height: g.media_formats.mp4.dims[1],
      mp4: true,
    }));
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const ip = (req.headers["cf-connecting-ip"] as string) ?? req.socket.remoteAddress ?? "";
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors(req), "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "authorization", "Access-Control-Max-Age": "600" }).end();
      return;
    }
    if (url.pathname === "/health") return json(req, res, 200, { ok: true });

    if (url.pathname === "/preview") {
      const a = await authed(req);
      if (!a) return json(req, res, 401, { error: "unauthorized" });
      if (!allow(`p:${a.userId}`, 60, 60_000)) return json(req, res, 429, { error: "too many requests" });
      const target = url.searchParams.get("url") ?? "";
      if (!/^https?:\/\//i.test(target) || target.length > 2000) return json(req, res, 400, { error: "invalid url" });
      try {
        return json(req, res, 200, await preview(target), "private, max-age=3600");
      } catch (e) {
        return json(req, res, 422, { error: "preview unavailable", reason: (e as Error).message });
      }
    }

    if (url.pathname === "/image") {
      const u = url.searchParams.get("u") ?? "";
      const s = url.searchParams.get("s") ?? "";
      const expected = sign(u);
      if (s.length !== expected.length || !timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return json(req, res, 403, { error: "bad signature" });
      if (!allow(`i:${ip}`, 600, 60_000)) return json(req, res, 429, { error: "too many requests" });
      const r = await safeFetch(u, { maxBytes: 15_000_000, accept: "image/*,video/mp4" });
      if (r.status !== 200 || !/^(image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)|video\/mp4)/.test(r.contentType)) {
        return json(req, res, 415, { error: "unsupported media" });
      }
      const type = r.contentType.split(";")[0];
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": r.body.length,
        "Cache-Control": "public, max-age=604800, immutable",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.end(r.body);
      return;
    }

    if (url.pathname === "/gifs") {
      const a = await authed(req);
      if (!a) return json(req, res, 401, { error: "unauthorized" });
      if (!allow(`g:${a.userId}`, 120, 60_000)) return json(req, res, 429, { error: "too many requests" });
      const results = await gifs(url.searchParams.get("q"), Number(url.searchParams.get("offset") ?? 0) || 0);
      if (!results) return json(req, res, 503, { error: "GIF search not configured (set GIPHY_API_KEY or TENOR_API_KEY)" });
      return json(req, res, 200, { results }, "private, max-age=300");
    }

    const tile = url.pathname.match(/^\/tile\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number);
      if (z > 19 || x >= 2 ** z || y >= 2 ** z) return json(req, res, 400, { error: "bad tile" });
      if (!allow(`t:${ip}`, 300, 60_000)) return json(req, res, 429, { error: "too many requests" });
      const r = await safeFetch(TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)), {
        maxBytes: 2_000_000,
        accept: "image/png",
        userAgent: process.env.MAP_TILE_USER_AGENT ?? "VeilMessenger/1.0 (+https://veil.app)",
      });
      if (r.status !== 200) return json(req, res, 502, { error: "tile unavailable" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" });
      res.end(r.body);
      return;
    }

    json(req, res, 404, { error: "not found" });
  } catch (e) {
    console.error("[link]", url.pathname, (e as Error).message);
    json(req, res, 502, { error: "upstream error" });
  }
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

server.listen(PORT, () => console.log(`[link-scraper] listening on :${PORT}`));
