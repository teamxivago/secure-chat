import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Storage holds ciphertext only. Clients upload/download directly with short-lived signed URLs. */
export interface StorageDriver {
  putUrl(key: string, size: number): Promise<string>;
  createMultipart(key: string): Promise<string>;
  partUrl(key: string, uploadId: string, part: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  getUrl(key: string, ttlSec: number): Promise<string>;
  delete(key: string): Promise<void>;
  size(key: string): Promise<number | null>;
}

const URL_TTL = 3600;

export class R2Driver implements StorageDriver {
  private s3: S3Client;
  constructor(private bucket: string) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "" },
      forcePathStyle: !!process.env.R2_FORCE_PATH_STYLE,
    });
  }
  putUrl(key: string, size: number) {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentLength: size, ContentType: "application/octet-stream" }), { expiresIn: URL_TTL });
  }
  async createMultipart(key: string) {
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: "application/octet-stream" }));
    return r.UploadId!;
  }
  partUrl(key: string, uploadId: string, part: number) {
    return getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: part }), { expiresIn: URL_TTL * 6 });
  }
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }
  async abortMultipart(key: string, uploadId: string) {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => {});
  }
  getUrl(key: string, ttlSec: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }
  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async size(key: string) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.ContentLength ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Local filesystem driver for development and self-hosting. Mirrors the R2 flow with
 * HMAC-signed URLs served by this worker (PUT for upload/parts, GET with Range support).
 */
export class LocalDriver implements StorageDriver {
  constructor(
    private root: string,
    private publicBase: string,
    private secret: string,
  ) {}
  private path(key: string) {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) throw new Error("bad key");
    return join(this.root, key);
  }
  private sign(method: string, key: string, exp: number, extra = "") {
    return createHmac("sha256", this.secret).update(`${method}\n${key}\n${exp}\n${extra}`).digest("base64url");
  }
  private url(method: string, key: string, ttl: number, extra = "") {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const q = new URLSearchParams({ exp: String(exp), sig: this.sign(method, key, exp, extra) });
    if (extra) q.set("x", extra);
    return `${this.publicBase}/blob/${key}?${q}`;
  }
  async putUrl(key: string) {
    return this.url("PUT", key, URL_TTL);
  }
  async createMultipart(key: string) {
    const id = `mp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(this.path(`${key}.parts/${id}`), { recursive: true });
    return id;
  }
  async partUrl(key: string, uploadId: string, part: number) {
    return this.url("PUT", key, URL_TTL * 6, `${uploadId}:${part}`);
  }
  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    const dir = this.path(`${key}.parts/${uploadId}`);
    const out = this.path(key);
    await mkdir(out.replace(/\/[^/]+$/, ""), { recursive: true });
    const ws = createWriteStream(out);
    for (const p of parts.sort((a, b) => a.partNumber - b.partNumber)) {
      await pipeline(createReadStream(join(dir, String(p.partNumber))), ws, { end: false });
    }
    await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())));
    await rm(this.path(`${key}.parts`), { recursive: true, force: true });
  }
  async abortMultipart(key: string) {
    await rm(this.path(`${key}.parts`), { recursive: true, force: true });
  }
  async getUrl(key: string, ttl: number) {
    return this.url("GET", key, ttl);
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch(() => {});
    await rm(this.path(`${key}.parts`), { recursive: true, force: true });
  }
  async size(key: string) {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }

  private verify(method: string, key: string, q: URLSearchParams) {
    const exp = Number(q.get("exp"));
    const sig = q.get("sig") ?? "";
    if (!exp || exp < Date.now() / 1000) return false;
    const expected = this.sign(method, key, exp, q.get("x") ?? "");
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  /** Handles /blob/* requests. Returns false if the request isn't for this driver. */
  async handle(req: IncomingMessage, res: ServerResponse, maxPart: number): Promise<boolean> {
    const u = new URL(req.url ?? "/", "http://x");
    if (!u.pathname.startsWith("/blob/")) return false;
    const key = decodeURIComponent(u.pathname.slice(6));
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET,PUT", "Access-Control-Allow-Headers": "content-type,range", "Access-Control-Max-Age": "600" }).end();
      return true;
    }
    if (!this.verify(req.method ?? "", key, u.searchParams)) {
      res.writeHead(403, cors).end("forbidden");
      return true;
    }
    if (req.method === "PUT") {
      const extra = u.searchParams.get("x");
      let target = this.path(key);
      if (extra) {
        const [uploadId, part] = extra.split(":");
        target = join(this.path(`${key}.parts/${uploadId}`), String(Number(part)));
      }
      await mkdir(target.replace(/\/[^/]+$/, ""), { recursive: true });
      let written = 0;
      req.on("data", (c: Buffer) => {
        written += c.length;
        if (written > maxPart) req.destroy(new Error("too large"));
      });
      try {
        await pipeline(req, createWriteStream(target));
      } catch {
        res.writeHead(413, cors).end();
        return true;
      }
      res.writeHead(200, { ...cors, ETag: `"${written}-${Date.now()}"` }).end();
      return true;
    }
    if (req.method === "GET") {
      const file = this.path(key);
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        res.writeHead(404, cors).end();
        return true;
      }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { ...cors, "Content-Range": `bytes */${size}` }).end();
          return true;
        }
        res.writeHead(206, { ...cors, "Content-Type": "application/octet-stream", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" });
        await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
      } else {
        res.writeHead(200, { ...cors, "Content-Type": "application/octet-stream", "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
        await pipeline(createReadStream(file), res).catch(() => {});
      }
      return true;
    }
    res.writeHead(405, cors).end();
    return true;
  }

  async sweepOrphans(olderThanMs: number) {
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory() && e.name.endsWith(".parts")) {
          const s = await stat(p);
          if (Date.now() - s.mtimeMs > olderThanMs) await rm(p, { recursive: true, force: true });
        } else if (e.isDirectory()) await walk(p);
      }
    };
    await walk(this.root);
  }
}
