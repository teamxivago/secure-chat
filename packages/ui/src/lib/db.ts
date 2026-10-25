import { openDB, deleteDB, type IDBPDatabase } from "idb";
import { fromB64, toB64 } from "@veil/crypto";
import type { LocalChat, StoredMessage } from "./types";

/**
 * Local encrypted store. All values are sealed with AES-256-GCM under a non-extractable
 * WebCrypto key generated on this device; the key object lives in IndexedDB but its raw bytes
 * can never be read by script or exported from the browser's key store. Only index columns
 * (chat id / sort key) are left in the clear for querying.
 */

const DB_NAME = "veil";
const VERSION = 1;

type Sealed = { iv: Uint8Array; data: ArrayBuffer };

let dbp: Promise<IDBPDatabase> | null = null;
let keyp: Promise<CryptoKey> | null = null;

function db() {
  dbp ??= openDB(DB_NAME, VERSION, {
    upgrade(d) {
      d.createObjectStore("meta");
      d.createObjectStore("kv");
      const m = d.createObjectStore("messages", { keyPath: "id" });
      m.createIndex("chat", ["chatId", "sortKey"]);
      d.createObjectStore("chats", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "id" });
      d.createObjectStore("media");
    },
    blocking() {
      dbp?.then((x) => x.close());
      dbp = null;
    },
  });
  return dbp;
}

async function key(): Promise<CryptoKey> {
  keyp ??= (async () => {
    const d = await db();
    let k = (await d.get("meta", "key")) as CryptoKey | undefined;
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await d.put("meta", k, "key");
    }
    return k;
  })();
  return keyp;
}

const replacer = (_k: string, v: unknown) => (v instanceof Uint8Array ? { $b: toB64(v) } : v);
const reviver = (_k: string, v: unknown) => (v && typeof v === "object" && "$b" in (v as object) && Object.keys(v as object).length === 1 ? fromB64((v as { $b: string }).$b) : v);

async function seal(value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(value, replacer)));
  return { iv, data };
}

async function open<T>(s: Sealed | undefined): Promise<T | undefined> {
  if (!s) return undefined;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv as Uint8Array<ArrayBuffer> }, await key(), s.data);
  return JSON.parse(new TextDecoder().decode(pt), reviver) as T;
}

async function sealBytes(data: ArrayBuffer): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), data) };
}

/* ------------------------------ key/value ------------------------------ */

export async function kvGet<T>(k: string): Promise<T | undefined> {
  return open<T>(await (await db()).get("kv", k));
}
export async function kvSet(k: string, v: unknown): Promise<void> {
  await (await db()).put("kv", await seal(v), k);
}
export async function kvDel(k: string): Promise<void> {
  await (await db()).delete("kv", k);
}
export async function kvKeys(prefix: string): Promise<string[]> {
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  return (await (await db()).getAllKeys("kv", range)) as string[];
}

/* ------------------------------ messages ------------------------------ */

interface MessageRow {
  id: string;
  chatId: string;
  sortKey: string;
  enc: Sealed;
}

export async function putMessage(m: StoredMessage): Promise<void> {
  await (await db()).put("messages", { id: m.id, chatId: m.chatId, sortKey: m.sortKey, enc: await seal(m) } satisfies MessageRow);
}

export async function putMessages(ms: StoredMessage[]): Promise<void> {
  const rows = await Promise.all(ms.map(async (m) => ({ id: m.id, chatId: m.chatId, sortKey: m.sortKey, enc: await seal(m) })));
  const tx = (await db()).transaction("messages", "readwrite");
  await Promise.all([...rows.map((r) => tx.store.put(r)), tx.done]);
}

export async function getMessage(id: string): Promise<StoredMessage | undefined> {
  const row = (await (await db()).get("messages", id)) as MessageRow | undefined;
  return open<StoredMessage>(row?.enc);
}

export async function deleteMessage(id: string): Promise<void> {
  await (await db()).delete("messages", id);
}

/** Newest-first page of a chat, optionally strictly before `beforeKey`. Returned oldest-first. */
export async function messagesForChat(chatId: string, opts: { beforeKey?: string; limit?: number } = {}): Promise<StoredMessage[]> {
  const d = await db();
  const range = IDBKeyRange.bound([chatId, ""], [chatId, opts.beforeKey ?? "￿"], false, !!opts.beforeKey);
  const out: MessageRow[] = [];
  let cursor = await d.transaction("messages").store.index("chat").openCursor(range, "prev");
  while (cursor && out.length < (opts.limit ?? 60)) {
    out.push(cursor.value as MessageRow);
    cursor = await cursor.continue();
  }
  const msgs = await Promise.all(out.map((r) => open<StoredMessage>(r.enc)));
  return (msgs.filter(Boolean) as StoredMessage[]).reverse();
}

export async function messagesAround(chatId: string, sortKey: string, half = 40): Promise<StoredMessage[]> {
  const d = await db();
  const before: MessageRow[] = [];
  let c = await d.transaction("messages").store.index("chat").openCursor(IDBKeyRange.bound([chatId, ""], [chatId, sortKey]), "prev");
  while (c && before.length < half) {
    before.push(c.value as MessageRow);
    c = await c.continue();
  }
  const after: MessageRow[] = [];
  c = await d.transaction("messages").store.index("chat").openCursor(IDBKeyRange.bound([chatId, sortKey], [chatId, "￿"], true, false), "next");
  while (c && after.length < half) {
    after.push(c.value as MessageRow);
    c = await c.continue();
  }
  const rows = [...before.reverse(), ...after];
  return (await Promise.all(rows.map((r) => open<StoredMessage>(r.enc)))).filter(Boolean) as StoredMessage[];
}

/** Streams all messages (for local full-text search and export). */
export async function forEachMessage(fn: (m: StoredMessage) => boolean | void, chatId?: string): Promise<void> {
  const d = await db();
  let cursor = chatId
    ? await d.transaction("messages").store.index("chat").openCursor(IDBKeyRange.bound([chatId, ""], [chatId, "￿"]), "prev")
    : await d.transaction("messages").store.openCursor();
  const batch: MessageRow[] = [];
  while (cursor) {
    batch.push(cursor.value as MessageRow);
    cursor = await cursor.continue();
  }
  for (const r of batch) {
    const m = await open<StoredMessage>(r.enc);
    if (m && fn(m) === false) return;
  }
}

export async function deleteChatMessages(chatId: string): Promise<string[]> {
  const d = await db();
  const tx = d.transaction("messages", "readwrite");
  const ids: string[] = [];
  let cursor = await tx.store.index("chat").openCursor(IDBKeyRange.bound([chatId, ""], [chatId, "￿"]));
  while (cursor) {
    ids.push((cursor.value as MessageRow).id);
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  return ids;
}

/* ------------------------------ chats ------------------------------ */

export async function putChat(c: LocalChat): Promise<void> {
  await (await db()).put("chats", { id: c.id, enc: await seal(c) });
}
export async function getChat(id: string): Promise<LocalChat | undefined> {
  return open<LocalChat>(((await (await db()).get("chats", id)) as { enc: Sealed } | undefined)?.enc);
}
export async function allChats(): Promise<LocalChat[]> {
  const rows = (await (await db()).getAll("chats")) as { enc: Sealed }[];
  return (await Promise.all(rows.map((r) => open<LocalChat>(r.enc)))).filter(Boolean) as LocalChat[];
}
export async function deleteChat(id: string): Promise<void> {
  await (await db()).delete("chats", id);
}

/* ------------------------------ outbox ------------------------------ */

export interface OutboxItem {
  id: string;
  kind: "direct" | "group" | "groupEvent" | "directEvent";
  chatId: string;
  payload: unknown;
  attempts: number;
  createdAt: number;
  extra?: Record<string, unknown>;
}

export async function outboxPut(item: OutboxItem) {
  await (await db()).put("outbox", { id: item.id, createdAt: item.createdAt, enc: await seal(item) });
}
export async function outboxAll(): Promise<OutboxItem[]> {
  const rows = (await (await db()).getAll("outbox")) as { enc: Sealed; createdAt: number }[];
  rows.sort((a, b) => a.createdAt - b.createdAt);
  return (await Promise.all(rows.map((r) => open<OutboxItem>(r.enc)))).filter(Boolean) as OutboxItem[];
}
export async function outboxDelete(id: string) {
  await (await db()).delete("outbox", id);
}

/* ------------------------------ decrypted media cache ------------------------------ */

const MEDIA_CACHE_MAX = 64 * 1024 * 1024;

export async function mediaCacheGet(id: string): Promise<{ data: ArrayBuffer; mime: string } | undefined> {
  const row = (await (await db()).get("media", id)) as { enc: Sealed; mime: string } | undefined;
  if (!row) return undefined;
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.enc.iv as Uint8Array<ArrayBuffer> }, await key(), row.enc.data);
  return { data, mime: row.mime };
}
export async function mediaCachePut(id: string, data: ArrayBuffer, mime: string) {
  if (data.byteLength > MEDIA_CACHE_MAX) return;
  await (await db()).put("media", { enc: await sealBytes(data), mime, at: Date.now(), size: data.byteLength }, id);
}
export async function mediaCacheDelete(id: string) {
  await (await db()).delete("media", id);
}

/** Wipes every local secret and message (logout / remote session termination). */
export async function wipeAll(): Promise<void> {
  try {
    (await dbp)?.close();
  } catch {
    /* noop */
  }
  dbp = null;
  keyp = null;
  await deleteDB(DB_NAME);
}
