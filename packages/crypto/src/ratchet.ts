import { concat, equal, fromB64, readU32be, toB64, u32be, type Bytes } from "./bytes";
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  CryptoError,
  dh,
  generateDhKeyPair,
  hkdf,
  hmacSha256,
  type KeyPair,
} from "./primitives";

/**
 * Double Ratchet (Signal specification, revision 4) with AES-256-CBC + HMAC-SHA256 AEAD.
 * Every message uses a fresh message key (forward secrecy); every round trip performs a DH
 * ratchet step (post-compromise security).
 */

export const MAX_SKIP = 2000;
const VERSION = 3;
const HEADER_LEN = 1 + 32 + 4 + 4;
const MAC_LEN = 16;

export interface RatchetState {
  rootKey: Bytes;
  sendingKeyPair: KeyPair;
  sendingChainKey: Bytes | null;
  sendingCounter: number;
  previousCounter: number;
  receivingKey: Bytes | null;
  receivingChainKey: Bytes | null;
  receivingCounter: number;
  /** key: b64(ratchetPub) + ":" + n */
  skipped: [string, Bytes][];
  associatedData: Bytes;
}

export interface RatchetHeader {
  dh: Bytes;
  previousCounter: number;
  counter: number;
}

function kdfRoot(rootKey: Bytes, dhOut: Bytes): [Bytes, Bytes] {
  const out = hkdf(dhOut, rootKey, "Veil_Ratchet", 64);
  return [out.slice(0, 32), out.slice(32)];
}

function kdfChain(chainKey: Bytes): [Bytes, Bytes] {
  return [hmacSha256(chainKey, Uint8Array.of(1)), hmacSha256(chainKey, Uint8Array.of(2))];
}

function messageKeys(mk: Bytes) {
  const out = hkdf(mk, undefined, "Veil_MessageKeys", 80);
  return { encKey: out.slice(0, 32), macKey: out.slice(32, 64), iv: out.slice(64, 80) };
}

export function encodeHeader(h: RatchetHeader): Bytes {
  return concat(Uint8Array.of(VERSION), h.dh, u32be(h.previousCounter), u32be(h.counter));
}

export function decodeHeader(b: Bytes): RatchetHeader {
  if (b.length < HEADER_LEN || b[0] !== VERSION) throw new CryptoError("unsupported message version");
  return { dh: b.slice(1, 33), previousCounter: readU32be(b, 33), counter: readU32be(b, 37) };
}

function seal(mk: Bytes, header: Bytes, plaintext: Bytes, ad: Bytes): Bytes {
  const { encKey, macKey, iv } = messageKeys(mk);
  const ct = aesCbcEncrypt(encKey, iv, plaintext);
  const mac = hmacSha256(macKey, concat(ad, header, ct)).slice(0, MAC_LEN);
  return concat(header, ct, mac);
}

function open(mk: Bytes, message: Bytes, ad: Bytes): Bytes {
  const header = message.subarray(0, HEADER_LEN);
  const ct = message.subarray(HEADER_LEN, message.length - MAC_LEN);
  const mac = message.subarray(message.length - MAC_LEN);
  const { encKey, macKey, iv } = messageKeys(mk);
  const expected = hmacSha256(macKey, concat(ad, header, ct)).slice(0, MAC_LEN);
  if (!equal(mac, expected)) throw new CryptoError("bad message MAC");
  return aesCbcDecrypt(encKey, iv, ct);
}

export function initSender(sharedSecret: Bytes, remoteRatchetKey: Bytes, ad: Bytes): RatchetState {
  const sendingKeyPair = generateDhKeyPair();
  const [rootKey, sendingChainKey] = kdfRoot(sharedSecret, dh(sendingKeyPair.privateKey, remoteRatchetKey));
  return {
    rootKey,
    sendingKeyPair,
    sendingChainKey,
    sendingCounter: 0,
    previousCounter: 0,
    receivingKey: remoteRatchetKey,
    receivingChainKey: null,
    receivingCounter: 0,
    skipped: [],
    associatedData: ad,
  };
}

export function initReceiver(sharedSecret: Bytes, localRatchetKey: KeyPair, ad: Bytes): RatchetState {
  return {
    rootKey: sharedSecret,
    sendingKeyPair: localRatchetKey,
    sendingChainKey: null,
    sendingCounter: 0,
    previousCounter: 0,
    receivingKey: null,
    receivingChainKey: null,
    receivingCounter: 0,
    skipped: [],
    associatedData: ad,
  };
}

export function cloneState(s: RatchetState): RatchetState {
  return {
    ...s,
    rootKey: s.rootKey.slice(),
    sendingKeyPair: { publicKey: s.sendingKeyPair.publicKey.slice(), privateKey: s.sendingKeyPair.privateKey.slice() },
    sendingChainKey: s.sendingChainKey?.slice() ?? null,
    receivingKey: s.receivingKey?.slice() ?? null,
    receivingChainKey: s.receivingChainKey?.slice() ?? null,
    skipped: s.skipped.map(([k, v]) => [k, v.slice()]),
    associatedData: s.associatedData.slice(),
  };
}

/** Encrypts and advances state in place. */
export function ratchetEncrypt(state: RatchetState, plaintext: Bytes): Bytes {
  if (!state.sendingChainKey) {
    throw new CryptoError("session cannot send before receiving the first message");
  }
  const [mk, next] = kdfChain(state.sendingChainKey);
  state.sendingChainKey = next;
  const header = encodeHeader({
    dh: state.sendingKeyPair.publicKey,
    previousCounter: state.previousCounter,
    counter: state.sendingCounter,
  });
  state.sendingCounter++;
  return seal(mk, header, plaintext, state.associatedData);
}

function skipKeys(state: RatchetState, until: number) {
  if (!state.receivingChainKey || !state.receivingKey) return;
  if (until - state.receivingCounter > MAX_SKIP) throw new CryptoError("too many skipped messages");
  const prefix = toB64(state.receivingKey) + ":";
  while (state.receivingCounter < until) {
    const [mk, next] = kdfChain(state.receivingChainKey);
    state.receivingChainKey = next;
    state.skipped.push([prefix + state.receivingCounter, mk]);
    state.receivingCounter++;
  }
  if (state.skipped.length > MAX_SKIP) state.skipped.splice(0, state.skipped.length - MAX_SKIP);
}

function dhRatchet(state: RatchetState, remote: Bytes) {
  state.previousCounter = state.sendingCounter;
  state.sendingCounter = 0;
  state.receivingCounter = 0;
  state.receivingKey = remote;
  [state.rootKey, state.receivingChainKey] = kdfRoot(state.rootKey, dh(state.sendingKeyPair.privateKey, remote));
  state.sendingKeyPair = generateDhKeyPair();
  [state.rootKey, state.sendingChainKey] = kdfRoot(state.rootKey, dh(state.sendingKeyPair.privateKey, remote));
}

/** Decrypts; returns the new state (input state is never mutated, so failures are side-effect free). */
export function ratchetDecrypt(input: RatchetState, message: Bytes): { state: RatchetState; plaintext: Bytes } {
  if (message.length < HEADER_LEN + MAC_LEN + 16) throw new CryptoError("message too short");
  const state = cloneState(input);
  const header = decodeHeader(message);
  const skippedId = toB64(header.dh) + ":" + header.counter;
  const idx = state.skipped.findIndex(([k]) => k === skippedId);
  if (idx >= 0) {
    const mk = state.skipped[idx][1];
    const plaintext = open(mk, message, state.associatedData);
    state.skipped.splice(idx, 1);
    return { state, plaintext };
  }
  if (!state.receivingKey || !equal(header.dh, state.receivingKey) || !state.receivingChainKey) {
    if (state.receivingKey && state.receivingChainKey) skipKeys(state, header.previousCounter);
    dhRatchet(state, header.dh);
  }
  if (header.counter < state.receivingCounter) throw new CryptoError("duplicate or replayed message");
  skipKeys(state, header.counter);
  const [mk, next] = kdfChain(state.receivingChainKey!);
  const plaintext = open(mk, message, state.associatedData);
  state.receivingChainKey = next;
  state.receivingCounter++;
  return { state, plaintext };
}

/* ---------- serialization ---------- */

export interface SerializedRatchetState {
  rk: string;
  sk: [string, string];
  sck: string | null;
  sn: number;
  pn: number;
  rk2: string | null;
  rck: string | null;
  rn: number;
  skip: [string, string][];
  ad: string;
}

export function serializeState(s: RatchetState): SerializedRatchetState {
  return {
    rk: toB64(s.rootKey),
    sk: [toB64(s.sendingKeyPair.publicKey), toB64(s.sendingKeyPair.privateKey)],
    sck: s.sendingChainKey ? toB64(s.sendingChainKey) : null,
    sn: s.sendingCounter,
    pn: s.previousCounter,
    rk2: s.receivingKey ? toB64(s.receivingKey) : null,
    rck: s.receivingChainKey ? toB64(s.receivingChainKey) : null,
    rn: s.receivingCounter,
    skip: s.skipped.map(([k, v]) => [k, toB64(v)]),
    ad: toB64(s.associatedData),
  };
}

export function deserializeState(s: SerializedRatchetState): RatchetState {
  return {
    rootKey: fromB64(s.rk),
    sendingKeyPair: { publicKey: fromB64(s.sk[0]), privateKey: fromB64(s.sk[1]) },
    sendingChainKey: s.sck ? fromB64(s.sck) : null,
    sendingCounter: s.sn,
    previousCounter: s.pn,
    receivingKey: s.rk2 ? fromB64(s.rk2) : null,
    receivingChainKey: s.rck ? fromB64(s.rck) : null,
    receivingCounter: s.rn,
    skipped: s.skip.map(([k, v]) => [k, fromB64(v)]),
    associatedData: fromB64(s.ad),
  };
}
