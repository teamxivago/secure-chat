import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { cbc, gcm } from "@noble/ciphers/aes.js";
import { x25519, ed25519 } from "@noble/curves/ed25519.js";
import { concat, equal, randomBytes, utf8, type Bytes } from "./bytes";

export { sha256, sha512 };

export const ZERO32 = new Uint8Array(32);

export function hkdf(ikm: Bytes, salt: Bytes | undefined, info: string | Bytes, length: number): Bytes {
  return nobleHkdf(sha256, ikm, salt ?? ZERO32, typeof info === "string" ? utf8(info) : info, length);
}

export function hmacSha256(key: Bytes, data: Bytes): Bytes {
  return hmac(sha256, key, data);
}

export function aesCbcEncrypt(key: Bytes, iv: Bytes, plaintext: Bytes): Bytes {
  return cbc(key, iv).encrypt(plaintext);
}

export function aesCbcDecrypt(key: Bytes, iv: Bytes, ciphertext: Bytes): Bytes {
  return cbc(key, iv).decrypt(ciphertext);
}

/** AES-256-GCM; output = nonce(12) || ciphertext || tag(16). */
export function aesGcmSeal(key: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  const nonce = randomBytes(12);
  return concat(nonce, gcm(key, nonce, aad).encrypt(plaintext));
}

export function aesGcmOpen(key: Bytes, sealed: Bytes, aad?: Bytes): Bytes {
  if (sealed.length < 28) throw new CryptoError("ciphertext too short");
  try {
    return gcm(key, sealed.subarray(0, 12), aad).decrypt(sealed.subarray(12));
  } catch {
    throw new CryptoError("authentication failed");
  }
}

export interface KeyPair {
  publicKey: Bytes;
  privateKey: Bytes;
}

export function generateDhKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function dh(privateKey: Bytes, publicKey: Bytes): Bytes {
  const shared = x25519.getSharedSecret(privateKey, publicKey);
  // Reject low-order points (all-zero output).
  if (equal(shared, ZERO32)) throw new CryptoError("invalid DH public key");
  return shared;
}

export function generateSigningKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export const signingPublicKey = (privateKey: Bytes): Bytes => ed25519.getPublicKey(privateKey);

export function sign(privateKey: Bytes, message: Bytes): Bytes {
  return ed25519.sign(message, privateKey);
}

export function verify(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Ed25519 identity keys are converted to X25519 for Diffie-Hellman (birational map). */
export const edPubToX = (pub: Bytes): Bytes => ed25519.utils.toMontgomery(pub);
export const edPrivToX = (priv: Bytes): Bytes => ed25519.utils.toMontgomerySecret(priv);

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}
