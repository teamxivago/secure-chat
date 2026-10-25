import type { Bytes, IdentityKeyPair, OneTimePreKey, ProtocolStore, SignedPreKey } from "@veil/crypto";
import { equal } from "@veil/crypto";
import { kvDel, kvGet, kvKeys, kvSet } from "../lib/db";

/** ProtocolStore over the encrypted IndexedDB key/value store. Private keys never leave the device. */
export class IdbProtocolStore implements ProtocolStore {
  private cache = new Map<string, unknown>();

  private async get<T>(k: string): Promise<T | undefined> {
    if (this.cache.has(k)) return this.cache.get(k) as T;
    const v = await kvGet<T>(k);
    if (v !== undefined) this.cache.set(k, v);
    return v;
  }
  private async set(k: string, v: unknown) {
    this.cache.set(k, v);
    await kvSet(k, v);
  }
  private async del(k: string) {
    this.cache.delete(k);
    await kvDel(k);
  }

  async getIdentityKeyPair() {
    const s = await this.get<{ identity: IdentityKeyPair }>("id:self");
    if (!s) throw new Error("no local identity");
    return s.identity;
  }
  async getLocalRegistrationId() {
    const s = await this.get<{ registrationId: number }>("id:self");
    if (!s) throw new Error("no local identity");
    return s.registrationId;
  }
  async setLocalIdentity(identity: IdentityKeyPair, registrationId: number) {
    await this.set("id:self", { identity, registrationId });
  }
  async hasLocalIdentity() {
    return !!(await this.get("id:self"));
  }

  getSignedPreKey(id: number) {
    return this.get<SignedPreKey>(`spk:${id}`);
  }
  async storeSignedPreKey(k: SignedPreKey) {
    await this.set(`spk:${k.keyId}`, k);
  }
  async pruneSignedPreKeys(keep: number[]) {
    for (const k of await kvKeys("spk:")) if (!keep.includes(Number(k.slice(4)))) await this.del(k);
  }

  getOneTimePreKey(id: number) {
    return this.get<OneTimePreKey>(`otpk:${id}`);
  }
  async storeOneTimePreKeys(keys: OneTimePreKey[]) {
    for (const k of keys) await this.set(`otpk:${k.keyId}`, k);
  }
  async removeOneTimePreKey(id: number) {
    await this.del(`otpk:${id}`);
  }

  loadSession(a: string) {
    return this.get<string>(`sess:${a}`);
  }
  async storeSession(a: string, r: string) {
    await this.set(`sess:${a}`, r);
  }
  async removeSession(a: string) {
    await this.del(`sess:${a}`);
  }
  async sessionAddresses(userId: string): Promise<string[]> {
    return (await kvKeys(`sess:${userId}.`)).map((k) => k.slice(5));
  }

  /** Identity keys are tracked per device address (each device has its own identity). */
  getRemoteIdentity(address: string) {
    return this.get<Bytes>(`rid:${address}`);
  }
  async saveRemoteIdentity(address: string, key: Bytes) {
    const prev = await this.get<Bytes>(`rid:${address}`);
    await this.set(`rid:${address}`, key);
    return !!prev && !equal(prev, key);
  }
  async knownIdentities(userId: string): Promise<Bytes[]> {
    const keys = await kvKeys(`rid:${userId}.`);
    return (await Promise.all(keys.map((k) => this.get<Bytes>(k)))).filter(Boolean) as Bytes[];
  }

  loadSenderKey(k: string) {
    return this.get<string>(`sk:${k}`);
  }
  async storeSenderKey(k: string, r: string) {
    await this.set(`sk:${k}`, r);
  }
}
