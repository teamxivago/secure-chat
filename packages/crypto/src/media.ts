import { concat, equal, fromB64, randomBytes, toB64, u32be, type Bytes } from "./bytes";
import { CryptoError } from "./primitives";

/**
 * Attachment encryption. A random 64-byte key per file (32 AES-256-CBC + 32 HMAC-SHA256).
 * The file is split into fixed 8 MiB plaintext chunks, each encrypted independently:
 *
 *   chunk_i = iv(16) || AES-CBC(pt_i) || HMAC(macKey, u32(i) || u8(last) || iv || ct)(32)
 *
 * Binding the index and "last" flag prevents chunk reordering and truncation. Fixed-size
 * chunks map 1:1 onto S3/R2 multipart parts (all equal size except the last), so uploads and
 * downloads stream in parallel and support ranged reads. Uses WebCrypto for native speed.
 */

export const MEDIA_CHUNK_SIZE = 8 * 1024 * 1024;
/** Ciphertext size of a full chunk: iv + (pt + one full PKCS7 block) + mac. */
export const ENCRYPTED_CHUNK_SIZE = 16 + MEDIA_CHUNK_SIZE + 16 + 32;

export interface MediaKey {
  key: string; // b64 64 bytes
  digest: string; // b64 sha256 of the full ciphertext
  size: number; // plaintext size
  chunkSize: number;
}

/** WebCrypto typings require ArrayBuffer-backed views; our buffers always are. */
const bs = (b: Bytes) => b as Uint8Array<ArrayBuffer>;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new CryptoError("WebCrypto unavailable (secure context required)");
  return s;
};

export function generateMediaKey(): Bytes {
  return randomBytes(64);
}

async function importKeys(key: Bytes) {
  if (key.length !== 64) throw new CryptoError("invalid media key");
  const s = subtle();
  const aes = await s.importKey("raw", bs(key.slice(0, 32)), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  const mac = await s.importKey("raw", bs(key.slice(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { aes, mac };
}

export function encryptedSize(plainSize: number): number {
  const full = Math.floor(plainSize / MEDIA_CHUNK_SIZE);
  const rem = plainSize % MEDIA_CHUNK_SIZE;
  const fullCount = rem === 0 && plainSize > 0 ? full - 1 : full;
  const lastPlain = plainSize === 0 ? 0 : rem === 0 ? MEDIA_CHUNK_SIZE : rem;
  return fullCount * ENCRYPTED_CHUNK_SIZE + 16 + (Math.floor(lastPlain / 16) + 1) * 16 + 32;
}

export function chunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / MEDIA_CHUNK_SIZE));
}

export async function encryptChunk(key: Bytes, index: number, last: boolean, plaintext: Bytes): Promise<Bytes> {
  const { aes, mac } = await importKeys(key);
  const iv = randomBytes(16);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: bs(iv) }, aes, bs(plaintext)));
  const tag = new Uint8Array(await subtle().sign("HMAC", mac, bs(concat(u32be(index), Uint8Array.of(last ? 1 : 0), iv, ct))));
  return concat(iv, ct, tag);
}

export async function decryptChunk(key: Bytes, index: number, last: boolean, chunk: Bytes): Promise<Bytes> {
  if (chunk.length < 16 + 16 + 32) throw new CryptoError("invalid media chunk");
  const { aes, mac } = await importKeys(key);
  const iv = chunk.subarray(0, 16);
  const ct = chunk.subarray(16, chunk.length - 32);
  const tag = chunk.subarray(chunk.length - 32);
  const expected = new Uint8Array(await subtle().sign("HMAC", mac, bs(concat(u32be(index), Uint8Array.of(last ? 1 : 0), iv, ct))));
  if (!equal(tag, expected)) throw new CryptoError("media chunk authentication failed");
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv: bs(iv) }, aes, bs(ct)));
  } catch {
    throw new CryptoError("media chunk decryption failed");
  }
}

export interface BlobLike {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/**
 * Streams a file through encryption, yielding encrypted chunks in order. The caller uploads
 * each chunk as a multipart part (parallelism is controlled by the caller).
 */
export async function* encryptFileChunks(key: Bytes, file: BlobLike): AsyncGenerator<{ index: number; last: boolean; data: Bytes }> {
  const n = chunkCount(file.size);
  for (let i = 0; i < n; i++) {
    const start = i * MEDIA_CHUNK_SIZE;
    const pt = new Uint8Array(await file.slice(start, Math.min(file.size, start + MEDIA_CHUNK_SIZE)).arrayBuffer());
    const last = i === n - 1;
    yield { index: i, last, data: await encryptChunk(key, i, last, pt) };
  }
}

/** Convenience for small payloads (avatars, thumbnails, stickers): encrypt whole buffer. */
export async function encryptBuffer(key: Bytes, data: Bytes): Promise<Bytes> {
  const n = chunkCount(data.length);
  const parts: Bytes[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(await encryptChunk(key, i, i === n - 1, data.subarray(i * MEDIA_CHUNK_SIZE, (i + 1) * MEDIA_CHUNK_SIZE)));
  }
  return concat(...parts);
}

export async function decryptBuffer(key: Bytes, data: Bytes): Promise<Bytes> {
  const parts: Bytes[] = [];
  let off = 0;
  let i = 0;
  while (off < data.length) {
    const end = Math.min(data.length, off + ENCRYPTED_CHUNK_SIZE);
    const last = end === data.length;
    parts.push(await decryptChunk(key, i, last, data.subarray(off, end)));
    off = end;
    i++;
  }
  if (i === 0) throw new CryptoError("empty media");
  return concat(...parts);
}

export async function sha256Digest(data: Bytes): Promise<string> {
  return toB64(new Uint8Array(await subtle().digest("SHA-256", bs(data))));
}

export const mediaKeyFromB64 = (s: string) => fromB64(s);
