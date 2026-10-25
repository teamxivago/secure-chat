import {
  chunkCount,
  decryptChunk,
  ENCRYPTED_CHUNK_SIZE,
  encryptChunk,
  encryptedSize,
  fromB64,
  generateMediaKey,
  MEDIA_CHUNK_SIZE,
  randomBytes,
  sha256,
  toB64,
  toB64Url,
  utf8,
} from "@veil/crypto";
import type { Attachment } from "@veil/shared";
import { mediaCacheDelete, mediaCacheGet, mediaCachePut } from "../lib/db";
import { ctx } from "./context";

/**
 * Client-side media encryption pipeline. Files are encrypted chunk-by-chunk on the device and
 * uploaded to R2 as ciphertext (parallel multipart). The per-file key travels only inside the
 * E2EE message. Downloads stream ciphertext and decrypt locally.
 */

const PARALLEL = 4;

function authHeaders(): Record<string, string> {
  const t = ctx.account?.token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function svcJson<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const res = await fetch(ctx.svc("media") + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders(), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `media service ${res.status}`);
  return data as T;
}

function putWithProgress(url: string, data: Uint8Array, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("ETag") ?? "") : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(data as Uint8Array<ArrayBuffer>);
  });
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** once-view: server hard-deletes after ttl seconds; recipients can delete with the token */
  ttl?: number;
  public?: boolean;
}

export async function uploadEncrypted(file: Blob, opts: UploadOptions = {}): Promise<Pick<Attachment, "mediaId" | "key" | "size" | "encryptedSize" | "deleteToken">> {
  const key = generateMediaKey();
  const size = file.size;
  const total = encryptedSize(size);
  const deleteToken = toB64Url(randomBytes(24));
  const created = await svcJson<{ mediaId: string; url?: string; partUrls?: string[]; partSize?: number }>("POST", "/uploads", {
    size: total,
    ttl: opts.ttl,
    deleteTokenHash: toB64(sha256(utf8(deleteToken))),
    public: opts.public,
  });
  const n = chunkCount(size);
  const loaded = new Array<number>(n).fill(0);
  const report = () => opts.onProgress?.(Math.min(1, loaded.reduce((a, b) => a + b, 0) / total));
  const encryptPart = async (i: number) => {
    const start = i * MEDIA_CHUNK_SIZE;
    const pt = new Uint8Array(await file.slice(start, Math.min(size, start + MEDIA_CHUNK_SIZE)).arrayBuffer());
    return encryptChunk(key, i, i === n - 1, pt);
  };
  try {
    if (created.url) {
      const data = await encryptPart(0);
      await putWithProgress(created.url, data, (l) => ((loaded[0] = l), report()), opts.signal);
      await svcJson("POST", `/uploads/${created.mediaId}/complete`, {});
    } else {
      const parts: { partNumber: number; etag: string }[] = [];
      let next = 0;
      const worker = async () => {
        while (next < n) {
          const i = next++;
          if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
          const data = await encryptPart(i);
          const etag = await putWithProgress(created.partUrls![i], data, (l) => ((loaded[i] = l), report()), opts.signal);
          parts.push({ partNumber: i + 1, etag });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, n) }, worker));
      await svcJson("POST", `/uploads/${created.mediaId}/complete`, { parts });
    }
  } catch (e) {
    void svcJson("DELETE", `/media/${created.mediaId}`).catch(() => {});
    throw e;
  }
  opts.onProgress?.(1);
  return { mediaId: created.mediaId, key: toB64(key), size, encryptedSize: total, deleteToken };
}

const inflight = new Map<string, Promise<Blob>>();

/** Downloads + decrypts an attachment (cached locally, encrypted at rest). */
export function downloadAttachment(
  att: Pick<Attachment, "mediaId" | "key" | "mime" | "encryptedSize">,
  opts: { onProgress?: (f: number) => void; noCache?: boolean; signal?: AbortSignal } = {},
): Promise<Blob> {
  const existing = inflight.get(att.mediaId);
  if (existing) return existing;
  const p = (async () => {
    if (!opts.noCache) {
      const hit = await mediaCacheGet(att.mediaId);
      if (hit) return new Blob([hit.data], { type: hit.mime || att.mime });
    }
    const { url } = await svcJson<{ url: string; size: number }>("GET", `/media/${encodeURIComponent(att.mediaId)}`);
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const key = fromB64(att.key);
    const reader = res.body.getReader();
    const total = att.encryptedSize || Number(res.headers.get("content-length") ?? 0);
    let buf = new Uint8Array(0);
    let received = 0;
    let index = 0;
    const out: BlobPart[] = [];
    // Decrypt chunk-by-chunk as bytes arrive (constant memory overhead per chunk).
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        received += value.length;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
        opts.onProgress?.(total ? received / total : 0);
        // A full chunk followed by more bytes can't be the last one; the tail is decrypted at EOF.
        while (buf.length > ENCRYPTED_CHUNK_SIZE) {
          out.push((await decryptChunk(key, index++, false, buf.subarray(0, ENCRYPTED_CHUNK_SIZE))) as Uint8Array<ArrayBuffer>);
          buf = buf.slice(ENCRYPTED_CHUNK_SIZE);
        }
      }
      if (done) {
        if (buf.length) out.push((await decryptChunk(key, index++, true, buf)) as Uint8Array<ArrayBuffer>);
        break;
      }
    }
    if (received < total) throw new Error("download truncated");
    const blob = new Blob(out, { type: att.mime });
    if (!opts.noCache) await mediaCachePut(att.mediaId, await blob.arrayBuffer(), att.mime).catch(() => {});
    return blob;
  })().finally(() => inflight.delete(att.mediaId));
  inflight.set(att.mediaId, p);
  return p;
}

/** Permanently deletes a blob (sender, or once-view recipient holding the delete token). */
export async function destroyMedia(att: Pick<Attachment, "mediaId" | "deleteToken">) {
  await mediaCacheDelete(att.mediaId);
  await svcJson("DELETE", `/media/${encodeURIComponent(att.mediaId)}`, undefined, att.deleteToken ? { "x-delete-token": att.deleteToken } : {}).catch(() => {});
}

const urlCache = new Map<string, string>();
export async function attachmentUrl(att: Pick<Attachment, "mediaId" | "key" | "mime" | "encryptedSize">, opts?: { onProgress?: (f: number) => void }): Promise<string> {
  const hit = urlCache.get(att.mediaId);
  if (hit) return hit;
  const url = URL.createObjectURL(await downloadAttachment(att, opts));
  urlCache.set(att.mediaId, url);
  return url;
}
export function forgetAttachmentUrl(mediaId: string) {
  const u = urlCache.get(mediaId);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(mediaId);
}

/* ------------------------------ thumbnails & metadata ------------------------------ */

export async function imageInfo(file: Blob): Promise<{ width: number; height: number; thumbnail: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 48 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const info = { width: bmp.width, height: bmp.height, thumbnail: c.toDataURL("image/jpeg", 0.6) };
  bmp.close();
  return info;
}

export function videoInfo(file: Blob): Promise<{ width: number; height: number; duration: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    const done = (thumb?: string) => {
      resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration || 0, thumbnail: thumb });
      URL.revokeObjectURL(url);
    };
    v.onloadeddata = () => {
      try {
        const scale = Math.min(1, 64 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * scale));
        c.height = Math.max(1, Math.round(v.videoHeight * scale));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        done(c.toDataURL("image/jpeg", 0.6));
      } catch {
        done();
      }
    };
    v.onerror = () => done();
    setTimeout(() => done(), 5000);
  });
}

export function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(file);
    a.preload = "metadata";
    a.src = url;
    a.onloadedmetadata = () => {
      resolve(Number.isFinite(a.duration) ? a.duration : 0);
      URL.revokeObjectURL(url);
    };
    a.onerror = () => resolve(0);
  });
}
