import {
  createSenderKey,
  fromB64,
  getOwnDistribution,
  groupDecrypt,
  groupEncrypt,
  groupMessageDistributionId,
  newDistributionId,
  NoSenderKeyError,
  processSenderKeyDistribution,
  toB64,
  type SenderKeyDistribution,
} from "@veil/crypto";
import type { EventPayload, GroupMessageWire, MessagePayload } from "@veil/shared";
import { getChat, kvDel, kvGet, kvSet } from "../lib/db";
import { ctx } from "./context";
import { knownDevices, sendToUsers } from "./direct";
import { emit, request } from "./transport";

/**
 * Group & channel encryption with Sender Keys. Each of our devices owns one sending chain per
 * chat (per key epoch). The chain is distributed to every member device over pairwise
 * Double-Ratchet sessions; messages are then encrypted once and fanned out by the server.
 * The server sees an opaque distribution id, never who is behind it.
 */

interface OwnKey {
  distributionId: string;
  epoch: number;
}

const enc = (s: string) => new TextEncoder().encode(s);
const deviceCache = new Map<string, { at: number; devices: { userId: string; deviceId: string }[] }>();

export function invalidateMemberDevices(chatId?: string) {
  if (chatId) deviceCache.delete(chatId);
  else deviceCache.clear();
}

async function memberDevices(chatId: string) {
  const hit = deviceCache.get(chatId);
  if (hit && Date.now() - hit.at < 60_000) return hit.devices;
  const devices: { userId: string; deviceId: string }[] = [];
  let after: string | undefined;
  do {
    const page = await ctx.api.chats.devices(chatId, after ? { after } : {});
    devices.push(...page.devices);
    after = page.next ?? undefined;
  } while (after);
  deviceCache.set(chatId, { at: Date.now(), devices });
  return devices;
}

async function ownKey(chatId: string): Promise<OwnKey> {
  const epoch = (await getChat(chatId))?.summary?.keyEpoch ?? 0;
  let own = await kvGet<OwnKey>(`skown:${chatId}`);
  if (!own || own.epoch < epoch) {
    const distributionId = newDistributionId();
    await createSenderKey(ctx.store, chatId, ctx.selfAddress, distributionId);
    own = { distributionId, epoch };
    await kvSet(`skown:${chatId}`, own);
    await kvSet(`skmap:${chatId}:${distributionId}`, ctx.selfAddress);
    await kvDel(`skdist:${chatId}`);
  }
  return own;
}

/** Forces a new sending chain (admin rotation or after membership changes). */
export async function rotateOwnKey(chatId: string) {
  await kvDel(`skown:${chatId}`);
  invalidateMemberDevices(chatId);
}

/** Sends our current chain state to member devices that don't have it yet. */
export async function ensureDistributed(chatId: string): Promise<OwnKey> {
  const own = await ownKey(chatId);
  const dist = (await getOwnDistribution(ctx.store, chatId, ctx.selfAddress, own.distributionId))!;
  const done = new Set((await kvGet<string[]>(`skdist:${chatId}`)) ?? []);
  const devices = await memberDevices(chatId);
  const missingUsers = [...new Set(devices.filter((d) => !(d.userId === ctx.userId && d.deviceId === ctx.deviceId) && !done.has(`${d.userId}.${d.deviceId}`)).map((d) => d.userId))];
  if (!missingUsers.length) return own;
  const payload: EventPayload = { kind: "senderKey", chatId, distribution: dist };
  const others = missingUsers.filter((u) => u !== ctx.userId);
  const includeSelf = missingUsers.includes(ctx.userId);
  // Chunk very large groups so each relay request stays bounded.
  for (let i = 0; i < Math.max(others.length, 1); i += 100) {
    const chunk = others.slice(i, i + 100);
    if (!chunk.length && !includeSelf) break;
    await sendToUsers(chunk, payload, { push: "silent", includeSelf: includeSelf && i === 0 });
    for (const u of [...chunk, ...(includeSelf && i === 0 ? [ctx.userId] : [])]) {
      for (const d of (await knownDevices(u)) ?? []) done.add(`${u}.${d.deviceId}`);
    }
  }
  for (const d of devices) if (missingUsers.includes(d.userId)) done.add(`${d.userId}.${d.deviceId}`);
  await kvSet(`skdist:${chatId}`, [...done]);
  return own;
}

export interface GroupSendOptions {
  kind: "message" | "event";
  contentClass?: "text" | "media" | "poll" | "other";
  mentions?: string[];
  deleteIds?: string[];
  editOf?: string;
  silent?: boolean;
}

export async function sendGroup(chatId: string, id: string, payload: MessagePayload | EventPayload, opts: GroupSendOptions) {
  const own = await ensureDistributed(chatId);
  const ct = await groupEncrypt(ctx.store, chatId, ctx.selfAddress, own.distributionId, enc(JSON.stringify(payload)));
  const r = await request<{ ok: boolean; seq?: number; ts?: number; error?: string; retryAfter?: number }>("group:send", {
    chatId,
    id,
    ciphertext: toB64(ct),
    kind: opts.kind,
    contentClass: opts.contentClass ?? "text",
    mentions: opts.mentions ?? [],
    deleteIds: opts.deleteIds,
    editOf: opts.editOf,
    silent: opts.silent,
  });
  if (!r.ok) {
    const err = new Error(r.error ?? "send failed") as Error & { retryAfter?: number };
    err.retryAfter = r.retryAfter;
    throw err;
  }
  return { seq: r.seq!, ts: r.ts! };
}

/** Encrypted ephemeral signal to the group (typing). */
export async function sendGroupEphemeral(chatId: string, payload: EventPayload) {
  const own = await ensureDistributed(chatId);
  const ct = await groupEncrypt(ctx.store, chatId, ctx.selfAddress, own.distributionId, enc(JSON.stringify(payload)));
  emit("group:ephemeral", { chatId, ciphertext: toB64(ct) });
}

export async function onSenderKeyDistribution(chatId: string, senderAddress: string, d: SenderKeyDistribution) {
  await processSenderKeyDistribution(ctx.store, chatId, senderAddress, d);
  await kvSet(`skmap:${chatId}:${d.distributionId}`, senderAddress);
}

const requested = new Map<string, number>();

function requestKey(chatId: string, distributionId: string) {
  const k = `${chatId}:${distributionId}`;
  if (Date.now() - (requested.get(k) ?? 0) < 30_000) return;
  requested.set(k, Date.now());
  // Plain request (contains only an opaque distribution id and our own address).
  emit("group:ephemeral", { chatId, ciphertext: "req:" + JSON.stringify({ distributionId, userId: ctx.userId, deviceId: ctx.deviceId }) });
}

/** Another member asked for our chain: send it to all of their devices. */
export async function onSenderKeyRequest(chatId: string, raw: string) {
  const req = JSON.parse(raw) as { distributionId: string; userId: string; deviceId: string };
  const own = await kvGet<OwnKey>(`skown:${chatId}`);
  if (!own || own.distributionId !== req.distributionId) return;
  const dist = await getOwnDistribution(ctx.store, chatId, ctx.selfAddress, own.distributionId);
  if (!dist) return;
  // Membership is enforced by the server for group:ephemeral; it only relays within the chat room.
  await sendToUsers(req.userId === ctx.userId ? [] : [req.userId], { kind: "senderKey", chatId, distribution: dist }, { push: "silent", includeSelf: req.userId === ctx.userId });
}

export type DecryptedGroup =
  | { ok: true; payload: unknown; senderAddress: string; own: boolean }
  | { ok: false; pending: boolean };

export async function decryptGroup(gm: Pick<GroupMessageWire, "chatId" | "ciphertext">): Promise<DecryptedGroup> {
  const ct = fromB64(gm.ciphertext);
  const distributionId = groupMessageDistributionId(ct);
  const senderAddress = await kvGet<string>(`skmap:${gm.chatId}:${distributionId}`);
  if (senderAddress === ctx.selfAddress) return { ok: true, payload: null, senderAddress, own: true };
  if (!senderAddress) {
    requestKey(gm.chatId, distributionId);
    return { ok: false, pending: true };
  }
  try {
    const pt = await groupDecrypt(ctx.store, gm.chatId, senderAddress, ct);
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(pt)), senderAddress, own: false };
  } catch (e) {
    if (e instanceof NoSenderKeyError) {
      requestKey(gm.chatId, distributionId);
      return { ok: false, pending: true };
    }
    return { ok: false, pending: false };
  }
}

/* -------- messages waiting for a sender key -------- */

export async function addPending(gm: GroupMessageWire) {
  const list = (await kvGet<GroupMessageWire[]>(`skpend:${gm.chatId}`)) ?? [];
  if (!list.some((x) => x.id === gm.id)) list.push(gm);
  await kvSet(`skpend:${gm.chatId}`, list.slice(-500));
}

export async function takePending(chatId: string): Promise<GroupMessageWire[]> {
  const list = (await kvGet<GroupMessageWire[]>(`skpend:${chatId}`)) ?? [];
  await kvDel(`skpend:${chatId}`);
  return list;
}
