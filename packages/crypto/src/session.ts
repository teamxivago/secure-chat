import { fromB64, fromUtf8, toB64, utf8, type Bytes } from "./bytes";
import { bundleFromWire, type PreKeyBundle, type PreKeyBundleWire } from "./identity";
import { CryptoError } from "./primitives";
import {
  deserializeState,
  initReceiver,
  initSender,
  ratchetDecrypt,
  ratchetEncrypt,
  serializeState,
  type SerializedRatchetState,
} from "./ratchet";
import type { Address, ProtocolStore } from "./store";
import { x3dhInitiate, x3dhRespond } from "./x3dh";

export const MESSAGE_TYPE_WHISPER = 1;
export const MESSAGE_TYPE_PREKEY = 3;
const MAX_PREVIOUS_SESSIONS = 20;
const PAD_BLOCK = 160;

interface SessionState {
  ratchet: SerializedRatchetState;
  baseKey: string; // initiator's X3DH ephemeral public key; identifies the session
  remoteIdentity: string;
  remoteRegistrationId: number;
  pendingPreKey?: { preKeyId?: number; signedPreKeyId: number; baseKey: string };
}

interface SessionRecord {
  current?: SessionState;
  previous: SessionState[];
}

interface PreKeyMessage {
  v: 3;
  registrationId: number;
  preKeyId?: number;
  signedPreKeyId: number;
  baseKey: string;
  identityKey: string;
  message: string;
}

export interface CiphertextMessage {
  type: typeof MESSAGE_TYPE_WHISPER | typeof MESSAGE_TYPE_PREKEY;
  body: Bytes;
  registrationId: number;
}

export class NoSessionError extends CryptoError {
  constructor(address: string) {
    super(`no session for ${address}`);
    this.name = "NoSessionError";
  }
}

export class UntrustedIdentityError extends CryptoError {
  constructor(public userId: string) {
    super(`identity key changed for ${userId}`);
    this.name = "UntrustedIdentityError";
  }
}

/** Signal-style length hiding: pad to a multiple of 160 bytes with 0x80 then 0x00. */
export function pad(p: Bytes): Bytes {
  const len = Math.ceil((p.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(len);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}

export function unpad(p: Bytes): Bytes {
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i] === 0x80) return p.slice(0, i);
    if (p[i] !== 0) break;
  }
  throw new CryptoError("invalid padding");
}

async function loadRecord(store: ProtocolStore, address: Address): Promise<SessionRecord> {
  const raw = await store.loadSession(address);
  return raw ? (JSON.parse(raw) as SessionRecord) : { previous: [] };
}

function promote(record: SessionRecord, state: SessionState) {
  record.previous = record.previous.filter((s) => s.baseKey !== state.baseKey);
  if (record.current && record.current.baseKey !== state.baseKey) record.previous.unshift(record.current);
  record.previous = record.previous.slice(0, MAX_PREVIOUS_SESSIONS);
  record.current = state;
}

export async function hasSession(store: ProtocolStore, address: Address): Promise<boolean> {
  const r = await loadRecord(store, address);
  return !!r.current;
}

/** Builds an outgoing session from a pre-key bundle fetched from the server (X3DH, Alice role). */
export async function processPreKeyBundle(
  store: ProtocolStore,
  address: Address,
  wire: PreKeyBundleWire | PreKeyBundle,
): Promise<{ identityChanged: boolean }> {
  const bundle: PreKeyBundle = typeof (wire as PreKeyBundleWire).identityKey === "string"
    ? bundleFromWire(wire as PreKeyBundleWire)
    : (wire as PreKeyBundle);
  const identity = await store.getIdentityKeyPair();
  const result = x3dhInitiate(identity, bundle);
  const identityChanged = await store.saveRemoteIdentity(address, bundle.identityKey);
  const ratchet = initSender(result.sharedSecret, bundle.signedPreKey.publicKey, result.associatedData);
  const baseKey = toB64(result.baseKey.publicKey);
  const record = await loadRecord(store, address);
  promote(record, {
    ratchet: serializeState(ratchet),
    baseKey,
    remoteIdentity: toB64(bundle.identityKey),
    remoteRegistrationId: bundle.registrationId,
    pendingPreKey: { preKeyId: result.oneTimePreKeyId, signedPreKeyId: result.signedPreKeyId, baseKey },
  });
  await store.storeSession(address, JSON.stringify(record));
  return { identityChanged };
}

export async function encryptMessage(store: ProtocolStore, address: Address, plaintext: Bytes): Promise<CiphertextMessage> {
  const record = await loadRecord(store, address);
  const state = record.current;
  if (!state) throw new NoSessionError(address);
  const ratchet = deserializeState(state.ratchet);
  const body = ratchetEncrypt(ratchet, pad(plaintext));
  state.ratchet = serializeState(ratchet);
  await store.storeSession(address, JSON.stringify(record));
  const registrationId = await store.getLocalRegistrationId();
  if (state.pendingPreKey) {
    const identity = await store.getIdentityKeyPair();
    const msg: PreKeyMessage = {
      v: 3,
      registrationId,
      preKeyId: state.pendingPreKey.preKeyId,
      signedPreKeyId: state.pendingPreKey.signedPreKeyId,
      baseKey: state.pendingPreKey.baseKey,
      identityKey: toB64(identity.publicKey),
      message: toB64(body),
    };
    return { type: MESSAGE_TYPE_PREKEY, body: utf8(JSON.stringify(msg)), registrationId };
  }
  return { type: MESSAGE_TYPE_WHISPER, body, registrationId };
}

function tryStates(record: SessionRecord, body: Bytes, candidates: SessionState[]): { plaintext: Bytes; state: SessionState } | null {
  for (const s of candidates) {
    try {
      const { state, plaintext } = ratchetDecrypt(deserializeState(s.ratchet), body);
      const updated: SessionState = { ...s, ratchet: serializeState(state) };
      delete updated.pendingPreKey; // the remote has a session with us now
      promote(record, updated);
      return { plaintext, state: updated };
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function decryptMessage(
  store: ProtocolStore,
  address: Address,
  type: number,
  body: Bytes,
): Promise<{ plaintext: Bytes; identityChanged: boolean }> {
  const record = await loadRecord(store, address);
  if (type === MESSAGE_TYPE_WHISPER) {
    const candidates = [record.current, ...record.previous].filter(Boolean) as SessionState[];
    if (!candidates.length) throw new NoSessionError(address);
    const r = tryStates(record, body, candidates);
    if (!r) throw new CryptoError("unable to decrypt message with any session");
    await store.storeSession(address, JSON.stringify(record));
    return { plaintext: unpad(r.plaintext), identityChanged: false };
  }
  if (type !== MESSAGE_TYPE_PREKEY) throw new CryptoError("unknown message type");

  const msg = JSON.parse(fromUtf8(body)) as PreKeyMessage;
  if (msg.v !== 3) throw new CryptoError("unsupported pre-key message version");
  const inner = fromB64(msg.message);
  const remoteIdentity = fromB64(msg.identityKey);

  // Existing session built from this same base key (retransmitted pre-key message)?
  const existing = [record.current, ...record.previous].filter((s): s is SessionState => !!s && s.baseKey === msg.baseKey);
  if (existing.length) {
    const r = tryStates(record, inner, existing);
    if (r) {
      await store.storeSession(address, JSON.stringify(record));
      return { plaintext: unpad(r.plaintext), identityChanged: false };
    }
  }

  const identity = await store.getIdentityKeyPair();
  const spk = await store.getSignedPreKey(msg.signedPreKeyId);
  if (!spk) throw new CryptoError("unknown signed pre-key");
  let opk;
  if (msg.preKeyId !== undefined && msg.preKeyId !== null) {
    opk = await store.getOneTimePreKey(msg.preKeyId);
    if (!opk) throw new CryptoError("one-time pre-key already used");
  }
  const { sharedSecret, associatedData } = x3dhRespond(identity, spk.keyPair, opk?.keyPair, remoteIdentity, fromB64(msg.baseKey));
  const ratchet = initReceiver(sharedSecret, spk.keyPair, associatedData);
  const { state, plaintext } = ratchetDecrypt(ratchet, inner);
  const identityChanged = await store.saveRemoteIdentity(address, remoteIdentity);
  promote(record, {
    ratchet: serializeState(state),
    baseKey: msg.baseKey,
    remoteIdentity: msg.identityKey,
    remoteRegistrationId: msg.registrationId,
  });
  await store.storeSession(address, JSON.stringify(record));
  if (opk) await store.removeOneTimePreKey(opk.keyId);
  return { plaintext: unpad(plaintext), identityChanged };
}

export async function sessionRemoteIdentity(store: ProtocolStore, address: Address): Promise<Bytes | undefined> {
  const r = await loadRecord(store, address);
  return r.current ? fromB64(r.current.remoteIdentity) : undefined;
}

