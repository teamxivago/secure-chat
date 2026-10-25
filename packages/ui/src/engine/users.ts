import type { PublicUser } from "@veil/shared";
import { kvGet, kvSet } from "../lib/db";
import type { CachedUser } from "../lib/types";
import { ctx } from "./context";

const mem = new Map<string, CachedUser>();
const TTL = 5 * 60 * 1000;
let pending: { ids: Set<string>; promise: Promise<void> } | null = null;

export function displayName(u: Pick<PublicUser, "name" | "lastName" | "username"> & { localName?: string } | undefined | null): string {
  if (!u) return "Unknown";
  if (u.localName) return u.localName;
  const n = [u.name, u.lastName].filter(Boolean).join(" ").trim();
  return n || (u.username ? `@${u.username}` : "Veil user");
}

export function cachedUser(id: string): CachedUser | undefined {
  return mem.get(id);
}

async function fetchBatch(ids: string[]) {
  const { users } = await ctx.api.users.batch(ids);
  for (const u of users) {
    const prev = mem.get(u.id);
    const cu: CachedUser = { ...u, fetchedAt: Date.now(), localName: prev?.localName };
    mem.set(u.id, cu);
    await kvSet(`user:${u.id}`, cu);
  }
}

/** Batched, cached user lookups (coalesces concurrent requests into one API call). */
export async function getUsers(ids: string[], force = false): Promise<Map<string, CachedUser>> {
  const want = [...new Set(ids)].filter(Boolean);
  const stale: string[] = [];
  for (const id of want) {
    if (!mem.has(id)) {
      const disk = await kvGet<CachedUser>(`user:${id}`);
      if (disk) mem.set(id, disk);
    }
    const u = mem.get(id);
    if (force || !u || Date.now() - u.fetchedAt > TTL) stale.push(id);
  }
  if (stale.length) {
    const missing = stale.filter((id) => !mem.has(id));
    const run = async () => {
      if (!pending) {
        const ids2 = new Set(stale);
        pending = {
          ids: ids2,
          promise: new Promise<void>((resolve) => setTimeout(resolve, 15)).then(async () => {
            const batch = [...ids2];
            pending = null;
            for (let i = 0; i < batch.length; i += 400) await fetchBatch(batch.slice(i, i + 400));
          }),
        };
      } else stale.forEach((id) => pending!.ids.add(id));
      return pending.promise;
    };
    const p = run().catch(() => {});
    if (missing.length) await p; // only block when we have nothing to show
  }
  return new Map(want.filter((id) => mem.has(id)).map((id) => [id, mem.get(id)!]));
}

export async function getUser(id: string, force = false): Promise<CachedUser | undefined> {
  return (await getUsers([id], force)).get(id);
}

export function primeUser(u: PublicUser) {
  const prev = mem.get(u.id);
  const cu = { ...u, fetchedAt: Date.now(), localName: prev?.localName };
  mem.set(u.id, cu);
  void kvSet(`user:${u.id}`, cu);
}

export async function setLocalName(id: string, name: string | undefined) {
  const u = mem.get(id) ?? (await kvGet<CachedUser>(`user:${id}`));
  if (!u) return;
  u.localName = name || undefined;
  mem.set(id, u);
  await kvSet(`user:${id}`, u);
}

export function updatePresence(userId: string, online: boolean, lastSeenAt: number | null, approx?: string) {
  const u = mem.get(userId);
  if (!u) return;
  u.presence = approx
    ? { online: false, lastSeenAt: null, approx: approx as "recently" }
    : { online, lastSeenAt: lastSeenAt ?? u.presence?.lastSeenAt ?? null, approx: null };
}
