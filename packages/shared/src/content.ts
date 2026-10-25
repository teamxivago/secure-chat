import { z } from "zod";
import { BIO_MAX, DISPLAY_NAME_MAX, MAX_POLL_OPTIONS, USERNAME_RE } from "./constants";

/**
 * Everything in this file travels ONLY inside end-to-end encrypted payloads.
 * The server never sees these structures in plaintext.
 */

export const attachmentSchema = z.object({
  mediaId: z.string(),
  key: z.string(), // b64 64-byte media key
  digest: z.string().optional(),
  size: z.number().int().nonnegative(),
  encryptedSize: z.number().int().nonnegative(),
  mime: z.string().max(200),
  name: z.string().max(255).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  waveform: z.array(z.number().min(0).max(1)).max(128).optional(),
  thumbnail: z.string().max(60_000).optional(), // tiny data-url preview, encrypted with the message
  deleteToken: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const linkPreviewSchema = z.object({
  url: z.string().url(),
  kind: z.enum(["generic", "youtube", "twitter", "instagram"]).default("generic"),
  title: z.string().max(300).optional(),
  description: z.string().max(1000).optional(),
  siteName: z.string().max(100).optional(),
  image: z.string().max(2000).optional(),
  favicon: z.string().max(2000).optional(),
  author: z.string().max(200).optional(),
  videoId: z.string().max(100).optional(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

export const mediaKinds = ["photo", "video", "audio", "voice", "document", "sticker", "gif"] as const;
export type MediaKind = (typeof mediaKinds)[number];

export const contentSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("text"),
    text: z.string().min(1).max(4096),
    preview: linkPreviewSchema.nullish(),
    noPreview: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("media"),
    kind: z.enum(mediaKinds),
    attachment: attachmentSchema,
    caption: z.string().max(1024).optional(),
    onceView: z.object({ ttl: z.number().int().positive() }).optional(),
    sticker: z.object({ packId: z.string(), stickerId: z.string(), emoji: z.string().optional(), url: z.string() }).optional(),
    gif: z.object({ url: z.string(), previewUrl: z.string().optional(), width: z.number(), height: z.number() }).optional(),
  }),
  z.object({
    t: z.literal("location"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    label: z.string().max(200).optional(),
    address: z.string().max(300).optional(),
  }),
  z.object({
    t: z.literal("contact"),
    name: z.string().max(128),
    phone: z.string().max(32).optional(),
    userId: z.string().optional(),
    username: z.string().optional(),
  }),
  z.object({
    t: z.literal("poll"),
    question: z.string().min(1).max(300),
    options: z.array(z.object({ id: z.string(), text: z.string().min(1).max(100) })).min(2).max(MAX_POLL_OPTIONS),
    anonymous: z.boolean(),
    multiple: z.boolean(),
    quiz: z.object({ correctOptionId: z.string(), explanation: z.string().max(200).optional() }).optional(),
    closesAt: z.number().optional(),
  }),
  z.object({
    t: z.literal("event"),
    title: z.string().min(1).max(200),
    startsAt: z.number(),
    endsAt: z.number().optional(),
    location: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  }),
  z.object({
    t: z.literal("call"),
    callId: z.string(),
    video: z.boolean(),
    outcome: z.enum(["completed", "missed", "declined", "cancelled", "busy"]),
    duration: z.number().nonnegative(),
  }),
  z.object({
    t: z.literal("system"),
    action: z.enum([
      "created",
      "joined",
      "left",
      "added",
      "removed",
      "title",
      "photo",
      "pinned",
      "screenshot",
      "keysRotated",
      "identityChanged",
    ]),
    actorId: z.string().optional(),
    targetIds: z.array(z.string()).optional(),
    text: z.string().max(300).optional(),
  }),
]);
export type Content = z.infer<typeof contentSchema>;

export const messageMetaSchema = z.object({
  replyTo: z.object({ id: z.string(), senderId: z.string(), snippet: z.string().max(200) }).optional(),
  forwardedFrom: z.object({ name: z.string().max(128), userId: z.string().optional(), chatId: z.string().optional() }).optional(),
  threadId: z.string().optional(),
  mentions: z.array(z.string()).max(50).optional(),
  silent: z.boolean().optional(),
});

/** A chat message as carried inside an encrypted envelope. */
export const messagePayloadSchema = z.object({
  kind: z.literal("message"),
  id: z.string().uuid(),
  chatId: z.string(), // "u:<peerUserId>" for direct chats as seen by the sender, or group/channel id
  ts: z.number(),
  content: contentSchema,
  meta: messageMetaSchema.default({}),
});
export type MessagePayload = z.infer<typeof messagePayloadSchema>;

export const eventPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), chatId: z.string(), targetId: z.string(), content: contentSchema, ts: z.number() }),
  z.object({ kind: z.literal("delete"), chatId: z.string(), targetIds: z.array(z.string()).min(1).max(100), ts: z.number() }),
  z.object({ kind: z.literal("reaction"), chatId: z.string(), targetId: z.string(), emoji: z.string().max(16), remove: z.boolean().optional(), ts: z.number() }),
  z.object({ kind: z.literal("receipt"), chatId: z.string(), status: z.enum(["delivered", "read"]), ids: z.array(z.string()).max(500), ts: z.number() }),
  z.object({ kind: z.literal("typing"), chatId: z.string(), action: z.enum(["typing", "recording", "uploading", "stop"]) }),
  z.object({ kind: z.literal("pollVote"), chatId: z.string(), pollId: z.string(), optionIds: z.array(z.string()).max(10), ts: z.number() }),
  z.object({ kind: z.literal("pollClose"), chatId: z.string(), pollId: z.string(), ts: z.number() }),
  z.object({ kind: z.literal("rsvp"), chatId: z.string(), eventId: z.string(), status: z.enum(["going", "maybe", "declined"]), ts: z.number() }),
  z.object({ kind: z.literal("pin"), chatId: z.string(), targetId: z.string(), unpin: z.boolean().optional(), ts: z.number() }),
  z.object({ kind: z.literal("onceViewed"), chatId: z.string(), targetId: z.string(), ts: z.number() }),
  z.object({ kind: z.literal("screenshot"), chatId: z.string(), targetId: z.string().optional(), ts: z.number() }),
  z.object({
    kind: z.literal("senderKey"),
    chatId: z.string(),
    distribution: z.object({
      distributionId: z.string(),
      chainId: z.number(),
      iteration: z.number(),
      chainKey: z.string(),
      signingKey: z.string(),
    }),
  }),
  z.object({ kind: z.literal("senderKeyRequest"), chatId: z.string(), distributionId: z.string() }),
  z.object({
    kind: z.literal("call"),
    callId: z.string(),
    chatId: z.string(),
    action: z.enum(["offer", "answer", "ice", "ringing", "accept", "reject", "busy", "hangup", "hold", "unhold", "renegotiate", "mute"]),
    video: z.boolean().optional(),
    group: z.boolean().optional(),
    sdp: z.string().max(100_000).optional(),
    candidate: z.string().max(4000).optional(),
    sdpMid: z.string().nullish(),
    sdpMLineIndex: z.number().nullish(),
    muted: z.boolean().optional(),
    ts: z.number(),
  }),
  z.object({
    kind: z.literal("sync"),
    // Sent transcript / state for the sender's own other devices
    sent: z.object({ to: z.string(), message: messagePayloadSchema }).optional(),
    read: z.object({ chatId: z.string(), upTo: z.number() }).optional(),
  }),
  z.object({ kind: z.literal("profileKey"), profileKey: z.string() }),
  z.object({ kind: z.literal("nullMessage") }),
]);
export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const payloadSchema = z.union([messagePayloadSchema, eventPayloadSchema]);
export type Payload = z.infer<typeof payloadSchema>;

/* ---------------- public API validation (server-visible) ---------------- */

export const usernameSchema = z.string().regex(USERNAME_RE, "5–32 characters: letters, digits and underscore; must start with a letter");
export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(DISPLAY_NAME_MAX).optional(),
  lastName: z.string().trim().max(DISPLAY_NAME_MAX).optional(),
  username: usernameSchema.optional(),
  bio: z.string().max(BIO_MAX).optional(),
  avatarMediaId: z.string().nullable().optional(),
  avatarKey: z.string().nullable().optional(),
  emojiStatus: z.string().max(16).nullable().optional(),
});
export const privacySchema = z.object({
  phoneVisibility: z.enum(["everyone", "contacts", "nobody"]).optional(),
  lastSeenVisibility: z.enum(["everyone", "contacts", "nobody"]).optional(),
  profilePhotoVisibility: z.enum(["everyone", "contacts", "nobody"]).optional(),
  phoneDiscoverable: z.boolean().optional(),
});

export const createChatSchema = z.object({
  type: z.enum(["group", "channel"]),
  title: z.string().trim().min(1).max(128),
  description: z.string().max(255).optional(),
  username: usernameSchema.optional(),
  isPublic: z.boolean().default(false),
  memberIds: z.array(z.string()).max(200).default([]),
  avatarMediaId: z.string().optional(),
  avatarKey: z.string().optional(),
});

export const updateChatSchema = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(255).optional(),
  username: usernameSchema.nullable().optional(),
  isPublic: z.boolean().optional(),
  avatarMediaId: z.string().nullable().optional(),
  avatarKey: z.string().nullable().optional(),
  slowModeSeconds: z.number().int().refine((v) => [0, 10, 30, 60, 300, 900].includes(v)).optional(),
  reactionsMode: z.enum(["all", "some", "none"]).optional(),
  allowedReactions: z.array(z.string().max(16)).max(50).optional(),
  defaultPermissions: z.record(z.string(), z.boolean()).optional(),
  joinApproval: z.boolean().optional(),
  signMessages: z.boolean().optional(),
  hideSubscriberCount: z.boolean().optional(),
  linkedChatId: z.string().nullable().optional(),
});

export const inviteLinkSchema = z.object({
  name: z.string().max(32).optional(),
  expiresIn: z.number().int().min(0).max(31_536_000).default(0),
  usageLimit: z.number().int().min(0).max(100_000).default(0),
  requiresApproval: z.boolean().default(false),
});
