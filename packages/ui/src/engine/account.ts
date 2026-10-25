import {
  createProvisioningKeys,
  decryptProvisioning,
  encryptProvisioning,
  fromB64,
  generateAccountKey,
  generateIdentityKeyPair,
  generateOneTimePreKeys,
  generateRecoveryKey,
  generateRegistrationId,
  generateSignedPreKey,
  hkdf,
  parseProvisioningUri,
  provisioningUri,
  toB64,
  unwrapAccountKey,
  wrapAccountKey,
  type KeyPair,
} from "@veil/crypto";
import { PREKEY_BATCH, PREKEY_LOW_WATERMARK, SIGNED_PREKEY_ROTATION_MS } from "@veil/shared";
import { kvGet, kvSet, wipeAll } from "../lib/db";
import { deviceName, platform } from "../lib/platform";
import { bus } from "./bus";
import { ctx } from "./context";

/* ------------------------------ session bootstrap ------------------------------ */

export async function loadConfig() {
  if (!ctx.config) ctx.config = await ctx.api.config();
  return ctx.config;
}

/** Called after a successful OTP / OAuth sign-in with the session token. */
export async function completeSignIn(token: string) {
  const prevUser = ctx.account?.userId;
  ctx.account = { userId: "", deviceId: null, token, status: null };
  const me = await ctx.api.me.get();
  if (prevUser && prevUser !== me.id) {
    // A different account on this device: never mix key material.
    await wipeAll();
  }
  ctx.account = { userId: me.id, deviceId: null, token, status: null };
  ctx.me = me;
  await kvSet("me", me);
  await ctx.saveAccount();
  await ensureDevice();
  bus.emit("account:changed", undefined);
}

/** Generates this device's Signal identity + pre-keys and registers the public halves. */
export async function ensureDevice() {
  const store = ctx.store;
  if (ctx.account?.deviceId && (await store.hasLocalIdentity())) return;
  const identity = generateIdentityKeyPair();
  const registrationId = generateRegistrationId();
  await store.setLocalIdentity(identity, registrationId);
  const spk = generateSignedPreKey(identity, 1);
  await store.storeSignedPreKey(spk);
  const otpks = generateOneTimePreKeys(1, PREKEY_BATCH);
  await store.storeOneTimePreKeys(otpks);
  await kvSet("otpk:next", PREKEY_BATCH + 1);
  await kvSet("spk:current", { keyId: 1, createdAt: Date.now() });
  const r = await ctx.api.devices.register({
    name: deviceName(),
    platform: platform(),
    registrationId,
    identityKey: toB64(identity.publicKey),
    signedPreKey: { keyId: spk.keyId, publicKey: toB64(spk.keyPair.publicKey), signature: toB64(spk.signature) },
    oneTimePreKeys: otpks.map((k) => ({ keyId: k.keyId, publicKey: toB64(k.keyPair.publicKey) })),
  });
  ctx.account!.deviceId = r.deviceId;
  ctx.account!.status = r.status;
  await ctx.saveAccount();
  await kvSet("device:registration", r);
  if (r.status === "active" && !ctx.accountKey) {
    // Brand-new account: this device creates the Account Storage Key.
    await setAccountKey(generateAccountKey());
  }
}

export async function setAccountKey(ask: Uint8Array) {
  ctx.accountKey = ask;
  await kvSet("ask", ask);
}

export const accountKeyVerifier = (ask: Uint8Array) => toB64(hkdf(ask, undefined, "Veil_ASK_Verifier", 32));

export async function refreshMe() {
  ctx.me = await ctx.api.me.get();
  await kvSet("me", ctx.me);
  bus.emit("account:changed", undefined);
  return ctx.me;
}

/* ------------------------------ device linking ------------------------------ */

export interface LinkSession {
  linkId: string;
  code: string;
  uri: string;
  keys: KeyPair;
  expiresAt: number;
}

/** Pending device: create a link request; render `uri` as a QR code. */
export async function startLinking(): Promise<LinkSession> {
  const keys = createProvisioningKeys();
  const r = await ctx.api.devices.requestLink(toB64(keys.publicKey));
  return { linkId: r.linkId, code: r.code, uri: provisioningUri(r.linkId, keys.publicKey), keys, expiresAt: r.expiresAt };
}

/** Pending device: fetch + decrypt the provisioning payload once approved. Returns true when linked. */
export async function pollLinking(s: LinkSession): Promise<"waiting" | "approved" | "rejected"> {
  const r = await ctx.api.devices.linkStatus(s.linkId);
  if (r.status === "rejected") return "rejected";
  if (r.status !== "approved" || !r.ephemeralKey || !r.ciphertext) return "waiting";
  const payload = decryptProvisioning(s.keys, r.ephemeralKey, r.ciphertext);
  if (payload.userId !== ctx.userId) throw new Error("provisioning payload for a different account");
  await setAccountKey(fromB64(payload.accountKey));
  ctx.account!.status = "active";
  await ctx.saveAccount();
  bus.emit("account:changed", undefined);
  return "approved";
}

/** Active device: approve a new device from its scanned QR code. */
export async function approveLinkFromUri(uri: string) {
  const { linkId, publicKey } = parseProvisioningUri(uri);
  await approveLink(linkId, publicKey);
}

export async function approveLink(linkId: string, publicKey: Uint8Array) {
  if (!ctx.accountKey) throw new Error("this device has no account key");
  const blob = encryptProvisioning(publicKey, { accountKey: toB64(ctx.accountKey), userId: ctx.userId, approvedBy: ctx.deviceId });
  await ctx.api.devices.approveLink(linkId, blob.ephemeralKey, blob.ciphertext);
}

/** Restores the account key from the recovery key and activates this device. */
export async function recoverWithKey(recoveryKey: string) {
  const { wrapped } = await ctx.api.me.getAccountKeyBackup();
  if (!wrapped) throw new Error("No recovery backup exists for this account");
  let ask: Uint8Array;
  try {
    // Accept the key with or without separators; it was wrapped in its canonical dashed form.
    const canonical = (recoveryKey.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,4}/g) ?? []).join("-");
    ask = unwrapAccountKey(wrapped, canonical);
  } catch {
    throw new Error("Recovery key is incorrect");
  }
  await ctx.api.devices.activate({ mode: "recovery", verifier: accountKeyVerifier(ask) });
  await setAccountKey(ask);
  ctx.account!.status = "active";
  await ctx.saveAccount();
  bus.emit("account:changed", undefined);
}

/** Starts fresh: logs out other devices and discards undecryptable history. */
export async function startFresh() {
  await ctx.api.devices.activate({ mode: "fresh" });
  await setAccountKey(generateAccountKey());
  ctx.account!.status = "active";
  await ctx.saveAccount();
  bus.emit("account:changed", undefined);
}

/** Creates (or rotates) the recovery key. Returns the human-readable key to show once. */
export async function createRecoveryKey(): Promise<string> {
  if (!ctx.accountKey) throw new Error("no account key");
  const key = generateRecoveryKey();
  const wrapped = wrapAccountKey(ctx.accountKey, key);
  await ctx.api.me.putAccountKeyBackup(wrapped, accountKeyVerifier(ctx.accountKey));
  return key;
}

/* ------------------------------ key maintenance ------------------------------ */

export async function maintainKeys() {
  if (!ctx.active) return;
  const status = await ctx.api.keys.status();
  const store = ctx.store;
  const body: { signedPreKey?: unknown; oneTimePreKeys?: unknown } = {};
  if (status.oneTimePreKeys < PREKEY_LOW_WATERMARK) {
    const next = (await kvGet<number>("otpk:next")) ?? 1;
    const keys = generateOneTimePreKeys(next, PREKEY_BATCH);
    await store.storeOneTimePreKeys(keys);
    await kvSet("otpk:next", next + PREKEY_BATCH);
    body.oneTimePreKeys = keys.map((k) => ({ keyId: k.keyId, publicKey: toB64(k.keyPair.publicKey) }));
  }
  const cur = await kvGet<{ keyId: number; createdAt: number }>("spk:current");
  if (!cur || Date.now() - cur.createdAt > SIGNED_PREKEY_ROTATION_MS) {
    const identity = await store.getIdentityKeyPair();
    const keyId = ((cur?.keyId ?? 0) % 0xffffff) + 1;
    const spk = generateSignedPreKey(identity, keyId);
    await store.storeSignedPreKey(spk);
    await kvSet("spk:current", { keyId, createdAt: spk.createdAt });
    // Keep the previous signed pre-key for in-flight session initiations.
    await store.pruneSignedPreKeys([keyId, cur?.keyId ?? keyId]);
    body.signedPreKey = { keyId, publicKey: toB64(spk.keyPair.publicKey), signature: toB64(spk.signature) };
  }
  if (body.signedPreKey || body.oneTimePreKeys) await ctx.api.keys.upload(body);
}

/* ------------------------------ sign out ------------------------------ */

export async function signOut(opts: { remote?: boolean } = { remote: true }) {
  if (opts.remote) {
    try {
      if (ctx.account?.deviceId) await ctx.api.devices.terminate("current");
      else await ctx.api.auth.signOut();
    } catch {
      /* already gone */
    }
  }
  ctx.account = null;
  ctx.me = null;
  ctx.accountKey = null;
  await wipeAll();
  try {
    localStorage.removeItem("veil:lock");
  } catch {
    /* noop */
  }
  bus.emit("account:changed", undefined);
}

