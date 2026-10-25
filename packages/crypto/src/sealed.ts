import { concat, equal, fromB64, fromUtf8, readU32be, toB64, u32be, utf8, type Bytes } from "./bytes";
import { identityDh, type IdentityKeyPair } from "./identity";
import { aesGcmOpen, aesGcmSeal, CryptoError, dh, edPubToX, generateDhKeyPair, hkdf, sign, verify, type KeyPair } from "./primitives";

/**
 * Sealed sender (Signal "unidentified delivery" v1). The envelope reveals only the
 * recipient; the sender's identity and server-issued sender certificate are encrypted
 * to the recipient's identity key. The server stores and routes the blob without
 * knowing who sent it.
 */

const SEALED_VERSION = 0x11;

export interface SenderCertificateBody {
  userId: string;
  deviceId: string;
  identityKey: string; // b64 ed25519
  expires: number; // ms epoch
}

export interface SenderCertificate {
  body: string; // b64(JSON(SenderCertificateBody))
  signature: string; // b64 ed25519 by server trust root
}

export function issueSenderCertificate(serverKey: KeyPair, body: SenderCertificateBody): SenderCertificate {
  const raw = utf8(JSON.stringify(body));
  return { body: toB64(raw), signature: toB64(sign(serverKey.privateKey, raw)) };
}

export function validateSenderCertificate(trustRoot: Bytes, cert: SenderCertificate, now = Date.now()): SenderCertificateBody {
  const raw = fromB64(cert.body);
  if (!verify(trustRoot, raw, fromB64(cert.signature))) throw new CryptoError("invalid sender certificate signature");
  const body = JSON.parse(fromUtf8(raw)) as SenderCertificateBody;
  if (body.expires < now) throw new CryptoError("sender certificate expired");
  return body;
}

interface SealedInner {
  cert: SenderCertificate;
  type: number;
  body: string;
}

export interface UnsealedMessage {
  senderUserId: string;
  senderDeviceId: string;
  senderIdentityKey: Bytes;
  type: number;
  body: Bytes;
}

export function sealedSenderEncrypt(
  sender: IdentityKeyPair,
  cert: SenderCertificate,
  recipientIdentityKey: Bytes,
  type: number,
  body: Bytes,
): Bytes {
  const recipientX = edPubToX(recipientIdentityKey);
  const eph = generateDhKeyPair();
  const ephKeys = hkdf(
    dh(eph.privateKey, recipientX),
    concat(utf8("UnidentifiedDelivery"), recipientX, eph.publicKey),
    "Veil_Sealed_Ephemeral",
    64,
  );
  const chainKey = ephKeys.slice(0, 32);
  const encStatic = aesGcmSeal(ephKeys.slice(32), sender.publicKey, eph.publicKey);
  const senderX = identityDh(sender);
  const staticKey = hkdf(dh(senderX.privateKey, recipientX), concat(chainKey, encStatic), "Veil_Sealed_Static", 32);
  const inner: SealedInner = { cert, type, body: toB64(body) };
  const encMessage = aesGcmSeal(staticKey, utf8(JSON.stringify(inner)), concat(eph.publicKey, encStatic));
  return concat(Uint8Array.of(SEALED_VERSION), eph.publicKey, u32be(encStatic.length), encStatic, encMessage);
}

export function sealedSenderDecrypt(local: IdentityKeyPair, trustRoot: Bytes, sealed: Bytes, now = Date.now()): UnsealedMessage {
  if (sealed[0] !== SEALED_VERSION || sealed.length < 1 + 32 + 4 + 28) throw new CryptoError("invalid sealed sender message");
  const ephPub = sealed.subarray(1, 33);
  const staticLen = readU32be(sealed, 33);
  const encStatic = sealed.subarray(37, 37 + staticLen);
  const encMessage = sealed.subarray(37 + staticLen);
  const localX = identityDh(local);
  const ephKeys = hkdf(
    dh(localX.privateKey, ephPub),
    concat(utf8("UnidentifiedDelivery"), localX.publicKey, ephPub),
    "Veil_Sealed_Ephemeral",
    64,
  );
  const senderIdentityKey = aesGcmOpen(ephKeys.slice(32), encStatic, ephPub);
  const staticKey = hkdf(
    dh(localX.privateKey, edPubToX(senderIdentityKey)),
    concat(ephKeys.slice(0, 32), encStatic),
    "Veil_Sealed_Static",
    32,
  );
  const inner = JSON.parse(fromUtf8(aesGcmOpen(staticKey, encMessage, concat(ephPub, encStatic)))) as SealedInner;
  const cert = validateSenderCertificate(trustRoot, inner.cert, now);
  if (!equal(fromB64(cert.identityKey), senderIdentityKey)) {
    throw new CryptoError("sender certificate does not match sealed identity");
  }
  return {
    senderUserId: cert.userId,
    senderDeviceId: cert.deviceId,
    senderIdentityKey,
    type: inner.type,
    body: fromB64(inner.body),
  };
}
