import type { Bytes } from "./bytes";
import type { IdentityKeyPair, OneTimePreKey, SignedPreKey } from "./identity";

/** Remote device address: "<userId>.<deviceId>". */
export type Address = string;
export const makeAddress = (userId: string, deviceId: string): Address => `${userId}.${deviceId}`;
export function parseAddress(a: Address): { userId: string; deviceId: string } {
  const i = a.lastIndexOf(".");
  return { userId: a.slice(0, i), deviceId: a.slice(i + 1) };
}

/**
 * Persistent storage contract for all key material. Implementations: IndexedDB (client)
 * and in-memory (tests). Private keys never leave the implementing device.
 */
export interface ProtocolStore {
  getIdentityKeyPair(): Promise<IdentityKeyPair>;
  getLocalRegistrationId(): Promise<number>;

  getSignedPreKey(keyId: number): Promise<SignedPreKey | undefined>;
  getOneTimePreKey(keyId: number): Promise<OneTimePreKey | undefined>;
  removeOneTimePreKey(keyId: number): Promise<void>;

  loadSession(address: Address): Promise<string | undefined>;
  storeSession(address: Address, record: string): Promise<void>;
  removeSession(address: Address): Promise<void>;

  /** Returns the previously stored identity key for this device address, if any. */
  getRemoteIdentity(address: Address): Promise<Bytes | undefined>;
  /** Stores a device's identity key. Returns true if it replaced a different key (safety number changed). */
  saveRemoteIdentity(address: Address, identityKey: Bytes): Promise<boolean>;

  loadSenderKey(key: string): Promise<string | undefined>;
  storeSenderKey(key: string, record: string): Promise<void>;
}

export class MemoryProtocolStore implements ProtocolStore {
  sessions = new Map<string, string>();
  identities = new Map<string, Bytes>();
  senderKeys = new Map<string, string>();
  signedPreKeys = new Map<number, SignedPreKey>();
  oneTimePreKeys = new Map<number, OneTimePreKey>();
  constructor(
    public identity: IdentityKeyPair,
    public registrationId: number,
  ) {}
  async getIdentityKeyPair() {
    return this.identity;
  }
  async getLocalRegistrationId() {
    return this.registrationId;
  }
  async getSignedPreKey(id: number) {
    return this.signedPreKeys.get(id);
  }
  async getOneTimePreKey(id: number) {
    return this.oneTimePreKeys.get(id);
  }
  async removeOneTimePreKey(id: number) {
    this.oneTimePreKeys.delete(id);
  }
  async loadSession(a: Address) {
    return this.sessions.get(a);
  }
  async storeSession(a: Address, r: string) {
    this.sessions.set(a, r);
  }
  async removeSession(a: Address) {
    this.sessions.delete(a);
  }
  async getRemoteIdentity(u: string) {
    return this.identities.get(u);
  }
  async saveRemoteIdentity(u: string, k: Bytes) {
    const prev = this.identities.get(u);
    this.identities.set(u, k);
    return !!prev && !prev.every((b, i) => b === k[i]);
  }
  async loadSenderKey(k: string) {
    return this.senderKeys.get(k);
  }
  async storeSenderKey(k: string, r: string) {
    this.senderKeys.set(k, r);
  }
}
