import { concat, type Bytes } from "./bytes";
import { CryptoError, dh, edPubToX, generateDhKeyPair, hkdf, type KeyPair } from "./primitives";
import { identityDh, verifySignedPreKey, type IdentityKeyPair, type PreKeyBundle } from "./identity";

const X3DH_INFO = "Veil_X3DH_X25519_SHA256";
const F = new Uint8Array(32).fill(0xff);

export interface X3DHInitResult {
  sharedSecret: Bytes;
  associatedData: Bytes;
  baseKey: KeyPair; // Alice's ephemeral key
  signedPreKeyId: number;
  oneTimePreKeyId?: number;
}

/** Alice side: derive a shared secret from Bob's published pre-key bundle. */
export function x3dhInitiate(local: IdentityKeyPair, bundle: PreKeyBundle): X3DHInitResult {
  if (!verifySignedPreKey(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature)) {
    throw new CryptoError("invalid signed pre-key signature");
  }
  const ik = identityDh(local);
  const ek = generateDhKeyPair();
  const remoteIk = edPubToX(bundle.identityKey);
  const parts = [
    F,
    dh(ik.privateKey, bundle.signedPreKey.publicKey),
    dh(ek.privateKey, remoteIk),
    dh(ek.privateKey, bundle.signedPreKey.publicKey),
  ];
  if (bundle.oneTimePreKey) parts.push(dh(ek.privateKey, bundle.oneTimePreKey.publicKey));
  const sharedSecret = hkdf(concat(...parts), undefined, X3DH_INFO, 32);
  return {
    sharedSecret,
    associatedData: concat(local.publicKey, bundle.identityKey),
    baseKey: ek,
    signedPreKeyId: bundle.signedPreKey.keyId,
    oneTimePreKeyId: bundle.oneTimePreKey?.keyId,
  };
}

/** Bob side: recompute the shared secret from Alice's initial message parameters. */
export function x3dhRespond(
  local: IdentityKeyPair,
  signedPreKey: KeyPair,
  oneTimePreKey: KeyPair | undefined,
  remoteIdentityKey: Bytes,
  remoteBaseKey: Bytes,
): { sharedSecret: Bytes; associatedData: Bytes } {
  const ik = identityDh(local);
  const remoteIk = edPubToX(remoteIdentityKey);
  const parts = [
    F,
    dh(signedPreKey.privateKey, remoteIk),
    dh(ik.privateKey, remoteBaseKey),
    dh(signedPreKey.privateKey, remoteBaseKey),
  ];
  if (oneTimePreKey) parts.push(dh(oneTimePreKey.privateKey, remoteBaseKey));
  return {
    sharedSecret: hkdf(concat(...parts), undefined, X3DH_INFO, 32),
    associatedData: concat(remoteIdentityKey, local.publicKey),
  };
}
