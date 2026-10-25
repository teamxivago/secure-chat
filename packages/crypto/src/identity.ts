import { concat, fromB64, randomBytes, toB64, u32be, type Bytes } from "./bytes";
import {
  CryptoError,
  edPrivToX,
  edPubToX,
  generateDhKeyPair,
  generateSigningKeyPair,
  sha512,
  sign,
  verify,
  type KeyPair,
} from "./primitives";

/** Long-term device identity: Ed25519 key pair; X25519 form derived for DH. */
export interface IdentityKeyPair {
  publicKey: Bytes; // ed25519, 32 bytes
  privateKey: Bytes; // ed25519 seed, 32 bytes
}

export interface SignedPreKey {
  keyId: number;
  keyPair: KeyPair;
  signature: Bytes;
  createdAt: number;
}

export interface OneTimePreKey {
  keyId: number;
  keyPair: KeyPair;
}

export interface PreKeyBundle {
  registrationId: number;
  deviceId: string;
  identityKey: Bytes;
  signedPreKey: { keyId: number; publicKey: Bytes; signature: Bytes };
  oneTimePreKey?: { keyId: number; publicKey: Bytes };
}

export interface PreKeyBundleWire {
  registrationId: number;
  deviceId: string;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey?: { keyId: number; publicKey: string } | null;
}

export const generateIdentityKeyPair = (): IdentityKeyPair => generateSigningKeyPair();

export function generateRegistrationId(): number {
  const b = randomBytes(2);
  return ((b[0] << 8) | b[1]) & 0x3fff || 1;
}

export function identityDh(identity: IdentityKeyPair): KeyPair {
  return { publicKey: edPubToX(identity.publicKey), privateKey: edPrivToX(identity.privateKey) };
}

export function generateSignedPreKey(identity: IdentityKeyPair, keyId: number): SignedPreKey {
  const keyPair = generateDhKeyPair();
  return { keyId, keyPair, signature: sign(identity.privateKey, keyPair.publicKey), createdAt: Date.now() };
}

export function generateOneTimePreKeys(startId: number, count: number): OneTimePreKey[] {
  const out: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) out.push({ keyId: (startId + i) % 0xffffff || 1, keyPair: generateDhKeyPair() });
  return out;
}

export function verifySignedPreKey(identityKey: Bytes, publicKey: Bytes, signature: Bytes): boolean {
  return verify(identityKey, publicKey, signature);
}

export function bundleFromWire(w: PreKeyBundleWire): PreKeyBundle {
  return {
    registrationId: w.registrationId,
    deviceId: w.deviceId,
    identityKey: fromB64(w.identityKey),
    signedPreKey: {
      keyId: w.signedPreKey.keyId,
      publicKey: fromB64(w.signedPreKey.publicKey),
      signature: fromB64(w.signedPreKey.signature),
    },
    oneTimePreKey: w.oneTimePreKey
      ? { keyId: w.oneTimePreKey.keyId, publicKey: fromB64(w.oneTimePreKey.publicKey) }
      : undefined,
  };
}

export function bundleToWire(b: PreKeyBundle): PreKeyBundleWire {
  return {
    registrationId: b.registrationId,
    deviceId: b.deviceId,
    identityKey: toB64(b.identityKey),
    signedPreKey: {
      keyId: b.signedPreKey.keyId,
      publicKey: toB64(b.signedPreKey.publicKey),
      signature: toB64(b.signedPreKey.signature),
    },
    oneTimePreKey: b.oneTimePreKey
      ? { keyId: b.oneTimePreKey.keyId, publicKey: toB64(b.oneTimePreKey.publicKey) }
      : null,
  };
}

/**
 * Safety number (like Signal's): 60 digits derived from both users' identity keys.
 * Both parties compute the same number regardless of order.
 */
export function safetyNumber(localUserId: string, localIdentity: Bytes, remoteUserId: string, remoteIdentity: Bytes): string {
  const part = (uid: string, key: Bytes) => {
    let h = concat(u32be(0), key, new TextEncoder().encode(uid));
    for (let i = 0; i < 5200; i++) h = sha512(concat(h, key));
    let digits = "";
    for (let i = 0; i < 30; i += 5) {
      const chunk =
        ((h[i] * 2 ** 32 + ((h[i + 1] << 24) >>> 0) + (h[i + 2] << 16) + (h[i + 3] << 8) + h[i + 4]) % 100000);
      digits += chunk.toString().padStart(5, "0");
    }
    return digits;
  };
  const a = part(localUserId, localIdentity);
  const b = part(remoteUserId, remoteIdentity);
  return a < b ? a + b : b + a;
}

export function assertKeyLength(k: Bytes, len: number, what: string) {
  if (!(k instanceof Uint8Array) || k.length !== len) throw new CryptoError(`invalid ${what}`);
}
