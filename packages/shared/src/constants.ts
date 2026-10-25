export const APP_NAME = "Veil";

export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
export const USERNAME_MIN = 5;
export const USERNAME_MAX = 32;
export const BIO_MAX = 70;
export const DISPLAY_NAME_MAX = 64;
export const USERNAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;

export const EDIT_WINDOW_MS = 48 * 3600 * 1000;
export const MAX_PINNED = 5;
export const MAX_GROUP_MEMBERS = 200_000;
export const MAX_GROUP_CALL_PARTICIPANTS = 32;
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
export const MAX_POLL_OPTIONS = 10;

export const SLOW_MODE_OPTIONS = [0, 10, 30, 60, 300, 900] as const;
export const INVITE_EXPIRY_OPTIONS = { never: 0, "1h": 3600, "1d": 86400, "1w": 604800 } as const;
export const ONCE_VIEW_TTLS = { "30s": 30, "1m": 60, "1h": 3600, "1d": 86400, "1w": 604800 } as const;
export const LOCK_TIMEOUTS = { immediate: 0, "1m": 60, "5m": 300, "15m": 900, "30m": 1800 } as const;

export const PREKEY_BATCH = 100;
export const PREKEY_LOW_WATERMARK = 20;
export const SIGNED_PREKEY_ROTATION_MS = 7 * 24 * 3600 * 1000;
export const SENDER_CERT_TTL_MS = 24 * 3600 * 1000;
export const LINK_PREVIEW_TTL_S = 7 * 24 * 3600;

export const DEFAULT_REACTIONS = ["👍", "❤️", "🔥", "😂", "😮", "😢", "🙏", "👏", "🎉", "🤔", "👎", "💯"];

export const ADMIN_RIGHTS = [
  "changeInfo",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "manageReactions",
  "addAdmins",
  "setSlowMode",
  "manageBots",
  "postMessages",
  "manageCalls",
] as const;
export type AdminRight = (typeof ADMIN_RIGHTS)[number];
export type AdminRights = Partial<Record<AdminRight, boolean>>;

export const MEMBER_PERMISSIONS = ["sendMessages", "sendMedia", "sendPolls", "addMembers", "pinMessages", "changeInfo"] as const;
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number];
export type MemberPermissions = Record<MemberPermission, boolean>;
export const DEFAULT_MEMBER_PERMISSIONS: MemberPermissions = {
  sendMessages: true,
  sendMedia: true,
  sendPolls: true,
  addMembers: true,
  pinMessages: false,
  changeInfo: false,
};

export type ChatRole = "owner" | "admin" | "member";
export type Visibility = "everyone" | "contacts" | "nobody";
export type PushPlatform = "fcm" | "apns" | "web";

/** Envelope transport types. */
export const ENVELOPE_WHISPER = 1;
export const ENVELOPE_PREKEY = 3;
export const ENVELOPE_SEALED = 6;
