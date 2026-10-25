import {
  encryptMessage,
  fromB64,
  NoSessionError,
  processPreKeyBundle,
  sealedSenderEncrypt,
  sessionRemoteIdentity,
  toB64,
  type SenderCertificate,
} from "@veil/crypto";
import { ENVELOPE_SEALED, type EventPayload, type MessagePayload, type OutgoingEnvelope, type SendResult } from "@veil/shared";
import { kvDel, kvGet, kvSet } from "../lib/db";
import type { DeviceAddress } from "../lib/types";
import { bus } from "./bus";
import { ctx } from "./context";
import { request } from "./transport";
import { trace } from "../lib/trace";

/**
 * Pairwise (1:1) delivery. Every message is Double-Ratchet encrypted separately for each of the
 * recipient's devices and each of our own other devices, then wrapped in sealed sender so the
 * server can't tell who sent it.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);

async function senderCertificate(): Promise<SenderCertificate> {
  const cached = await kvGet<{ cert: SenderCertificate; expires: number }>("cert");
  if (cached && cached.expires - Date.now() > 3600_000) return cached.cert;
  const { certificate } = await ctx.api.keys.certificate();
  const body = JSON.parse(new TextDecoder().decode(fromB64(certificate.body))) as { expires: number };
  await kvSet("cert", { cert: certificate, expires: body.expires });
  return certificate;
}

export async function knownDevices(userId: string): Promise<DeviceAddress[] | undefined> {
  return kvGet<DeviceAddress[]>(`devs:${userId}`);
}

async function saveDevices(userId: string, list: DeviceAddress[]) {
  await kvSet(`devs:${userId}`, list);
}

/** Fetches pre-key bundles (all devices, or one) and builds sessions. */
async function fetchAndBuild(userId: string, deviceId?: string): Promise<DeviceAddress[]> {
  const { bundles } = await ctx.api.keys.bundles(userId, deviceId);
  const built: DeviceAddress[] = [];
  for (const b of bundles) {
    const addr = `${userId}.${b.deviceId}`;
    const { identityChanged } = await processPreKeyBundle(ctx.store, addr, b);
    if (identityChanged) bus.emit("identity:changed", { userId });
    built.push({ userId, deviceId: b.deviceId, registrationId: b.registrationId, identityKey: b.identityKey });
  }
  return built;
}

async function devicesFor(userId: string): Promise<DeviceAddress[]> {
  const cached = await knownDevices(userId);
  if (cached) return cached;
  const list = await fetchAndBuild(userId);
  await saveDevices(userId, list);
  return list;
}

export async function invalidateDevices(userId: string) {
  await kvDel(`devs:${userId}`);
}

async function encryptForDevice(d: DeviceAddress, plaintext: Uint8Array, cert: SenderCertificate): Promise<OutgoingEnvelope> {
  const addr = `${d.userId}.${d.deviceId}`;
  let ct;
  try {
    ct = await encryptMessage(ctx.store, addr, plaintext);
  } catch (e) {
    if (!(e instanceof NoSessionError)) throw e;
    const [rebuilt] = await fetchAndBuild(d.userId, d.deviceId);
    if (!rebuilt) throw e;
    ct = await encryptMessage(ctx.store, addr, plaintext);
  }
  const identity = await ctx.store.getIdentityKeyPair();
  const remoteIdentity = (await sessionRemoteIdentity(ctx.store, addr)) ?? fromB64(d.identityKey!);
  const sealed = sealedSenderEncrypt(identity, cert, remoteIdentity, ct.type, ct.body);
  return { userId: d.userId, deviceId: d.deviceId, registrationId: d.registrationId, type: ENVELOPE_SEALED, content: toB64(sealed) };
}

export interface DirectSendOptions {
  ephemeral?: boolean;
  push?: "message" | "reaction" | "silent" | "call";
  /** Include our own other devices (sync). Default true. */
  includeSelf?: boolean;
  /** Payload variant for our own devices (sync transcript). */
  selfPayload?: EventPayload | MessagePayload | null;
}

/**
 * Sends a payload to every device of the given users (plus our own other devices).
 * Handles server-reported device-list mismatches by fetching/removing sessions and retrying.
 */
export async function sendToUsers(userIds: string[], payload: EventPayload | MessagePayload, opts: DirectSendOptions = {}): Promise<number> {
  const me = ctx.userId;
  const recipients = [...new Set(userIds.filter((u) => u !== me))];
  const includeSelf = opts.includeSelf !== false;
  const body = utf8(JSON.stringify(payload));
  const selfBody = opts.selfPayload === null ? null : utf8(JSON.stringify(opts.selfPayload ?? payload));
  const cert = await senderCertificate();

  for (let attempt = 0; attempt < 4; attempt++) {
    const envelopes: OutgoingEnvelope[] = [];
    for (const u of recipients) {
      for (const d of await devicesFor(u)) envelopes.push(await encryptForDevice(d, body, cert));
    }
    if (includeSelf && selfBody) {
      for (const d of (await devicesFor(me)).filter((d) => d.deviceId !== ctx.deviceId)) envelopes.push(await encryptForDevice(d, selfBody, cert));
    }
    if (!envelopes.length) {
      if (recipients.length) throw new Error("recipient has no active devices");
      return Date.now(); // no other own devices to sync; cache is invalidated on devices:changed
    }
    trace("direct:encrypted", { n: envelopes.length });
    const res = await request<SendResult>("send", { messages: envelopes, sealed: true, ephemeral: !!opts.ephemeral, push: opts.push ?? "message" }).catch(
      (e) => ({ ok: false, error: (e as Error).message }) as SendResult,
    );
    trace("direct:acked", res.ok);
    if (res.ok) return res.ts;
    if (res.error === "mismatched" && "missing" in res) {
      const byUser = new Map<string, DeviceAddress[]>();
      const get = async (u: string) => byUser.get(u) ?? (await knownDevices(u)) ?? [];
      for (const x of res.extra) {
        const list = (await get(x.userId)).filter((d) => d.deviceId !== x.deviceId);
        byUser.set(x.userId, list);
        await ctx.store.removeSession(`${x.userId}.${x.deviceId}`);
      }
      for (const x of res.missing) {
        const list = await get(x.userId);
        const built = await fetchAndBuild(x.userId, x.deviceId);
        byUser.set(x.userId, [...list.filter((d) => d.deviceId !== x.deviceId), ...built]);
      }
      for (const [u, list] of byUser) await saveDevices(u, list);
      continue;
    }
    if (res.error === "stale" && "stale" in res) {
      for (const x of res.stale) {
        await ctx.store.removeSession(`${x.userId}.${x.deviceId}`);
        const list = ((await knownDevices(x.userId)) ?? []).filter((d) => d.deviceId !== x.deviceId);
        await saveDevices(x.userId, [...list, ...(await fetchAndBuild(x.userId, x.deviceId))]);
      }
      continue;
    }
    throw new Error(res.error);
  }
  throw new Error("could not reconcile device list");
}

/** Sends to an explicit set of devices of ONE user (e.g. sender-key distribution, call signaling). */
export async function encryptToDevice(userId: string, deviceId: string, payload: EventPayload): Promise<string> {
  const cert = await senderCertificate();
  let list = (await knownDevices(userId)) ?? [];
  let d = list.find((x) => x.deviceId === deviceId);
  if (!d) {
    const built = await fetchAndBuild(userId, deviceId);
    d = built[0];
    if (!d) throw new Error("device unavailable");
    list = [...list.filter((x) => x.deviceId !== deviceId), d];
    await saveDevices(userId, list);
  }
  return (await encryptForDevice(d, utf8(JSON.stringify(payload)), cert)).content;
}
