import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL schema. Privacy model:
 *  - Every message, reaction, edit, receipt, poll vote, RSVP, draft, link preview attached to a
 *    message, and media key exists on the server ONLY as ciphertext (envelope.content,
 *    group_message.ciphertext, vault_record.data). Columns that hold ciphertext are bytea/text
 *    blobs the server cannot decrypt.
 *  - Polls, events, reactions, read receipts, edits and drafts are therefore not modelled as
 *    plaintext rows; they live encrypted inside those blobs and are materialized on devices.
 *  - Only public key material is stored (identity_key, signed_pre_key, one_time_pre_key).
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/* ------------------------------ better-auth ------------------------------ */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    // username plugin
    username: text("username").unique(),
    displayUsername: text("display_username"),
    // phone-number plugin
    phoneNumber: text("phone_number").unique(),
    phoneNumberVerified: boolean("phone_number_verified").default(false),
    // Veil profile
    lastName: text("last_name"),
    bio: text("bio"),
    avatarMediaId: text("avatar_media_id"),
    /** Avatar media key. Avatars are profile data shown to anyone allowed to view the profile;
     *  the blob in R2 is still ciphertext and the key is only released subject to privacy rules. */
    avatarKey: text("avatar_key"),
    emojiStatus: text("emoji_status"),
    usernameChangedAt: ts("username_changed_at"),
    lastSeenAt: ts("last_seen_at"),
    phoneVisibility: text("phone_visibility").notNull().default("contacts"),
    lastSeenVisibility: text("last_seen_visibility").notNull().default("everyone"),
    profilePhotoVisibility: text("profile_photo_visibility").notNull().default("everyone"),
    phoneDiscoverable: boolean("phone_discoverable").notNull().default(true),
    /** OPRF token of the verified phone number for private contact discovery. */
    discoveryToken: text("discovery_token"),
    /** Account Storage Key wrapped with the user's recovery key (server can't unwrap). */
    accountKeyBackup: text("account_key_backup"),
    /** sha256(HKDF(ASK, "verifier")): lets a recovering device prove it knows the ASK. */
    accountKeyVerifier: text("account_key_verifier"),
    onboarded: boolean("onboarded").notNull().default(false),
    /** Global DND, quiet hours etc. (non-content preferences used by the push service). */
    notificationSettings: jsonb("notification_settings").$type<{
      dnd?: boolean;
      quietHours?: { start: string; end: string; tz: string } | null;
      previews?: boolean;
      sound?: string;
      groupSound?: string;
      channelSound?: string;
      vibrate?: boolean;
    }>(),
  },
  (t) => [index("user_discovery_idx").on(t.discoveryToken)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/* ------------------------------ devices & keys ------------------------------ */

export const device = pgTable(
  "device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    platform: text("platform").notNull(), // web | ios | android | desktop
    /** pending: logged in but not yet approved by an existing device; receives no messages. */
    status: text("status").notNull().default("pending"),
    registrationId: integer("registration_id").notNull(),
    pushToken: text("push_token"),
    pushPlatform: text("push_platform"),
    voipToken: text("voip_token"),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => [index("device_user_idx").on(t.userId)],
);

export const identityKey = pgTable("identity_key", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => device.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  publicKey: text("public_key").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const signedPreKey = pgTable(
  "signed_pre_key",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    keyId: integer("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    signature: text("signature").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.keyId] })],
);

export const oneTimePreKey = pgTable(
  "one_time_pre_key",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    keyId: integer("key_id").notNull(),
    publicKey: text("public_key").notNull(),
  },
  (t) => [uniqueIndex("otpk_device_key").on(t.deviceId, t.keyId)],
);

/** Group sender-key epochs. Bumped on member removal or admin-initiated rotation; clients
 *  rotate their sender key chain when they observe a new epoch. Keys themselves never touch the server. */
export const senderKeyEpoch = pgTable(
  "sender_key_epoch",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    reason: text("reason").notNull(),
    rotatedBy: text("rotated_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.epoch] })],
);

export const deviceLink = pgTable("device_link", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  deviceId: text("device_id")
    .notNull()
    .references(() => device.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(),
  ephemeralKey: text("ephemeral_key"),
  ciphertext: text("ciphertext"),
  approvedBy: text("approved_by"),
  status: text("status").notNull().default("waiting"), // waiting | approved | rejected
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

/* ------------------------------ 1:1 transport ------------------------------ */

/** Per-device encrypted mailbox. Sealed envelopes carry no sender. Deleted on ack. */
export const envelope = pgTable(
  "envelope",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recipientDeviceId: text("recipient_device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    type: integer("type").notNull(),
    content: bytea("content").notNull(),
    sealed: boolean("sealed").notNull().default(true),
    senderUserId: text("sender_user_id"),
    senderDeviceId: text("sender_device_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("envelope_recipient_idx").on(t.recipientDeviceId, t.id)],
);

/* ------------------------------ groups & channels ------------------------------ */

export const chat = pgTable(
  "chat",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // group | channel
    title: text("title").notNull(),
    description: text("description"),
    username: text("username").unique(),
    isPublic: boolean("is_public").notNull().default(false),
    avatarMediaId: text("avatar_media_id"),
    avatarKey: text("avatar_key"),
    createdBy: text("created_by").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    slowModeSeconds: integer("slow_mode_seconds").notNull().default(0),
    reactionsMode: text("reactions_mode").notNull().default("all"),
    allowedReactions: jsonb("allowed_reactions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    defaultPermissions: jsonb("default_permissions").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    joinApproval: boolean("join_approval").notNull().default(false),
    signMessages: boolean("sign_messages").notNull().default(false),
    hideSubscriberCount: boolean("hide_subscriber_count").notNull().default(false),
    linkedChatId: text("linked_chat_id"),
    keyEpoch: integer("key_epoch").notNull().default(0),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("chat_public_idx").on(t.isPublic, t.type)],
);

export const chatMember = pgTable(
  "chat_member",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | admin | member
    rights: jsonb("rights").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    customTitle: text("custom_title"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
    joinedSeq: bigint("joined_seq", { mode: "number" }).notNull().default(0),
    lastPostAt: ts("last_post_at"),
    invitedBy: text("invited_by"),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] }), index("chat_member_user_idx").on(t.userId)],
);

export const chatBan = pgTable(
  "chat_ban",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    bannedBy: text("banned_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] })],
);

/** Group/channel messages: one ciphertext per message (Sender Keys), fanned out by the server.
 *  sender_tag = HMAC(server pepper, userId:chatId): lets the server authorize "delete own
 *  message" without storing who wrote what in plaintext. */
export const groupMessage = pgTable(
  "group_message",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    senderTag: text("sender_tag").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    /** "message" rows are shown in history; "event" rows carry edits/reactions/votes etc. */
    kind: text("kind").notNull().default("message"),
    /** Opaque ids of messages this (server-authorized) delete event removed. */
    deleteIds: jsonb("delete_ids").$type<string[]>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    editedAt: ts("edited_at"),
    viewCount: integer("view_count").notNull().default(0),
  },
  (t) => [uniqueIndex("group_message_seq").on(t.chatId, t.seq)],
);

export const channelPostView = pgTable(
  "channel_post_view",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => groupMessage.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    viewedAt: ts("viewed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

export const pinnedMessage = pgTable(
  "pinned_message",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: ts("pinned_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] })],
);

export const groupInviteLink = pgTable(
  "group_invite_link",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    name: text("name"),
    createdBy: text("created_by").notNull(),
    expiresAt: ts("expires_at"),
    usageLimit: integer("usage_limit").notNull().default(0),
    usageCount: integer("usage_count").notNull().default(0),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    revoked: boolean("revoked").notNull().default(false),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("invite_chat_idx").on(t.chatId)],
);

export const groupJoinRequest = pgTable(
  "group_join_request",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    inviteId: text("invite_id"),
    status: text("status").notNull().default("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    decidedBy: text("decided_by"),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] })],
);

/* ------------------------------ contacts & blocking ------------------------------ */

/** Contact relationship only (used for "contacts only" privacy rules). Names and phone book
 *  entries live encrypted in the vault. */
export const contact = pgTable(
  "contact",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contactUserId: text("contact_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.contactUserId] }), index("contact_rev_idx").on(t.contactUserId)],
);

export const blockedUser = pgTable(
  "blocked_user",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedUserId: text("blocked_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.blockedUserId] })],
);

/* ------------------------------ media ------------------------------ */

/** Encrypted blobs in R2. The server knows size and owner, never content type or key. */
export const media = pgTable(
  "media",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    objectKey: text("object_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    partSize: integer("part_size"),
    uploadId: text("upload_id"),
    status: text("status").notNull().default("pending"), // pending | complete | deleted
    /** once-view / disappearing: hard deletion deadline enforced by the media worker */
    expiresAt: ts("expires_at"),
    /** sha256(deleteToken); token travels inside the encrypted message so recipients can purge */
    deleteTokenHash: text("delete_token_hash"),
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("media_expiry_idx").on(t.expiresAt), index("media_owner_idx").on(t.ownerUserId)],
);

/* ------------------------------ multi-device vault ------------------------------ */

/** Account-key encrypted records (messages, chats, drafts, settings, contacts). */
export const vaultRecord = pgTable(
  "vault_record",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull(),
    kind: text("kind").notNull(),
    data: text("data"),
    deleted: boolean("deleted").notNull().default(false),
    version: bigint("version", { mode: "number" }).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.recordId] }), index("vault_version_idx").on(t.userId, t.version)],
);

/* ------------------------------ calls ------------------------------ */

export const call = pgTable(
  "call",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id"),
    initiatorId: text("initiator_id").notNull(),
    video: boolean("video").notNull().default(false),
    isGroup: boolean("is_group").notNull().default(false),
    status: text("status").notNull().default("ringing"), // ringing | active | ended
    startedAt: ts("started_at").notNull().defaultNow(),
    connectedAt: ts("connected_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [index("call_chat_idx").on(t.chatId)],
);

export const callParticipant = pgTable(
  "call_participant",
  {
    callId: text("call_id")
      .notNull()
      .references(() => call.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    deviceId: text("device_id"),
    state: text("state").notNull().default("invited"), // invited | ringing | joined | left | declined | missed
    joinedAt: ts("joined_at"),
    leftAt: ts("left_at"),
  },
  (t) => [primaryKey({ columns: [t.callId, t.userId] })],
);

/* ------------------------------ stickers ------------------------------ */

export const stickerPack = pgTable("sticker_pack", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  title: text("title").notNull(),
  author: text("author"),
  animated: boolean("animated").notNull().default(false),
  thumbnailStickerId: text("thumbnail_sticker_id"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sticker = pgTable(
  "sticker",
  {
    id: text("id").primaryKey(),
    packId: text("pack_id")
      .notNull()
      .references(() => stickerPack.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    mime: text("mime").notNull(),
    url: text("url").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("sticker_pack_idx").on(t.packId)],
);

export const userStickerPack = pgTable(
  "user_sticker_pack",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    packId: text("pack_id")
      .notNull()
      .references(() => stickerPack.id, { onDelete: "cascade" }),
    addedAt: ts("added_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.packId] })],
);

/* ------------------------------ notifications ------------------------------ */

export const notificationPreference = pgTable(
  "notification_preference",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** group/channel id, or "direct" / "groups" / "channels" for type defaults */
    scope: text("scope").notNull(),
    mode: text("mode").notNull().default("all"), // all | mentions | none
    mutedUntil: ts("muted_until"),
    sound: text("sound"),
    vibrate: boolean("vibrate").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope] })],
);

/** Non-content system notifications (group invitations, join request decisions, etc.). */
export const notification = pgTable(
  "notification",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("notification_user_idx").on(t.userId, t.id)],
);

/* ------------------------------ link previews ------------------------------ */

/** Cache of public Open Graph metadata keyed by URL hash. Contains no message context. */
export const linkPreview = pgTable("link_preview", {
  urlHash: text("url_hash").primaryKey(),
  url: text("url").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

/* ------------------------------ moderation ------------------------------ */

/** Abuse reports. The reporter voluntarily discloses the reported message plaintext. */
export const report = pgTable("report", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  reporterId: text("reporter_id").notNull(),
  targetUserId: text("target_user_id"),
  chatId: text("chat_id"),
  messageId: text("message_id"),
  reason: text("reason").notNull(),
  disclosedContent: jsonb("disclosed_content"),
  status: text("status").notNull().default("open"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
