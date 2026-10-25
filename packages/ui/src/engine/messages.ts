import {
  directChatId,
  EDIT_WINDOW_MS,
  extractUrls,
  isDirectChatId,
  peerFromChatId,
  type Content,
  type EventPayload,
  type LinkPreview,
  type MessagePayload,
} from "@veil/shared";
import { getChat, getMessage, messagesForChat, outboxAll, outboxDelete, outboxPut, putMessage, type OutboxItem } from "../lib/db";
import type { StoredMessage } from "../lib/types";
import { bus } from "./bus";
import { ensureChat, onNewMessage, refreshLastMessage, updateChat } from "./chats";
import { ctx } from "./context";
import { sendToUsers } from "./direct";
import { sendGroup, sendGroupEphemeral } from "./groups";
import { destroyMedia } from "./media";
import { contentPreview } from "./preview";
import { purgeLocal, tsKey } from "./receive";
import { connected } from "./transport";
import { vaultWriteMessage } from "./vault";
import { trace } from "../lib/trace";

/** High-level messaging operations used by the UI. All content leaves the device encrypted. */

const RETRYABLE = /offline|timeout|network|reconcile|rate limited/i;

function contentClass(c: Content): "text" | "media" | "poll" | "other" {
  return c.t === "text" ? "text" : c.t === "media" ? "media" : c.t === "poll" ? "poll" : "other";
}

async function setStatus(id: string, status: StoredMessage["status"], extra?: Partial<StoredMessage>) {
  const m = await getMessage(id);
  if (!m) return;
  Object.assign(m, { status }, extra);
  if (status !== "failed") delete m.error;
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId: m.chatId, ids: [id] });
  const c = await getChat(m.chatId);
  if (c?.lastMessageId === id) await updateChat(m.chatId, (x) => void (x.lastStatus = m.status), { sync: false });
}

/* ------------------------------ delivery (with outbox) ------------------------------ */

async function deliver(item: OutboxItem): Promise<void> {
  trace("deliver:start", item.id);
  const payload = item.payload as MessagePayload | EventPayload;
  if (isDirectChatId(item.chatId)) {
    const peer = peerFromChatId(item.chatId)!;
    const isSelf = peer === ctx.userId;
    if (item.kind === "direct") {
      const msg = payload as MessagePayload;
      await sendToUsers(isSelf ? [] : [peer], msg, {
        push: msg.meta?.silent ? "silent" : "message",
        selfPayload: { kind: "sync", sent: { to: peer, message: msg } },
      });
    } else {
      const ev = payload as EventPayload;
      await sendToUsers(isSelf ? [] : [peer], ev, { push: ev.kind === "reaction" ? "reaction" : "silent" });
    }
  } else {
    const ex = (item.extra ?? {}) as { mentions?: string[]; deleteIds?: string[]; editOf?: string; silent?: boolean };
    const r = await sendGroup(item.chatId, item.id, payload, {
      kind: item.kind === "group" ? "message" : "event",
      contentClass: item.kind === "group" ? contentClass((payload as MessagePayload).content) : "other",
      mentions: ex.mentions,
      deleteIds: ex.deleteIds,
      editOf: ex.editOf,
      silent: ex.silent,
    });
    if (item.kind === "group") {
      const m = await getMessage(item.id);
      if (m) {
        m.seq = r.seq;
        m.sortKey = `s${String(r.seq).padStart(14, "0")}`;
        m.ts = r.ts;
        await putMessage(m);
      }
    }
  }
}

let flushing = false;

/** Sends queued items in order; called on reconnect and after each enqueue. */
export async function flushOutbox() {
  trace("outbox:flush", { flushing, connected: connected() });
  if (flushing || !connected()) return;
  flushing = true;
  try {
    for (const item of await outboxAll()) {
      try {
        await deliver(item);
        await outboxDelete(item.id);
        if (item.kind === "direct" || item.kind === "group") await setStatus(item.id, "sent");
      } catch (e) {
        const msg = (e as Error).message;
        if (RETRYABLE.test(msg) && item.attempts < 20) {
          item.attempts++;
          await outboxPut(item);
          break; // keep ordering; retry later
        }
        await outboxDelete(item.id);
        if (item.kind === "direct" || item.kind === "group") await setStatus(item.id, "failed", { error: msg });
        else console.warn("[outbox] dropped event", item.id, msg);
      }
    }
  } finally {
    flushing = false;
  }
}

async function enqueue(item: Omit<OutboxItem, "attempts" | "createdAt">) {
  await outboxPut({ ...item, attempts: 0, createdAt: Date.now() });
  void flushOutbox();
}

/* ------------------------------ sending ------------------------------ */

export interface SendOptions {
  replyTo?: StoredMessage;
  forwardedFrom?: MessagePayload["meta"]["forwardedFrom"];
  mentions?: string[];
  silent?: boolean;
  id?: string;
}

export async function sendMessage(chatId: string, content: Content, opts: SendOptions = {}): Promise<StoredMessage> {
  await ensureChat(chatId);
  const id = opts.id ?? crypto.randomUUID();
  const ts = Date.now();
  trace("send:start", id);
  const meta: MessagePayload["meta"] = {};
  if (opts.replyTo) {
    meta.replyTo = { id: opts.replyTo.id, senderId: opts.replyTo.senderId, snippet: contentPreview(opts.replyTo.content).slice(0, 200) };
  }
  if (opts.forwardedFrom) meta.forwardedFrom = opts.forwardedFrom;
  if (opts.mentions?.length) meta.mentions = opts.mentions;
  if (opts.silent) meta.silent = true;
  const payload: MessagePayload = { kind: "message", id, chatId, ts, content, meta };
  const m: StoredMessage = {
    id,
    chatId,
    senderId: ctx.userId,
    senderDeviceId: ctx.deviceId,
    ts,
    sortKey: isDirectChatId(chatId) ? tsKey(ts, id) : `t${String(ts).padStart(14, "0")}:${id}`,
    content,
    meta,
    outgoing: true,
    status: "pending",
    reactions: {},
    receipts: {},
  };
  // Pending group messages sort after everything already sequenced.
  if (!isDirectChatId(chatId)) m.sortKey = `z${String(ts).padStart(14, "0")}:${id}`;
  const replyMention = opts.replyTo && opts.replyTo.senderId !== ctx.userId ? [opts.replyTo.senderId] : [];
  // Persist the message and its outbox entry in parallel, then hand off to the network;
  // chat-list bookkeeping happens while it's in flight.
  await Promise.all([
    putMessage(m),
    outboxPut({
      id,
      kind: isDirectChatId(chatId) ? "direct" : "group",
      chatId,
      payload,
      extra: { mentions: [...new Set([...(opts.mentions ?? []), ...replyMention])], silent: opts.silent },
      attempts: 0,
      createdAt: Date.now(),
    }),
  ]);
  bus.emit("messages:changed", { chatId, ids: [id] });
  void flushOutbox();
  vaultWriteMessage(m);
  await onNewMessage(m, { countUnread: false });
  await updateChat(chatId, (c) => void (c.draft = null));
  return m;
}

export async function retryMessage(id: string) {
  const m = await getMessage(id);
  if (!m || m.status !== "failed") return;
  await setStatus(id, "pending");
  const payload: MessagePayload = { kind: "message", id, chatId: m.chatId, ts: m.ts, content: m.content, meta: m.meta };
  await enqueue({ id, kind: isDirectChatId(m.chatId) ? "direct" : "group", chatId: m.chatId, payload, extra: { mentions: m.meta.mentions } });
}

async function sendEvent(chatId: string, ev: EventPayload, extra?: OutboxItem["extra"]) {
  await enqueue({ id: crypto.randomUUID(), kind: isDirectChatId(chatId) ? "directEvent" : "groupEvent", chatId, payload: ev, extra });
}

/* ------------------------------ edits / deletes ------------------------------ */

export async function editMessage(id: string, content: Content) {
  const m = await getMessage(id);
  if (!m || !m.outgoing) throw new Error("can only edit your own messages");
  if (Date.now() - m.ts > EDIT_WINDOW_MS) throw new Error("Messages can be edited for 48 hours");
  m.content = content;
  m.editedAt = Date.now();
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId: m.chatId, ids: [id] });
  const c = await getChat(m.chatId);
  if (c?.lastMessageId === id) await refreshLastMessage(m.chatId, m);
  await sendEvent(m.chatId, { kind: "edit", chatId: m.chatId, targetId: id, content, ts: m.editedAt }, { editOf: id });
}

export async function deleteMessages(chatId: string, ids: string[], forEveryone: boolean) {
  const removed: string[] = [];
  const own: string[] = [];
  for (const id of ids) {
    const m = await getMessage(id);
    if (!m || m.chatId !== chatId) continue;
    if (m.outgoing) own.push(id);
    await purgeLocal(m);
    removed.push(id);
  }
  if (!removed.length) return;
  bus.emit("messages:changed", { chatId, ids: [], removed });
  const [last] = (await messagesForChat(chatId, { limit: 1 })).slice(-1);
  await refreshLastMessage(chatId, last);
  if (forEveryone) {
    const targets = isDirectChatId(chatId) ? own : removed;
    if (targets.length) await sendEvent(chatId, { kind: "delete", chatId, targetIds: targets, ts: Date.now() }, { deleteIds: targets });
  } else if (isDirectChatId(chatId)) {
    // "Delete for me" still syncs to our other devices through the vault tombstones.
  }
}

/* ------------------------------ reactions / receipts / typing ------------------------------ */

export async function toggleReaction(chatId: string, messageId: string, emoji: string) {
  const m = await getMessage(messageId);
  if (!m) return;
  const users = new Set(m.reactions[emoji] ?? []);
  const remove = users.has(ctx.userId);
  if (remove) users.delete(ctx.userId);
  else users.add(ctx.userId);
  if (users.size) m.reactions[emoji] = [...users];
  else delete m.reactions[emoji];
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId, ids: [messageId] });
  const mentions = !remove && !m.outgoing && !isDirectChatId(chatId) ? [m.senderId] : undefined;
  await sendEvent(chatId, { kind: "reaction", chatId, targetId: messageId, emoji, remove, ts: Date.now() }, { mentions });
}

export async function markRead(chatId: string) {
  const c = await getChat(chatId);
  if (!c) return;
  const recent = await messagesForChat(chatId, { limit: 100 });
  const unreadIncoming = recent.filter((m) => !m.outgoing && m.ts > c.lastReadTs && m.status !== "read" && m.content.t !== "system");
  const upTo = Math.max(c.lastReadTs, ...recent.map((m) => m.ts));
  if (c.unread === 0 && !unreadIncoming.length && c.lastReadTs >= upTo) return;
  await updateChat(chatId, (x) => {
    x.unread = 0;
    x.mentions = 0;
    x.lastReadTs = upTo;
  });
  for (const m of unreadIncoming) {
    m.status = "read";
    await putMessage(m);
  }
  const settings = (await import("../lib/db")).kvGet;
  const readReceipts = (await settings<boolean>("settings:readReceipts")) ?? true;
  if (!readReceipts || !unreadIncoming.length) return;
  const bySender = new Map<string, string[]>();
  for (const m of unreadIncoming) bySender.set(m.senderId, [...(bySender.get(m.senderId) ?? []), m.id]);
  const isGroup = !isDirectChatId(chatId);
  // Per-recipient read receipts go pairwise to each author (small groups only, to bound fan-out).
  if (isGroup && (c.summary?.memberCount ?? 0) > 100) return;
  for (const [sender, ids] of bySender) {
    void sendToUsers([sender], { kind: "receipt", chatId: isGroup ? chatId : directChatId(ctx.userId), status: "read", ids, ts: Date.now() }, { push: "silent", includeSelf: false }).catch(() => {});
  }
}

const lastTyping = new Map<string, number>();
export async function setTyping(chatId: string, action: "typing" | "recording" | "uploading" | "stop") {
  const key = `${chatId}:${action}`;
  if (action !== "stop" && Date.now() - (lastTyping.get(key) ?? 0) < 4000) return;
  lastTyping.set(key, Date.now());
  if (!connected()) return;
  const ev: EventPayload = { kind: "typing", chatId: isDirectChatId(chatId) ? directChatId(ctx.userId) : chatId, action };
  try {
    if (isDirectChatId(chatId)) {
      const peer = peerFromChatId(chatId)!;
      if (peer === ctx.userId) return;
      await sendToUsers([peer], ev, { ephemeral: true, push: "silent", includeSelf: false });
    } else {
      const c = await getChat(chatId);
      if (c?.type === "channel") return;
      await sendGroupEphemeral(chatId, ev);
    }
  } catch {
    /* typing is best effort */
  }
}

/* ------------------------------ pins / polls / events / once-view ------------------------------ */

export async function pinMessage(chatId: string, messageId: string, unpin = false) {
  if (isDirectChatId(chatId)) {
    await updateChat(chatId, (c) => {
      const s = new Set(c.pinnedMessageIds ?? []);
      if (unpin) s.delete(messageId);
      else s.add(messageId);
      c.pinnedMessageIds = [...s].slice(-5);
    });
    await sendEvent(chatId, { kind: "pin", chatId, targetId: messageId, unpin, ts: Date.now() });
  } else {
    const r = unpin ? await ctx.api.chats.unpin(chatId, messageId) : await ctx.api.chats.pin(chatId, messageId);
    await updateChat(chatId, (c) => void (c.pinnedMessageIds = r.pinnedIds), { sync: false });
  }
}

export async function votePoll(chatId: string, pollId: string, optionIds: string[]) {
  const m = await getMessage(pollId);
  if (!m || m.content.t !== "poll" || m.pollClosed) return;
  if (m.content.quiz && m.pollVotes?.[ctx.userId]?.length) return;
  m.pollVotes ??= {};
  if (optionIds.length) m.pollVotes[ctx.userId] = optionIds;
  else delete m.pollVotes[ctx.userId];
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId, ids: [pollId] });
  await sendEvent(chatId, { kind: "pollVote", chatId, pollId, optionIds, ts: Date.now() });
}

export async function closePoll(chatId: string, pollId: string) {
  const m = await getMessage(pollId);
  if (!m?.outgoing || m.content.t !== "poll") return;
  m.pollClosed = true;
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId, ids: [pollId] });
  await sendEvent(chatId, { kind: "pollClose", chatId, pollId, ts: Date.now() });
}

export async function rsvp(chatId: string, eventId: string, status: "going" | "maybe" | "declined") {
  const m = await getMessage(eventId);
  if (!m || m.content.t !== "event") return;
  m.rsvps = { ...(m.rsvps ?? {}), [ctx.userId]: status };
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId, ids: [eventId] });
  await sendEvent(chatId, { kind: "rsvp", chatId, eventId, status, ts: Date.now() });
}

/** Called when the recipient closes a once-view item: destroy everywhere and tell the sender. */
export async function consumeOnceView(chatId: string, messageId: string) {
  const m = await getMessage(messageId);
  if (!m || m.content.t !== "media" || !m.content.onceView || m.outgoing) return;
  m.onceViewedLocally = true;
  const att = m.content.attachment;
  await destroyMedia(att);
  // Strip the key + thumbnail so nothing recoverable remains locally.
  m.content = { ...m.content, attachment: { ...att, key: "", thumbnail: undefined, deleteToken: undefined } };
  await putMessage(m);
  vaultWriteMessage(m);
  bus.emit("messages:changed", { chatId, ids: [messageId] });
  await sendEvent(chatId, { kind: "onceViewed", chatId, targetId: messageId, ts: Date.now() });
}

export async function reportScreenshot(chatId: string, messageId?: string) {
  await sendEvent(chatId, { kind: "screenshot", chatId, targetId: messageId, ts: Date.now() });
}

/* ------------------------------ forwarding / drafts / chat ops ------------------------------ */

export async function forwardMessages(messages: StoredMessage[], toChatIds: string[], withAttribution: boolean) {
  const { getUser, displayName } = await import("./users");
  for (const to of toChatIds) {
    for (const m of messages) {
      if (m.content.t === "media" && m.content.onceView) continue; // once-view can't be forwarded
      if (m.content.t === "system" || m.content.t === "call") continue;
      const fwd = withAttribution
        ? m.meta.forwardedFrom ?? { name: m.outgoing ? displayName(ctx.me) : displayName(await getUser(m.senderId)), userId: m.senderId }
        : undefined;
      await sendMessage(to, m.content, { forwardedFrom: fwd });
    }
  }
}

export async function saveDraft(chatId: string, text: string, replyToId?: string) {
  await updateChat(chatId, (c) => {
    c.draft = text.trim() ? { text, replyToId, ts: Date.now() } : null;
  });
}

export async function setChatFlags(chatId: string, flags: { pinned?: boolean; archived?: boolean }) {
  await updateChat(chatId, (c) => {
    if (flags.pinned !== undefined) {
      c.pinned = flags.pinned;
      c.pinnedAt = flags.pinned ? Date.now() : undefined;
    }
    if (flags.archived !== undefined) c.archived = flags.archived;
  });
}

/** Mutes notifications for a chat (until a timestamp, or forever with Infinity → stored as max). */
export async function muteChat(chatId: string, until: number | null) {
  const c = await updateChat(chatId, (x) => void (x.mutedUntil = until));
  if (!isDirectChatId(chatId)) {
    await ctx.api.me
      .setNotifications({ scope: { scope: chatId, mode: until && until > Date.now() ? "none" : "all", mutedUntil: until && Number.isFinite(until) ? until : null } })
      .catch(() => {});
  }
  return c;
}

export async function clearHistory(chatId: string, forEveryone = false) {
  const all = await messagesForChat(chatId, { limit: 100000 });
  await deleteMessages(chatId, all.map((m) => m.id), forEveryone);
}

export async function deleteChatLocal(chatId: string) {
  const { deleteChatMessages } = await import("../lib/db");
  const { vaultDeleteMessage } = await import("./vault");
  for (const id of await deleteChatMessages(chatId)) vaultDeleteMessage(id);
  await updateChat(chatId, (c) => {
    c.hidden = true;
    c.lastMessageId = undefined;
    c.lastPreview = "";
    c.unread = 0;
    c.draft = null;
  });
}

/* ------------------------------ link previews ------------------------------ */

export async function fetchLinkPreview(text: string, signal?: AbortSignal): Promise<LinkPreview | null> {
  const url = extractUrls(text)[0];
  if (!url) return null;
  try {
    const res = await fetch(`${ctx.svc("link")}/preview?url=${encodeURIComponent(url)}`, {
      headers: ctx.account?.token ? { Authorization: `Bearer ${ctx.account.token}` } : {},
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as LinkPreview;
  } catch {
    return null;
  }
}

export { destroyMedia };
