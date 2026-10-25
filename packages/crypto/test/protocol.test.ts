import { describe, expect, it } from "vitest";
import {
  MemoryProtocolStore,
  generateIdentityKeyPair,
  generateRegistrationId,
  generateSignedPreKey,
  generateOneTimePreKeys,
  processPreKeyBundle,
  encryptMessage,
  decryptMessage,
  MESSAGE_TYPE_PREKEY,
  MESSAGE_TYPE_WHISPER,
  utf8,
  fromUtf8,
  type PreKeyBundle,
  issueSenderCertificate,
  generateSigningKeyPair,
  sealedSenderEncrypt,
  sealedSenderDecrypt,
  toB64,
  createSenderKey,
  processSenderKeyDistribution,
  groupEncrypt,
  groupDecrypt,
  newDistributionId,
  encryptBuffer,
  decryptBuffer,
  generateMediaKey,
  encryptedSize,
  MEDIA_CHUNK_SIZE,
  generateAccountKey,
  vaultSeal,
  vaultOpen,
  createProvisioningKeys,
  encryptProvisioning,
  decryptProvisioning,
  provisioningUri,
  parseProvisioningUri,
  blindContacts,
  finalizeContacts,
  generateDiscoveryKey,
  evaluateBlinded,
  discoveryToken,
  normalizePhone,
  safetyNumber,
  CryptoError,
} from "../src/index";

function makeDevice(userId: string, deviceId: string) {
  const identity = generateIdentityKeyPair();
  const store = new MemoryProtocolStore(identity, generateRegistrationId());
  const spk = generateSignedPreKey(identity, 1);
  store.signedPreKeys.set(1, spk);
  for (const k of generateOneTimePreKeys(1, 5)) store.oneTimePreKeys.set(k.keyId, k);
  const bundle = (withOpk = true): PreKeyBundle => {
    const opk = withOpk ? [...store.oneTimePreKeys.values()][0] : undefined;
    return {
      registrationId: store.registrationId,
      deviceId,
      identityKey: identity.publicKey,
      signedPreKey: { keyId: spk.keyId, publicKey: spk.keyPair.publicKey, signature: spk.signature },
      oneTimePreKey: opk ? { keyId: opk.keyId, publicKey: opk.keyPair.publicKey } : undefined,
    };
  };
  return { userId, deviceId, address: `${userId}.${deviceId}`, identity, store, bundle };
}

describe("X3DH + Double Ratchet", () => {
  it("establishes a session and exchanges messages in both directions", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    await processPreKeyBundle(alice.store, bob.address, bob.bundle());

    const m1 = await encryptMessage(alice.store, bob.address, utf8("hello bob"));
    expect(m1.type).toBe(MESSAGE_TYPE_PREKEY);
    const r1 = await decryptMessage(bob.store, alice.address, m1.type, m1.body);
    expect(fromUtf8(r1.plaintext)).toBe("hello bob");
    expect(bob.store.oneTimePreKeys.size).toBe(4); // one-time pre-key consumed

    const m2 = await encryptMessage(bob.store, alice.address, utf8("hi alice"));
    expect(m2.type).toBe(MESSAGE_TYPE_WHISPER);
    expect(fromUtf8((await decryptMessage(alice.store, bob.address, m2.type, m2.body)).plaintext)).toBe("hi alice");

    // after a reply alice stops sending pre-key messages
    const m3 = await encryptMessage(alice.store, bob.address, utf8("how are you"));
    expect(m3.type).toBe(MESSAGE_TYPE_WHISPER);
    expect(fromUtf8((await decryptMessage(bob.store, alice.address, m3.type, m3.body)).plaintext)).toBe("how are you");
  });

  it("handles out-of-order and lost messages across ratchet steps", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    await processPreKeyBundle(alice.store, bob.address, bob.bundle(false));
    const first = await encryptMessage(alice.store, bob.address, utf8("0"));
    await decryptMessage(bob.store, alice.address, first.type, first.body);
    const reply = await encryptMessage(bob.store, alice.address, utf8("r"));
    await decryptMessage(alice.store, bob.address, reply.type, reply.body);

    const msgs = [];
    for (let i = 1; i <= 6; i++) msgs.push(await encryptMessage(alice.store, bob.address, utf8(String(i))));
    const order = [5, 0, 3, 1, 4, 2];
    for (const i of order) {
      const r = await decryptMessage(bob.store, alice.address, msgs[i].type, msgs[i].body);
      expect(fromUtf8(r.plaintext)).toBe(String(i + 1));
    }
    // replay is rejected
    await expect(decryptMessage(bob.store, alice.address, msgs[0].type, msgs[0].body)).rejects.toThrow();
  });

  it("rejects tampered ciphertext without corrupting session state", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    await processPreKeyBundle(alice.store, bob.address, bob.bundle());
    const m1 = await encryptMessage(alice.store, bob.address, utf8("a"));
    await decryptMessage(bob.store, alice.address, m1.type, m1.body);
    const r = await encryptMessage(bob.store, alice.address, utf8("b"));
    await decryptMessage(alice.store, bob.address, r.type, r.body);
    const m2 = await encryptMessage(alice.store, bob.address, utf8("secret"));
    const bad = m2.body.slice();
    bad[bad.length - 20] ^= 1;
    await expect(decryptMessage(bob.store, alice.address, m2.type, bad)).rejects.toThrow();
    expect(fromUtf8((await decryptMessage(bob.store, alice.address, m2.type, m2.body)).plaintext)).toBe("secret");
  });

  it("recovers from simultaneous session initiation", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    await processPreKeyBundle(alice.store, bob.address, bob.bundle());
    await processPreKeyBundle(bob.store, alice.address, alice.bundle());
    const ma = await encryptMessage(alice.store, bob.address, utf8("from a"));
    const mb = await encryptMessage(bob.store, alice.address, utf8("from b"));
    expect(fromUtf8((await decryptMessage(bob.store, alice.address, ma.type, ma.body)).plaintext)).toBe("from a");
    expect(fromUtf8((await decryptMessage(alice.store, bob.address, mb.type, mb.body)).plaintext)).toBe("from b");
    const ma2 = await encryptMessage(alice.store, bob.address, utf8("again"));
    expect(fromUtf8((await decryptMessage(bob.store, alice.address, ma2.type, ma2.body)).plaintext)).toBe("again");
  });

  it("detects a forged signed pre-key", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    const b = bob.bundle();
    b.signedPreKey.signature = b.signedPreKey.signature.slice();
    b.signedPreKey.signature[0] ^= 1;
    await expect(processPreKeyBundle(alice.store, bob.address, b)).rejects.toThrow(CryptoError);
  });

  it("produces symmetric safety numbers", () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const n1 = safetyNumber("a", a.publicKey, "b", b.publicKey);
    expect(n1).toHaveLength(60);
    expect(safetyNumber("b", b.publicKey, "a", a.publicKey)).toBe(n1);
  });
});

describe("sealed sender", () => {
  it("hides the sender and authenticates the certificate", async () => {
    const server = generateSigningKeyPair();
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    const cert = issueSenderCertificate(server, {
      userId: "alice",
      deviceId: "a1",
      identityKey: toB64(alice.identity.publicKey),
      expires: Date.now() + 60000,
    });
    const sealed = sealedSenderEncrypt(alice.identity, cert, bob.identity.publicKey, 1, utf8("inner"));
    expect(new TextDecoder().decode(sealed)).not.toContain("alice");
    const r = sealedSenderDecrypt(bob.identity, server.publicKey, sealed);
    expect(r.senderUserId).toBe("alice");
    expect(fromUtf8(r.body)).toBe("inner");

    const mallory = makeDevice("mallory", "m1");
    const forged = sealedSenderEncrypt(mallory.identity, cert, bob.identity.publicKey, 1, utf8("x"));
    expect(() => sealedSenderDecrypt(bob.identity, server.publicKey, forged)).toThrow();
    expect(() => sealedSenderDecrypt(bob.identity, generateSigningKeyPair().publicKey, sealed)).toThrow();
  });
});

describe("sender keys", () => {
  it("encrypts once for many recipients, tolerates gaps and rotation", async () => {
    const alice = makeDevice("alice", "a1");
    const bob = makeDevice("bob", "b1");
    const carol = makeDevice("carol", "c1");
    const dist = newDistributionId();
    const skdm = await createSenderKey(alice.store, "g1", alice.address, dist);
    await processSenderKeyDistribution(bob.store, "g1", alice.address, skdm);
    await processSenderKeyDistribution(carol.store, "g1", alice.address, skdm);

    const c1 = await groupEncrypt(alice.store, "g1", alice.address, dist, utf8("one"));
    const c2 = await groupEncrypt(alice.store, "g1", alice.address, dist, utf8("two"));
    const c3 = await groupEncrypt(alice.store, "g1", alice.address, dist, utf8("three"));
    expect(fromUtf8(await groupDecrypt(bob.store, "g1", alice.address, c3))).toBe("three");
    expect(fromUtf8(await groupDecrypt(bob.store, "g1", alice.address, c1))).toBe("one");
    expect(fromUtf8(await groupDecrypt(carol.store, "g1", alice.address, c2))).toBe("two");
    await expect(groupDecrypt(bob.store, "g1", alice.address, c1)).rejects.toThrow();

    // rotation: new chain, old members re-keyed, removed member can't read
    const skdm2 = await createSenderKey(alice.store, "g1", alice.address, dist);
    await processSenderKeyDistribution(bob.store, "g1", alice.address, skdm2);
    const c4 = await groupEncrypt(alice.store, "g1", alice.address, dist, utf8("after rotation"));
    expect(fromUtf8(await groupDecrypt(bob.store, "g1", alice.address, c4))).toBe("after rotation");
    await expect(groupDecrypt(carol.store, "g1", alice.address, c4)).rejects.toThrow();

    const tampered = c4.slice();
    tampered[30] ^= 1;
    await expect(groupDecrypt(bob.store, "g1", alice.address, tampered)).rejects.toThrow();
  });
});

describe("media encryption", () => {
  it("round-trips multi-chunk files and detects truncation", async () => {
    const key = generateMediaKey();
    const data = new Uint8Array(MEDIA_CHUNK_SIZE * 2 + 12345);
    for (let i = 0; i < data.length; i += 4096) data[i] = i & 0xff;
    const enc = await encryptBuffer(key, data);
    expect(enc.length).toBe(encryptedSize(data.length));
    const dec = await decryptBuffer(key, enc);
    expect(dec.length).toBe(data.length);
    expect(dec[4096 * 3]).toBe(data[4096 * 3]);
    await expect(decryptBuffer(key, enc.subarray(0, enc.length - 12401))).rejects.toThrow();
    const small = await encryptBuffer(key, utf8("tiny"));
    expect(small.length).toBe(encryptedSize(4));
    expect(fromUtf8(await decryptBuffer(key, small))).toBe("tiny");
    expect(encryptedSize(MEDIA_CHUNK_SIZE)).toBe((await encryptBuffer(key, new Uint8Array(MEDIA_CHUNK_SIZE))).length);
  });
});

describe("vault, provisioning, discovery", () => {
  it("vault records are bound to kind and id", () => {
    const ask = generateAccountKey();
    const sealed = vaultSeal(ask, "msg", "m1", { text: "hi" });
    expect(vaultOpen<{ text: string }>(ask, "msg", "m1", sealed).text).toBe("hi");
    expect(() => vaultOpen(ask, "msg", "m2", sealed)).toThrow();
    expect(() => vaultOpen(generateAccountKey(), "msg", "m1", sealed)).toThrow();
  });

  it("provisions a new device through the QR flow", () => {
    const keys = createProvisioningKeys();
    const uri = provisioningUri("link-1", keys.publicKey);
    const parsed = parseProvisioningUri(uri);
    const blob = encryptProvisioning(parsed.publicKey, { accountKey: "QUJD", userId: "u", approvedBy: "d1" });
    expect(decryptProvisioning(keys, blob.ephemeralKey, blob.ciphertext).accountKey).toBe("QUJD");
    expect(() => decryptProvisioning(createProvisioningKeys(), blob.ephemeralKey, blob.ciphertext)).toThrow();
  });

  it("matches contacts via OPRF without revealing numbers", () => {
    const sk = generateDiscoveryKey();
    const registered = discoveryToken(sk, "+15551234567");
    const blinded = blindContacts(["+15551234567", "+15550000000"]);
    const evaluated = blinded.map((b) => evaluateBlinded(sk, b.blinded));
    const tokens = finalizeContacts(blinded, evaluated);
    expect(tokens.get(registered)).toBe("+15551234567");
    expect([...tokens.keys()].filter((t) => t === registered)).toHaveLength(1);
    expect(normalizePhone("(555) 123-4567", "1")).toBe("+15551234567");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
  });
});
