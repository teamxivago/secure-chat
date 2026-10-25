import { concat, fromB64, readU32be, randomBytes, toB64, u32be, type Bytes } from "./bytes";
import { aesCbcDecrypt, aesCbcEncrypt, CryptoError, generateSigningKeyPair, hkdf, hmacSha256, sign, verify } from "./primitives";
import type { ProtocolStore } from "./store";
import { pad, unpad } from "./session";

/**
 * Sender Keys (Signal group messaging). Each sender device holds a symmetric hash-ratchet
 * chain per group plus a signing key. The chain + public signing key are distributed to
 * every member device once over pairwise Double Ratchet sessions; each group message is then
 * encrypted once and fanned out by the server.
 */

const VERSION = 0x33;
const MAX_FORWARD = 25000;
const MAX_SKIPPED = 2000;
const MAX_STATES = 5;

export interface SenderKeyDistribution {
  distributionId: string;
  chainId: number;
  iteration: number;
  chainKey: string;
  signingKey: string;
}

interface SenderKeyState {
  chainId: number;
  iteration: number;
  chainKey: string;
  signingPub: string;
  signingPriv?: string;
  skipped: [number, string][];
}

interface SenderKeyRecord {
  distributionId: string;
  states: SenderKeyState[];
}

const storeKey = (groupId: string, senderAddress: string, distributionId: string) =>
  `${groupId}::${senderAddress}::${distributionId}`;

function deriveMessageKey(chainKey: Bytes) {
  const mkSeed = hmacSha256(chainKey, Uint8Array.of(1));
  const next = hmacSha256(chainKey, Uint8Array.of(2));
  return { mkSeed, next };
}

function messageKeys(seed: Bytes) {
  const out = hkdf(seed, undefined, "Veil_SenderKey", 48);
  return { iv: out.slice(0, 16), key: out.slice(16) };
}

const uuidToBytes = (u: string) => {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
};
const bytesToUuid = (b: Bytes) => {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function newDistributionId(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Creates (or rotates) our own sending chain for a group and returns the distribution message. */
export async function createSenderKey(
  store: ProtocolStore,
  groupId: string,
  selfAddress: string,
  distributionId: string,
): Promise<SenderKeyDistribution> {
  const key = storeKey(groupId, selfAddress, distributionId);
  const raw = await store.loadSenderKey(key);
  const record: SenderKeyRecord = raw ? JSON.parse(raw) : { distributionId, states: [] };
  const signing = generateSigningKeyPair();
  const chainIdBytes = randomBytes(4);
  const state: SenderKeyState = {
    chainId: readU32be(chainIdBytes) & 0x7fffffff,
    iteration: 0,
    chainKey: toB64(randomBytes(32)),
    signingPub: toB64(signing.publicKey),
    signingPriv: toB64(signing.privateKey),
    skipped: [],
  };
  record.states = [state, ...record.states].slice(0, MAX_STATES);
  await store.storeSenderKey(key, JSON.stringify(record));
  return { distributionId, chainId: state.chainId, iteration: 0, chainKey: state.chainKey, signingKey: state.signingPub };
}

/** Current distribution message for our own chain (to send to newly added member devices). */
export async function getOwnDistribution(
  store: ProtocolStore,
  groupId: string,
  selfAddress: string,
  distributionId: string,
): Promise<SenderKeyDistribution | undefined> {
  const raw = await store.loadSenderKey(storeKey(groupId, selfAddress, distributionId));
  if (!raw) return undefined;
  const s = (JSON.parse(raw) as SenderKeyRecord).states[0];
  if (!s?.signingPriv) return undefined;
  return { distributionId, chainId: s.chainId, iteration: s.iteration, chainKey: s.chainKey, signingKey: s.signingPub };
}

export async function processSenderKeyDistribution(
  store: ProtocolStore,
  groupId: string,
  senderAddress: string,
  d: SenderKeyDistribution,
): Promise<void> {
  const key = storeKey(groupId, senderAddress, d.distributionId);
  const raw = await store.loadSenderKey(key);
  const record: SenderKeyRecord = raw ? JSON.parse(raw) : { distributionId: d.distributionId, states: [] };
  const existing = record.states.find((s) => s.chainId === d.chainId);
  if (existing) {
    if (existing.signingPub !== d.signingKey) throw new CryptoError("sender key signing key mismatch");
    if (d.iteration < existing.iteration) {
      // An earlier starting point lets us decrypt older messages; replace the chain.
      existing.iteration = d.iteration;
      existing.chainKey = d.chainKey;
    }
  } else {
    record.states.unshift({ chainId: d.chainId, iteration: d.iteration, chainKey: d.chainKey, signingPub: d.signingKey, skipped: [] });
    record.states = record.states.slice(0, MAX_STATES);
  }
  await store.storeSenderKey(key, JSON.stringify(record));
}

export async function groupEncrypt(
  store: ProtocolStore,
  groupId: string,
  selfAddress: string,
  distributionId: string,
  plaintext: Bytes,
): Promise<Bytes> {
  const key = storeKey(groupId, selfAddress, distributionId);
  const raw = await store.loadSenderKey(key);
  if (!raw) throw new CryptoError("no sender key for group");
  const record = JSON.parse(raw) as SenderKeyRecord;
  const state = record.states[0];
  if (!state?.signingPriv) throw new CryptoError("sender key has no signing key");
  const { mkSeed, next } = deriveMessageKey(fromB64(state.chainKey));
  const { iv, key: aesKey } = messageKeys(mkSeed);
  const ct = aesCbcEncrypt(aesKey, iv, pad(plaintext));
  const msg = concat(Uint8Array.of(VERSION), uuidToBytes(distributionId), u32be(state.chainId), u32be(state.iteration), ct);
  const sig = sign(fromB64(state.signingPriv), msg);
  state.iteration++;
  state.chainKey = toB64(next);
  await store.storeSenderKey(key, JSON.stringify(record));
  return concat(msg, sig);
}

/** Reads the distribution id from a group ciphertext without decrypting it. */
export function groupMessageDistributionId(message: Bytes): string {
  if (message[0] !== VERSION) throw new CryptoError("invalid sender key message");
  return bytesToUuid(message.subarray(1, 17));
}

export class NoSenderKeyError extends CryptoError {
  constructor(public distributionId: string) {
    super("no sender key state for distribution");
    this.name = "NoSenderKeyError";
  }
}

export async function groupDecrypt(store: ProtocolStore, groupId: string, senderAddress: string, message: Bytes): Promise<Bytes> {
  if (message.length < 1 + 16 + 8 + 16 + 64 || message[0] !== VERSION) throw new CryptoError("invalid sender key message");
  const distributionId = bytesToUuid(message.subarray(1, 17));
  const key = storeKey(groupId, senderAddress, distributionId);
  const raw = await store.loadSenderKey(key);
  if (!raw) throw new NoSenderKeyError(distributionId);
  const record = JSON.parse(raw) as SenderKeyRecord;
  const chainId = readU32be(message, 17);
  const iteration = readU32be(message, 21);
  const state = record.states.find((s) => s.chainId === chainId);
  if (!state) throw new NoSenderKeyError(distributionId);
  const body = message.subarray(0, message.length - 64);
  if (!verify(fromB64(state.signingPub), body, message.subarray(message.length - 64))) {
    throw new CryptoError("invalid sender key signature");
  }
  let seed: Bytes;
  if (iteration < state.iteration) {
    const idx = state.skipped.findIndex(([i]) => i === iteration);
    if (idx < 0) throw new CryptoError("duplicate or expired group message");
    seed = fromB64(state.skipped[idx][1]);
    state.skipped.splice(idx, 1);
  } else {
    if (iteration - state.iteration > MAX_FORWARD) throw new CryptoError("group message too far in the future");
    let ck = fromB64(state.chainKey);
    while (state.iteration < iteration) {
      const { mkSeed, next } = deriveMessageKey(ck);
      state.skipped.push([state.iteration, toB64(mkSeed)]);
      ck = next;
      state.iteration++;
    }
    if (state.skipped.length > MAX_SKIPPED) state.skipped.splice(0, state.skipped.length - MAX_SKIPPED);
    const { mkSeed, next } = deriveMessageKey(ck);
    seed = mkSeed;
    state.chainKey = toB64(next);
    state.iteration++;
  }
  const { iv, key: aesKey } = messageKeys(seed);
  const plaintext = aesCbcDecrypt(aesKey, iv, body.subarray(25));
  await store.storeSenderKey(key, JSON.stringify(record));
  return unpad(plaintext);
}

