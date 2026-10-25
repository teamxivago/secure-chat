import "server-only";
import { getDb, schema, and, eq, or, sql, desc } from "@veil/database";
import type { PublicUser } from "@veil/shared";
import { publicUsers } from "./users";

/**
 * Directory search over PUBLIC data only (usernames, display names, public group/channel titles).
 * Message search never happens server-side: messages are E2EE, so full-text search runs on the
 * device over the locally decrypted store.
 *
 * Uses Meilisearch when MEILI_URL is configured, Postgres trigram matching otherwise.
 */

const meili = () => (process.env.MEILI_URL ? { url: process.env.MEILI_URL.replace(/\/$/, ""), key: process.env.MEILI_MASTER_KEY ?? "" } : null);

async function meiliReq(path: string, init: RequestInit) {
  const m = meili()!;
  const res = await fetch(m.url + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(m.key ? { Authorization: `Bearer ${m.key}` } : {}) },
  });
  if (!res.ok) throw new Error(`meilisearch ${res.status}`);
  return res.json();
}

export async function indexUser(u: PublicUser) {
  if (!meili()) return;
  await meiliReq("/indexes/users/documents", {
    method: "PUT",
    body: JSON.stringify([{ id: u.id, username: u.username, name: [u.name, u.lastName].filter(Boolean).join(" ") }]),
  }).catch((e) => console.warn("[search] index user failed", e));
}

export async function indexChat(c: { id: string; title: string; username: string | null; isPublic: boolean; type: string; description: string | null }) {
  if (!meili()) return;
  if (!c.isPublic) {
    await meiliReq(`/indexes/chats/documents/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => {});
    return;
  }
  await meiliReq("/indexes/chats/documents", {
    method: "PUT",
    body: JSON.stringify([{ id: c.id, title: c.title, username: c.username, type: c.type, description: c.description }]),
  }).catch((e) => console.warn("[search] index chat failed", e));
}

export async function searchDirectory(viewerId: string, q: string) {
  const db = getDb();
  const clean = q.replace(/^@/, "").toLowerCase();
  let userRows: (typeof schema.user.$inferSelect)[];
  let chatRows: (typeof schema.chat.$inferSelect)[];
  const m = meili();
  if (m) {
    const [u, c] = (await Promise.all([
      meiliReq("/indexes/users/search", { method: "POST", body: JSON.stringify({ q: clean, limit: 20 }) }),
      meiliReq("/indexes/chats/search", { method: "POST", body: JSON.stringify({ q: clean, limit: 20 }) }),
    ])) as [{ hits: { id: string }[] }, { hits: { id: string }[] }];
    const uids = u.hits.map((h) => h.id);
    const cids = c.hits.map((h) => h.id);
    userRows = uids.length ? await db.select().from(schema.user).where(sql`${schema.user.id} in ${uids}`) : [];
    chatRows = cids.length ? await db.select().from(schema.chat).where(and(sql`${schema.chat.id} in ${cids}`, eq(schema.chat.isPublic, true))) : [];
  } else {
    const like = `%${clean.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    userRows = await db
      .select()
      .from(schema.user)
      .where(
        and(
          sql`${schema.user.username} is not null`,
          or(sql`lower(${schema.user.username}) like ${like}`, sql`lower(${schema.user.name} || ' ' || coalesce(${schema.user.lastName}, '')) like ${like}`),
        ),
      )
      .orderBy(sql`(lower(${schema.user.username}) = ${clean}) desc`, sql`similarity(lower(${schema.user.username}), ${clean}) desc`)
      .limit(20);
    chatRows = await db
      .select()
      .from(schema.chat)
      .where(and(eq(schema.chat.isPublic, true), or(sql`lower(${schema.chat.username}) like ${like}`, sql`lower(${schema.chat.title}) like ${like}`)))
      .orderBy(desc(schema.chat.memberCount))
      .limit(20);
  }
  const users = (await publicUsers(viewerId, userRows)).filter((u) => !u.blockedMe);
  return {
    users,
    chats: chatRows.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      username: c.username,
      description: c.description,
      memberCount: c.hideSubscriberCount ? -1 : c.memberCount,
      avatarMediaId: c.avatarMediaId,
      avatarKey: c.avatarKey,
    })),
  };
}
