import { decryptMessage, fromB64, sealedSenderDecrypt } from "@veil/crypto";
import {
  directChatId,
  ENVELOPE_PREKEY,
  ENVELOPE_SEALED,
  ENVELOPE_WHISPER,
  EDIT_WINDOW_MS,
  eventPayloadSchema,
  isDirectChatId,
  messagePayloadSchema,
  type EnvelopeWire,
  type EventPayload,
  type GroupMessageWire,
  type MessagePayload,
} from "@veil/shared";
import { deleteMessage, getChat, getMessage, kvGet, kvSet, putMessage } from "../lib/db";
import type { StoredMessage } from "../lib/types";
import { bus } from "./bus";
import { ensureChat, onNewMessage, refreshLastMessage, updateChat } from "./chats";
import { ctx } from "./context";
import { sendToUsers } from "./direct";
import { addPending, decryptGroup, onSenderKeyDistribution, onSenderKeyRequest, takePending } from "./groups";
import { destroyMedia, forgetAttachmentUrl } from "./media";
import { vaultDeleteMessage, vaultWriteMessage } from "./vault";
import { getUsers } from "./users";
import { trace } from "../lib/trace";

/**
 * Inbound pipeline: unseal → decrypt → validate → apply to the local store. Each payload kind
 * mutates the local message/chat state; the UI re-renders from bus events.
 */

const dec = new TextDecoder();
const seqKey = (seq: number) => `s${String(seq).padStart(14, "0")}`;
export const tsKey = (ts: number, id: string) => `t${String(ts).padStart(14, "0")}:${id}`;

export interface Sender {
  userId: string;
  deviceId: string;
}

interface Origin {
  transport: "direct" | "group";
  chatId?: string;
  seq?: number;
  serverTs?: number;
  live?: boolean;
  deleteIds?: string[];
}

let activeChatId: string | null = null;
let appVisible = true;
export function setActiveChat(id: string | null) {
  activeChatId = id;
}
export function setAppVisible(v: boolean) {
  appVisible = v;
}

/* ------------------------------ direct envelopes ------------------------------ */

const seenEnvelopes = new Set<string>();

export async function handleEnvelope(env: EnvelopeWire): Promise<void> {
  trace("recv:envelope", env.id);
  // The same stored envelope can arrive live and again via pull before it's acked.
  if (!env.ephemeral) {
    if (seenEnvelopes.has(env.id)) return;
    seenEnvelopes.add(env.id);
    if (seenEnvelopes.size > 5000) seenEnvelopes.delete(seenEnvelopes.values().next().value!);
  }
  let sender: Sender;
  let type: number;
  let body: Uint8Array;
  try {
    if (env.type === ENVELOPE_SEALED || env.sealed) {
      const trustRoot = ctx.config?.trustRoot;
      if (!trustRoot) throw new Error("no trust root");
      const un = sealedSenderDecrypt(await ctx.store.getIdentityKeyPair(), fromB64(trustRoot), fromB64(env.content));
      sender = { userId: un.senderUserId, deviceId: un.senderDeviceId };
      type = un.type;
      body = un.body;
    } else if ((env.type === ENVELOPE_WHISPER || env.type === ENVELOPE_PREKEY) && env.senderUserId && env.senderDeviceId) {
      sender = { userId: env.senderUserId, deviceId: env.senderDeviceId };
      type = env.type;
      body = fromB64(env.content);
    } else return;
  } catch (e) {
    console.warn("[recv] unseal failed", e);
    return;
  }
  const addr = `${sender.userId}.${sender.deviceId}`;
  let plaintext: Uint8Array;
  try {
    const r = await decryptMessage(ctx.store, addr, type, body);
    plaintext = r.plaintext;
    if (r.identityChanged) {
      bus.emit("identity:changed", { userId: sender.userId });
      if (sender.userId !== ctx.userId) await insertSystem(directChatId(sender.userId), "identityChanged", sender.userId);
    }
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/duplicate|replayed/i.test(msg)) return; // already processed: harmless
    console.warn("[recv] decrypt failed", addr, e);
    if (!env.ephemeral) await recoverSession(sender);
    return;
  }
  // Drop content from blocked users (server also drops; this covers races).
  const blocked = (await kvGet<string[]>("blocked")) ?? [];
  if (blocked.includes(sender.userId)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(dec.decode(plaintext));
  } catch {
    return;
  }
  await applyPayload(raw, sender, { transport: "direct", serverTs: env.ts, live: !env.ephemeral });
}

/** Session broke (e.g. lost state): reset and send a null message to re-establish it. */
async function recoverSession(sender: Sender) {
  const key = `recover:${sender.userId}.${sender.deviceId}`;
  const last = (await kvGet<number>(key)) ?? 0;
  if (Date.now() - last < 60_000) return;
  await kvSet(key, Date.now());
  await ctx.store.removeSession(`${sender.userId}.${sender.deviceId}`);
  const { invalidateDevices } = await import("./direct");
  await invalidateDevices(sender.userId);
  if (sender.userId !== ctx.userId) {
    await sendToUsers([sender.userId], { kind: "nullMessage" }, { push: "silent", includeSelf: false }).catch(() => {});
    await insertSystem(directChatId(sender.userId), "identityChanged", sender.userId, "A message couldn't be decrypted. The secure session was re-established.");
  }
}

/* ------------------------------ group messages ------------------------------ */

export async function handleGroupMessage(gm: GroupMessageWire & { kind?: string; deleteIds?: string[]; editOf?: string }, live = true): Promise<void> {
  const chat = await getChat(gm.chatId);
  const r = await decryptGroup(gm);
  if (!r.ok) {
    if (r.pending) await addPending(gm);
    await advanceCursor(gm.chatId, gm.seq);
    return;
  }
  if (r.own) {
    // Echo of our own send: attach the server sequence if we still have the message.
    const m = await getMessage(gm.id);
    if (m && m.seq === undefined) {
      m.seq = gm.seq;
      m.sortKey = seqKey(gm.seq);
      m.status = m.status === "pending" ? "sent" : m.status;
      await putMessage(m);
      bus.emit("messages:changed", { chatId: m.chatId, ids: [m.id] });
    }
    await advanceCursor(gm.chatId, gm.seq);
    return;
  }
  const [userId, deviceId] = [r.senderAddress.slice(0, r.senderAddress.lastIndexOf(".")), r.senderAddress.slice(r.senderAddress.lastIndexOf(".") + 1)];
  await applyPayload(r.payload, { userId, deviceId }, { transport: "group", chatId: gm.chatId, seq: gm.seq, serverTs: gm.ts, live, deleteIds: gm.deleteIds });
  if (gm.views !== undefined && chat?.type === "channel") {
    const m = await getMessage(gm.id);
    if (m) {
      m.views = Math.max(m.views ?? 0, gm.views);
      await putMessage(m);
    }
  }
  await advanceCursor(gm.chatId, gm.seq);
}

async function advanceCursor(chatId: string, seq: number) {
  const c = await getChat(chatId);
  if (c && (c.groupCursor ?? 0) < seq) {
    c.groupCursor = seq;
    const { putChat } = await import("../lib/db");
    await putChat(c);
  }
}

export async function handleGroupEphemeral(d: { chatId: string; ciphertext: string }) {
  if (d.ciphertext.startsWith("req:")) {
    await onSenderKeyRequest(d.chatId, d.ciphertext.slice(4)).catch((e) => console.warn("[sk] request failed", e));
    return;
  }
  const r = await decryptGroup(d);
  if (r.ok && !r.own) {
    const userId = r.senderAddress.slice(0, r.senderAddress.lastIndexOf("."));
    await applyPayload(r.payload, { userId, deviceId: "" }, { transport: "group", chatId: d.chatId, live: true });
  }
}

/* ------------------------------ payload application ------------------------------ */

function localChatIdFor(payloadChatId: string, sender: Sender, origin: Origin): string | null {
  if (origin.transport === "group") return payloadChatId === origin.chatId ? payloadChatId : null;
  if (!isDirectChatId(payloadChatId)) return null; // groups never arrive pairwise (except control events)
  return directChatId(sender.userId);
}

export async function applyPayload(raw: unknown, sender: Sender, origin: Origin): Promise<void> {
  const asMessage = messagePayloadSchema.safeParse(raw);
  if (asMessage.success) {
    const chatId = localChatIdFor(asMessage.data.chatId, sender, origin);
    if (chatId) await receiveMessage(asMessage.data, chatId, sender, origin);
    return;
  }
  const ev = eventPayloadSchema.safeParse(raw);
  if (!ev.success) return;
  await applyEvent(ev.data, sender, origin);
}

function isMentioned(p: MessagePayload): boolean {
  if (p.meta?.mentions?.includes(ctx.userId)) return true;
  return p.meta?.replyTo?.senderId === ctx.userId;
}

async function receiveMessage(p: MessagePayload, chatId: string, sender: Sender, origin: Origin, outgoingSync = false) {
  if (await getMessage(p.id)) return; // duplicate (retransmit / multi-path)
  const summaryChat = await ensureChat(chatId);
  const ts = origin.transport === "group" ? (origin.serverTs ?? p.ts) : p.ts;
  const m: StoredMessage = {
    id: p.id,
    chatId,
    senderId: sender.userId,
    senderDeviceId: sender.deviceId,
    ts,
    sortKey: origin.seq !== undefined ? seqKey(origin.seq) : tsKey(ts, p.id),
    seq: origin.seq,
    content: p.content,
    meta: p.meta ?? {},
    outgoing: outgoingSync || sender.userId === ctx.userId,
    status: outgoingSync || sender.userId === ctx.userId ? "sent" : "delivered",
    reactions: {},
    receipts: {},
  };
  await putMessage(m);
  trace("recv:stored", m.id);
  vaultWriteMessage(m);
  const viewing = activeChatId === chatId && appVisible;
  const mentioned = !m.outgoing && isMentioned(p);
  await onNewMessage(m, { countUnread: !m.outgoing && !viewing, mentioned });
  bus.emit("messages:changed", { chatId, ids: [m.id] });
  if (viewing && !m.outgoing && origin.live) void import("../lib/native").then((n) => n.haptic("light"));

  if (!m.outgoing && origin.live) {
    // Delivery receipt (1:1 only; group delivery is implied by the sequence).
    if (origin.transport === "direct") {
      void sendToUsers([sender.userId], { kind: "receipt", chatId: directChatId(ctx.userId), status: "delivered", ids: [m.id], ts: Date.now() }, { push: "silent", includeSelf: false }).catch(() => {});
    }
    const muted = (summaryChat.mutedUntil ?? 0) > Date.now();
    if (!viewing && !p.meta?.silent && (!muted || mentioned)) {
      const users = await getUsers([sender.userId]);
      const u = users.get(sender.userId);
      const { displayName } = await import("./users");
      const { contentPreview } = await import("./preview");
      bus.emit("notify", { chatId, title: summaryChat.title ?? displayName(u), body: contentPreview(m.content), messageId: m.id });
    }
  }
}

async function mutateMessage(id: string, fn: (m: StoredMessage) => boolean | void) {
  const m = await getMessage(id);
  if (!m) return null;
  if (fn(m) === false) return null;
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId: m.chatId, ids: [m.id] });
  return m;
}

async function insertSystem(chatId: string, action: "identityChanged" | "screenshot" | "keysRotated", actorId: string, text?: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const cursor = isDirectChatId(chatId) ? undefined : (await getChat(chatId))?.groupCursor;
  const m: StoredMessage = {
    id,
    chatId,
    senderId: actorId,
    ts: now,
    // In groups, order by the server sequence we've reached so the notice stays in place.
    sortKey: cursor !== undefined ? `${seqKey(cursor)}:${id}` : tsKey(now, id),
    content: { t: "system", action, actorId, text },
    meta: {},
    outgoing: false,
    status: "delivered",
    reactions: {},
    receipts: {},
  };
  await ensureChat(chatId);
  await putMessage(m);
  bus.emit("messages:changed", { chatId, ids: [id] });
}

async function applyEvent(e: EventPayload, sender: Sender, origin: Origin) {
  const fromSelf = sender.userId === ctx.userId;
  const chatIdOf = (cid: string) => (origin.transport === "group" ? origin.chatId! : isDirectChatId(cid) ? (fromSelf ? cid : directChatId(sender.userId)) : cid);

  switch (e.kind) {
    case "sync": {
      if (!fromSelf) return;
      if (e.sent) {
        const chatId = isDirectChatId(e.sent.message.chatId) ? directChatId(e.sent.to) : e.sent.message.chatId;
        await receiveMessage(e.sent.message, chatId, sender, { ...origin, live: false }, true);
      }
      if (e.read) {
        const upTo = e.read.upTo;
        await updateChat(e.read.chatId, (c) => {
          c.lastReadTs = Math.max(c.lastReadTs, upTo);
          c.unread = 0;
          c.mentions = 0;
        }, { sync: false });
      }
      return;
    }
    case "edit": {
      const chatId = chatIdOf(e.chatId);
      const m = await mutateMessage(e.targetId, (m) => {
        if (m.senderId !== sender.userId || m.chatId !== chatId) return false;
        if (Date.now() - m.ts > EDIT_WINDOW_MS + 60_000) return false;
        m.content = e.content;
        m.editedAt = e.ts;
      });
      if (m) {
        const c = await getChat(chatId);
        if (c?.lastMessageId === m.id) await refreshLastMessage(chatId, m);
      }
      return;
    }
    case "delete": {
      const chatId = chatIdOf(e.chatId);
      const chat = await getChat(chatId);
      const removed: string[] = [];
      for (const id of e.targetIds) {
        const m = await getMessage(id);
        if (!m || m.chatId !== chatId) continue;
        // Authors may delete their own; in groups the server authorizes admin deletes and relays the ids.
        const authorized = m.senderId === sender.userId || (origin.transport === "group" && !!origin.deleteIds?.includes(id));
        if (!authorized) continue;
        await purgeLocal(m);
        removed.push(id);
      }
      if (removed.length) {
        bus.emit("messages:changed", { chatId, ids: [], removed });
        if (chat && removed.includes(chat.lastMessageId ?? "")) {
          const { messagesForChat } = await import("../lib/db");
          const [last] = (await messagesForChat(chatId, { limit: 1 })).slice(-1);
          await refreshLastMessage(chatId, last);
        }
      }
      return;
    }
    case "reaction": {
      const chatId = chatIdOf(e.chatId);
      const m = await mutateMessage(e.targetId, (m) => {
        if (m.chatId !== chatId) return false;
        const list = new Set(m.reactions[e.emoji] ?? []);
        if (e.remove) list.delete(sender.userId);
        else list.add(sender.userId);
        if (list.size) m.reactions[e.emoji] = [...list];
        else delete m.reactions[e.emoji];
      });
      if (m && m.outgoing && !e.remove && !fromSelf && origin.live && activeChatId !== chatId) {
        const { displayName, getUser } = await import("./users");
        bus.emit("notify", { chatId, title: displayName(await getUser(sender.userId)), body: `reacted ${e.emoji} to your message`, messageId: m.id });
      }
      return;
    }
    case "receipt": {
      const chatId = chatIdOf(e.chatId);
      for (const id of e.ids) {
        await mutateMessage(id, (m) => {
          if (!m.outgoing || m.chatId !== chatId) return false;
          const r = (m.receipts[sender.userId] ??= {});
          r[e.status] = e.ts;
          if (e.status === "read") r.delivered ??= e.ts;
          const rank = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 } as const;
          if (rank[e.status] > rank[m.status]) m.status = e.status;
        });
      }
      const c = await getChat(chatId);
      if (c?.lastMessageId && e.ids.includes(c.lastMessageId)) {
        const lm = await getMessage(c.lastMessageId);
        if (lm) await updateChat(chatId, (x) => void (x.lastStatus = lm.status), { sync: false });
      }
      return;
    }
    case "typing": {
      if (fromSelf) return;
      bus.emit("typing", { chatId: chatIdOf(e.chatId), userId: sender.userId, action: e.action });
      return;
    }
    case "pollVote": {
      await mutateMessage(e.pollId, (m) => {
        if (m.content.t !== "poll" || m.pollClosed) return false;
        if (m.content.closesAt && e.ts > m.content.closesAt) return false;
        const valid = e.optionIds.filter((o) => (m.content as { options: { id: string }[] }).options.some((x) => x.id === o));
        const choice = m.content.multiple ? valid : valid.slice(0, 1);
        m.pollVotes ??= {};
        // Quiz answers are final once given.
        if (m.content.quiz && m.pollVotes[sender.userId]?.length) return false;
        if (choice.length) m.pollVotes[sender.userId] = choice;
        else delete m.pollVotes[sender.userId];
      });
      return;
    }
    case "pollClose": {
      await mutateMessage(e.pollId, (m) => {
        if (m.senderId !== sender.userId) return false;
        m.pollClosed = true;
      });
      return;
    }
    case "rsvp": {
      await mutateMessage(e.eventId, (m) => {
        if (m.content.t !== "event") return false;
        m.rsvps ??= {};
        m.rsvps[sender.userId] = e.status;
      });
      return;
    }
    case "pin": {
      const chatId = chatIdOf(e.chatId);
      if (!isDirectChatId(chatId)) return; // group pins are server-managed
      await updateChat(chatId, (c) => {
        const set = new Set(c.pinnedMessageIds ?? []);
        if (e.unpin) set.delete(e.targetId);
        else set.add(e.targetId);
        c.pinnedMessageIds = [...set];
      });
      return;
    }
    case "onceViewed": {
      await mutateMessage(e.targetId, (m) => {
        if (fromSelf) {
          m.onceViewedLocally = true;
          return;
        }
        if (!m.outgoing) return false;
        m.onceViewedBy = [...new Set([...(m.onceViewedBy ?? []), sender.userId])];
      });
      return;
    }
    case "screenshot": {
      if (fromSelf) return;
      const chatId = chatIdOf(e.chatId);
      if (e.targetId) await mutateMessage(e.targetId, (m) => void (m.screenshotBy = [...new Set([...(m.screenshotBy ?? []), sender.userId])]));
      await insertSystem(chatId, "screenshot", sender.userId);
      bus.emit("screenshot", { chatId, userId: sender.userId });
      return;
    }
    case "senderKey": {
      if (origin.transport !== "direct") return;
      await onSenderKeyDistribution(e.chatId, `${sender.userId}.${sender.deviceId}`, e.distribution);
      for (const gm of await takePending(e.chatId)) await handleGroupMessage(gm, false);
      return;
    }
    case "senderKeyRequest": {
      await onSenderKeyRequest(e.chatId, JSON.stringify({ distributionId: e.distributionId, userId: sender.userId, deviceId: sender.deviceId }));
      return;
    }
    case "call": {
      bus.emit("call:event", { type: "signal", data: { ...e, fromUserId: sender.userId, fromDeviceId: sender.deviceId } });
      return;
    }
    case "profileKey":
    case "nullMessage":
      return;
  }
}

/** Removes a message and everything derived from it on this device ("no trace left"). */
export async function purgeLocal(m: StoredMessage) {
  await deleteMessage(m.id);
  vaultDeleteMessage(m.id);
  if (m.content.t === "media") {
    forgetAttachmentUrl(m.content.attachment.mediaId);
    if (m.outgoing) await destroyMedia(m.content.attachment).catch(() => {});
    else {
      const { mediaCacheDelete } = await import("../lib/db");
      await mediaCacheDelete(m.content.attachment.mediaId);
    }
  }
}
