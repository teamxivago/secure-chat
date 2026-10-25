import { vaultOpen, vaultRecordId, vaultSeal } from "@veil/crypto";
import { deleteMessage, getChat, getMessage, kvGet, kvSet, putChat, putMessage } from "../lib/db";
import type { LocalChat, StoredMessage } from "../lib/types";
import { bus } from "./bus";
import { ctx } from "./context";
import { trace } from "../lib/trace";

/**
 * Multi-device sync through the encrypted vault: every message, chat setting, draft and contact
 * name is sealed with the Account Storage Key (shared only by this account's linked devices)
 * and uploaded. A newly linked device downloads the vault and ends up with identical data.
 */

type Kind = "msg" | "chat" | "contact" | "settings";
interface Envelope<T> {
  id: string;
  kind: Kind;
  updatedAt: number;
  value: T | null;
}

const queue = new Map<string, { recordId: string; kind: Kind; data: string | null }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let applying = false;

export function vaultWrite(kind: Kind, id: string, value: unknown | null) {
  if (applying || !ctx.accountKey || !ctx.active) return;
  const ask = ctx.accountKey;
  const recordId = vaultRecordId(ask, kind, id);
  const env: Envelope<unknown> = { id, kind, updatedAt: Date.now(), value };
  // Deletions are sealed tombstones (value: null) so other devices can learn which record was removed.
  queue.set(recordId, { recordId, kind, data: vaultSeal(ask, kind, recordId, env) });
  timer ??= setTimeout(flush, 400);
}

export async function flush() {
  timer = null;
  if (!queue.size) return;
  const batch = [...queue.values()].slice(0, 100);
  for (const r of batch) queue.delete(r.recordId);
  try {
    await ctx.api.vault.push(batch);
  } catch (e) {
    // Re-queue; retried on next write or reconnect.
    for (const r of batch) if (!queue.has(r.recordId)) queue.set(r.recordId, r);
    console.warn("[vault] push failed", e);
  }
  if (queue.size) timer = setTimeout(flush, 1000);
}

/** Downloads vault changes since our cursor and applies them locally. */
export async function pull(onProgress?: (n: number) => void): Promise<number> {
  trace("vault:pull", { hasKey: !!ctx.accountKey, active: ctx.active });
  if (!ctx.accountKey || !ctx.active) return 0;
  const ask = ctx.accountKey;
  let cursor = (await kvGet<number>("vault:cursor")) ?? 0;
  let applied = 0;
  const touchedChats = new Set<string>();
  for (;;) {
    const page = await ctx.api.vault.pull(cursor, 500);
    applying = true;
    try {
      for (const r of page.records) {
        if (r.deleted || !r.data) continue;
        let env: Envelope<unknown>;
        try {
          env = vaultOpen<Envelope<unknown>>(ask, r.kind, r.recordId, r.data);
        } catch {
          continue; // sealed under a previous account key (after "start fresh")
        }
        await applyRecord(env, touchedChats);
        applied++;
      }
    } finally {
      applying = false;
    }
    cursor = page.cursor;
    await kvSet("vault:cursor", cursor);
    onProgress?.(applied);
    if (!page.more) break;
  }
  if (touchedChats.size) bus.emit("chats:changed", { ids: [...touchedChats] });
  return applied;
}

async function applyRecord(env: Envelope<unknown>, touched: Set<string>) {
  if (env.kind === "msg") {
    if (env.value === null) {
      const existing = await getMessage(env.id);
      if (existing) {
        await deleteMessage(env.id);
        touched.add(existing.chatId);
        bus.emit("messages:changed", { chatId: existing.chatId, ids: [], removed: [env.id] });
      }
      return;
    }
    const m = env.value as StoredMessage & { _v?: number };
    const local = (await getMessage(m.id)) as (StoredMessage & { _v?: number }) | undefined;
    if (local && (local._v ?? 0) >= env.updatedAt) return;
    await putMessage({ ...m, _v: env.updatedAt } as StoredMessage);
    touched.add(m.chatId);
    const chat = await getChat(m.chatId);
    if (!chat) {
      const { ensureChat } = await import("./chats");
      await ensureChat(m.chatId);
    }
    const { onNewMessage } = await import("./chats");
    if (!local) await onNewMessage(m, { countUnread: false });
    bus.emit("messages:changed", { chatId: m.chatId, ids: [m.id] });
  } else if (env.kind === "chat") {
    const v = env.value as Partial<LocalChat> | null;
    if (!v) return;
    const { ensureChat } = await import("./chats");
    const c = await ensureChat(env.id);
    Object.assign(c, {
      pinned: v.pinned ?? c.pinned,
      pinnedAt: v.pinnedAt ?? c.pinnedAt,
      archived: v.archived ?? c.archived,
      mutedUntil: v.mutedUntil === undefined ? c.mutedUntil : v.mutedUntil,
      hidden: v.hidden ?? c.hidden,
      draft: v.draft === undefined ? c.draft : v.draft,
      lastReadTs: Math.max(c.lastReadTs, v.lastReadTs ?? 0),
      pinnedMessageIds: v.pinnedMessageIds ?? c.pinnedMessageIds,
    });
    if (c.lastReadTs >= c.lastTs) {
      c.unread = 0;
      c.mentions = 0;
    }
    await putChat(c);
    touched.add(c.id);
  } else if (env.kind === "contact") {
    const { setLocalName } = await import("./users");
    const v = env.value as { name?: string } | null;
    await setLocalName(env.id, v?.name);
  } else if (env.kind === "settings") {
    await kvSet(`settings:${env.id}`, env.value);
    bus.emit("account:changed", undefined);
  }
}

/** Message records are written with a version stamp so concurrent devices converge. */
export function vaultWriteMessage(m: StoredMessage) {
  vaultWrite("msg", m.id, m);
}
export function vaultDeleteMessage(id: string) {
  vaultWrite("msg", id, null);
}
