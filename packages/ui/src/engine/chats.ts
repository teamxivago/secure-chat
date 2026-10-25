import { directChatId, isDirectChatId, peerFromChatId, type ChatSummary } from "@veil/shared";
import { allChats, getChat, putChat } from "../lib/db";
import type { LocalChat, StoredMessage } from "../lib/types";
import { bus } from "./bus";
import { ctx } from "./context";
import { contentPreview } from "./preview";
import { vaultWrite } from "./vault";

/** Local chat list. Direct chats exist only on devices (the server has no record of who talks to whom). */

export function chatTypeOf(id: string): LocalChat["type"] {
  if (isDirectChatId(id)) return peerFromChatId(id) === ctx.account?.userId ? "self" : "direct";
  return id.startsWith("ch_") ? "channel" : "group";
}

export async function ensureChat(id: string, summary?: ChatSummary): Promise<LocalChat> {
  let c = await getChat(id);
  if (!c) {
    c = {
      id,
      type: summary ? (summary.type === "channel" ? "channel" : "group") : chatTypeOf(id),
      peerId: peerFromChatId(id) ?? undefined,
      lastTs: summary?.createdAt ?? Date.now(),
      unread: 0,
      mentions: 0,
      pinned: false,
      archived: false,
      lastReadTs: 0,
      summary,
      title: summary?.title,
      pinnedMessageIds: summary?.pinnedIds ?? [],
    };
    await putChat(c);
    bus.emit("chats:changed", { ids: [id] });
  }
  return c;
}

export async function updateChat(id: string, fn: (c: LocalChat) => void | LocalChat, opts: { sync?: boolean } = {}) {
  const c = await ensureChat(id);
  const next = fn(c) ?? c;
  await putChat(next);
  bus.emit("chats:changed", { ids: [id] });
  if (opts.sync !== false) syncChatSettings(next);
  return next;
}

/** Synced (vault) per-chat state: pin/archive/draft/read position/pins for direct chats. */
export function syncChatSettings(c: LocalChat) {
  vaultWrite("chat", c.id, {
    pinned: c.pinned,
    pinnedAt: c.pinnedAt,
    archived: c.archived,
    mutedUntil: c.mutedUntil ?? null,
    hidden: c.hidden,
    draft: c.draft ?? null,
    lastReadTs: c.lastReadTs,
    pinnedMessageIds: isDirectChatId(c.id) ? c.pinnedMessageIds : undefined,
  });
}

export async function onNewMessage(m: StoredMessage, opts: { countUnread: boolean; mentioned?: boolean }) {
  await updateChat(
    m.chatId,
    (c) => {
      if (m.ts >= c.lastTs || !c.lastMessageId) {
        c.lastTs = m.ts;
        c.lastMessageId = m.id;
        c.lastPreview = contentPreview(m.content);
        c.lastSenderId = m.senderId;
        c.lastStatus = m.status;
        c.lastOutgoing = m.outgoing;
      }
      if (c.hidden) c.hidden = false;
      if (opts.countUnread && !m.outgoing && m.ts > c.lastReadTs && m.content.t !== "system") {
        c.unread += 1;
        if (opts.mentioned) c.mentions += 1;
      }
      if (m.outgoing && c.archived && c.type !== "channel") c.archived = false;
    },
    { sync: false },
  );
}

export async function refreshLastMessage(chatId: string, m: StoredMessage | undefined) {
  await updateChat(
    chatId,
    (c) => {
      if (!m) {
        c.lastMessageId = undefined;
        c.lastPreview = "";
        return;
      }
      c.lastMessageId = m.id;
      c.lastPreview = contentPreview(m.content);
      c.lastTs = m.ts;
      c.lastSenderId = m.senderId;
      c.lastStatus = m.status;
      c.lastOutgoing = m.outgoing;
    },
    { sync: false },
  );
}

/** Pulls group/channel summaries from the server and merges them into local chats. */
export async function refreshServerChats(): Promise<ChatSummary[]> {
  const { chats } = await ctx.api.chats.list();
  const known = new Map((await allChats()).map((c) => [c.id, c]));
  for (const s of chats) {
    const c = known.get(s.id);
    if (!c) await ensureChat(s.id, s);
    else {
      c.summary = s;
      c.title = s.title;
      c.type = s.type === "channel" ? "channel" : "group";
      c.pinnedMessageIds = s.pinnedIds;
      await putChat(c);
    }
  }
  // Chats we're no longer a member of become read-only history (kept locally).
  for (const c of known.values()) {
    if ((c.type === "group" || c.type === "channel") && c.summary && !chats.some((s) => s.id === c.id)) {
      c.summary = { ...c.summary, myRole: null };
      await putChat(c);
    }
  }
  bus.emit("chats:changed", { ids: chats.map((c) => c.id) });
  return chats;
}

export async function refreshServerChat(id: string) {
  try {
    const s = await ctx.api.chats.get(id);
    await ensureChat(id, s);
    await updateChat(
      id,
      (c) => {
        c.summary = s;
        c.title = s.title;
        c.pinnedMessageIds = s.pinnedIds;
      },
      { sync: false },
    );
    return s;
  } catch {
    return undefined;
  }
}

export { directChatId };
