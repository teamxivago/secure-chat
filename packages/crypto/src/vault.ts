import { concat, fromB64, fromUtf8, randomBytes, toB64, toB64Url, utf8, type Bytes } from "./bytes";
import { aesGcmOpen, aesGcmSeal, hkdf, hmacSha256 } from "./primitives";
import { scrypt } from "@noble/hashes/scrypt.js";

/**
 * Account Storage Key (ASK): a 32-byte secret shared only among a user's own linked devices
 * (transferred via QR provisioning). It encrypts the multi-device history vault, drafts,
 * settings and contact list stored on the server, so every device sees identical data while
 * the server holds only ciphertext.
 */

export const generateAccountKey = (): Bytes => randomBytes(32);

const recordKey = (ask: Bytes, kind: string) => hkdf(ask, undefined, `Veil_Vault_${kind}`, 32);

/** Opaque, deterministic record id so the server can dedupe without learning real ids. */
export function vaultRecordId(ask: Bytes, kind: string, id: string): string {
  return toB64Url(hmacSha256(hkdf(ask, undefined, "Veil_Vault_Ids", 32), utf8(`${kind}:${id}`))).slice(0, 43);
}

export function vaultSeal<T>(ask: Bytes, kind: string, id: string, value: T): string {
  return toB64(aesGcmSeal(recordKey(ask, kind), utf8(JSON.stringify(value)), utf8(`${kind}:${id}`)));
}

export function vaultOpen<T>(ask: Bytes, kind: string, id: string, sealed: string): T {
  return JSON.parse(fromUtf8(aesGcmOpen(recordKey(ask, kind), fromB64(sealed), utf8(`${kind}:${id}`)))) as T;
}

/**
 * Recovery: the ASK can be backed up to the server wrapped under a key stretched from a
 * user-chosen recovery passphrase (scrypt N=2^17). Lets a user who lost all devices restore
 * history on a new device. The server only ever holds the wrapped blob.
 */
export function wrapAccountKey(ask: Bytes, passphrase: string): string {
  const salt = randomBytes(16);
  const k = scrypt(utf8(passphrase.normalize("NFKC")), salt, { N: 2 ** 17, r: 8, p: 1, dkLen: 32 });
  return toB64(concat(salt, aesGcmSeal(k, ask, utf8("Veil_ASK_Backup"))));
}

export function unwrapAccountKey(wrapped: string, passphrase: string): Bytes {
  const b = fromB64(wrapped);
  const k = scrypt(utf8(passphrase.normalize("NFKC")), b.subarray(0, 16), { N: 2 ** 17, r: 8, p: 1, dkLen: 32 });
  return aesGcmOpen(k, b.subarray(16), utf8("Veil_ASK_Backup"));
}

/** Human-friendly recovery key: 64 chars in groups of 4 (base32-ish, unambiguous alphabet). */
export function generateRecoveryKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(64);
  let s = "";
  for (let i = 0; i < 64; i++) s += alphabet[b[i] % 32];
  return s.match(/.{4}/g)!.join("-");
}
