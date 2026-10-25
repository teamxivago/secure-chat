import { concat, fromB64, fromUtf8, toB64, toB64Url, utf8, type Bytes } from "./bytes";
import { aesGcmOpen, aesGcmSeal, dh, generateDhKeyPair, hkdf, sha256, type KeyPair } from "./primitives";

/**
 * Device linking. The new device shows a QR code containing a fresh X25519 public key.
 * An existing device scans it, then encrypts the account secrets (ASK, profile, settings)
 * to that key. The server relays an opaque blob. For approval without a camera, both
 * devices display a short verification code derived from the new device's key.
 */

export interface ProvisioningPayload {
  accountKey: string; // b64 ASK
  userId: string;
  approvedBy: string; // deviceId
  extra?: Record<string, unknown>;
}

export function createProvisioningKeys(): KeyPair {
  return generateDhKeyPair();
}

export function provisioningUri(linkId: string, publicKey: Bytes): string {
  return `veil://link?id=${encodeURIComponent(linkId)}&pub=${toB64Url(publicKey)}`;
}

export function parseProvisioningUri(uri: string): { linkId: string; publicKey: Bytes } {
  const u = new URL(uri.replace(/^veil:\/\//, "https://veil.invalid/"));
  const linkId = u.searchParams.get("id");
  const pub = u.searchParams.get("pub");
  if (!linkId || !pub) throw new Error("invalid link code");
  return { linkId, publicKey: fromB64(pub) };
}

export function verificationCode(publicKey: Bytes): string {
  const h = sha256(concat(utf8("Veil_LinkCode"), publicKey));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return (n % 1000000).toString().padStart(6, "0");
}

export function encryptProvisioning(newDevicePublicKey: Bytes, payload: ProvisioningPayload): { ephemeralKey: string; ciphertext: string } {
  const eph = generateDhKeyPair();
  const key = hkdf(dh(eph.privateKey, newDevicePublicKey), undefined, "Veil_Provisioning", 32);
  return {
    ephemeralKey: toB64(eph.publicKey),
    ciphertext: toB64(aesGcmSeal(key, utf8(JSON.stringify(payload)), concat(eph.publicKey, newDevicePublicKey))),
  };
}

export function decryptProvisioning(keys: KeyPair, ephemeralKey: string, ciphertext: string): ProvisioningPayload {
  const eph = fromB64(ephemeralKey);
  const key = hkdf(dh(keys.privateKey, eph), undefined, "Veil_Provisioning", 32);
  return JSON.parse(fromUtf8(aesGcmOpen(key, fromB64(ciphertext), concat(eph, keys.publicKey))));
}
