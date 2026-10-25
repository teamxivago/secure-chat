import "server-only";
import { getDb, schema, and, eq, inArray, or } from "@veil/database";
import { coarsenLastSeen, type MeUser, type PublicUser, type Visibility } from "@veil/shared";
import { redis } from "./redis";

type UserRow = typeof schema.user.$inferSelect;

export async function contactSet(ownerId: string, others: string[]): Promise<Set<string>> {
  if (!others.length) return new Set();
  const rows = await getDb()
    .select({ c: schema.contact.contactUserId })
    .from(schema.contact)
    .where(and(eq(schema.contact.ownerId, ownerId), inArray(schema.contact.contactUserId, others)));
  return new Set(rows.map((r) => r.c));
}

/** Users (among `others`) who have `viewerId` in THEIR contacts — governs "contacts only" visibility. */
export async function reverseContactSet(viewerId: string, others: string[]): Promise<Set<string>> {
  if (!others.length) return new Set();
  const rows = await getDb()
    .select({ o: schema.contact.ownerId })
    .from(schema.contact)
    .where(and(eq(schema.contact.contactUserId, viewerId), inArray(schema.contact.ownerId, others)));
  return new Set(rows.map((r) => r.o));
}

export async function blockState(viewerId: string, others: string[]) {
  if (!others.length) return { blocked: new Set<string>(), blockedMe: new Set<string>() };
  const rows = await getDb()
    .select()
    .from(schema.blockedUser)
    .where(
      or(
        and(eq(schema.blockedUser.userId, viewerId), inArray(schema.blockedUser.blockedUserId, others)),
        and(eq(schema.blockedUser.blockedUserId, viewerId), inArray(schema.blockedUser.userId, others)),
      ),
    );
  const blocked = new Set<string>();
  const blockedMe = new Set<string>();
  for (const r of rows) {
    if (r.userId === viewerId) blocked.add(r.blockedUserId);
    else blockedMe.add(r.userId);
  }
  return { blocked, blockedMe };
}

export async function onlineUsers(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const flags = await redis().mget(ids.map((i) => `online:user:${i}`));
  return new Set(ids.filter((_, i) => flags[i]));
}

const allowed = (v: string, isOwner: boolean, theyHaveMeAsContact: boolean) =>
  isOwner || v === "everyone" || (v === "contacts" && theyHaveMeAsContact);

/** Projects users for a viewer, applying privacy settings and blocks. */
export async function publicUsers(viewerId: string, rows: UserRow[]): Promise<PublicUser[]> {
  const ids = rows.map((r) => r.id);
  const [myContacts, theirContacts, blocks, online] = await Promise.all([
    contactSet(viewerId, ids),
    reverseContactSet(viewerId, ids),
    blockState(viewerId, ids),
    onlineUsers(ids),
  ]);
  return rows.map((u) => {
    const self = u.id === viewerId;
    const theyHaveMe = theirContacts.has(u.id);
    const blockedMe = blocks.blockedMe.has(u.id);
    const showLastSeen = !blockedMe && allowed(u.lastSeenVisibility, self, theyHaveMe);
    const showPhone = !blockedMe && allowed(u.phoneVisibility, self, theyHaveMe);
    const showPhoto = !blockedMe && allowed(u.profilePhotoVisibility, self, theyHaveMe);
    const lastSeen = u.lastSeenAt ? u.lastSeenAt.getTime() : null;
    return {
      id: u.id,
      name: u.name,
      lastName: u.lastName,
      username: u.displayUsername ?? u.username,
      bio: blockedMe ? null : u.bio,
      avatarMediaId: showPhoto ? u.avatarMediaId : null,
      avatarKey: showPhoto ? u.avatarKey : null,
      emojiStatus: blockedMe ? null : u.emojiStatus,
      phoneNumber: showPhone ? u.phoneNumber : null,
      presence: showLastSeen
        ? { online: online.has(u.id), lastSeenAt: lastSeen, approx: null }
        : { online: false, lastSeenAt: null, approx: blockedMe ? "long" : coarsenLastSeen(lastSeen) },
      isContact: myContacts.has(u.id),
      blocked: blocks.blocked.has(u.id),
      blockedMe,
    };
  });
}

export async function publicUser(viewerId: string, id: string): Promise<PublicUser | null> {
  const rows = await getDb().select().from(schema.user).where(eq(schema.user.id, id)).limit(1);
  if (!rows[0]) return null;
  return (await publicUsers(viewerId, rows))[0];
}

export async function meUser(userId: string): Promise<MeUser> {
  const [u] = await getDb().select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  const [pub] = await publicUsers(userId, [u]);
  return {
    ...pub,
    email: u.email.endsWith("@phone.veil.invalid") ? null : u.email,
    phoneNumber: u.phoneNumber,
    usernameChangedAt: u.usernameChangedAt?.getTime() ?? null,
    privacy: {
      phoneVisibility: u.phoneVisibility as Visibility,
      lastSeenVisibility: u.lastSeenVisibility as Visibility,
      profilePhotoVisibility: u.profilePhotoVisibility as Visibility,
      phoneDiscoverable: u.phoneDiscoverable,
    },
    hasAccountKeyBackup: !!u.accountKeyBackup,
    onboarded: u.onboarded,
  };
}
