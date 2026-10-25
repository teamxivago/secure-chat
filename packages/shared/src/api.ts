import type { AdminRights, ChatRole, MemberPermissions, Visibility } from "./constants";
import type { PreKeyBundleWireT } from "./wire";

/** Server-visible API DTOs. */

export interface PublicUser {
  id: string;
  name: string;
  lastName?: string | null;
  username: string | null;
  bio?: string | null;
  avatarMediaId?: string | null;
  avatarKey?: string | null;
  emojiStatus?: string | null;
  phoneNumber?: string | null;
  presence?: { online: boolean; lastSeenAt: number | null; approx: "recently" | "week" | "month" | "long" | null };
  isContact?: boolean;
  blocked?: boolean;
  blockedMe?: boolean;
}

export interface MeUser extends PublicUser {
  email?: string | null;
  phoneNumber?: string | null;
  usernameChangedAt?: number | null;
  privacy: { phoneVisibility: Visibility; lastSeenVisibility: Visibility; profilePhotoVisibility: Visibility; phoneDiscoverable: boolean };
  hasAccountKeyBackup: boolean;
  onboarded: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  status: "pending" | "active";
  createdAt: number;
  lastSeenAt: number | null;
  current?: boolean;
  ip?: string | null;
  location?: string | null;
}

export interface ChatSummary {
  id: string;
  type: "group" | "channel";
  title: string;
  description: string | null;
  username: string | null;
  isPublic: boolean;
  avatarMediaId: string | null;
  avatarKey: string | null;
  memberCount: number;
  myRole: ChatRole | null;
  myRights: AdminRights;
  defaultPermissions: MemberPermissions;
  slowModeSeconds: number;
  reactionsMode: "all" | "some" | "none";
  allowedReactions: string[];
  joinApproval: boolean;
  signMessages: boolean;
  hideSubscriberCount: boolean;
  linkedChatId: string | null;
  keyEpoch: number;
  lastSeq: number;
  joinedSeq: number;
  pinnedIds: string[];
  createdAt: number;
}

export interface ChatMemberInfo {
  userId: string;
  role: ChatRole;
  rights: AdminRights;
  title?: string | null;
  joinedAt: number;
  user: PublicUser;
}

export interface GroupMessageWire {
  id: string;
  chatId: string;
  seq: number;
  ciphertext: string;
  ts: number;
  editedAt?: number | null;
  views?: number;
  kind?: string;
  deleteIds?: string[];
  /** Present only for channels with signatures disabled → null; otherwise server can't attribute. */
  mine?: boolean;
}

export interface EnvelopeWire {
  id: string;
  type: number;
  content: string;
  ts: number;
  sealed: boolean;
  senderUserId?: string | null;
  senderDeviceId?: string | null;
  ephemeral?: boolean;
}

export interface OutgoingEnvelope {
  userId: string;
  deviceId: string;
  registrationId: number;
  type: number;
  content: string;
}

export type SendResult =
  | { ok: true; ts: number }
  | { ok: false; error: "mismatched"; missing: { userId: string; deviceId: string }[]; extra: { userId: string; deviceId: string }[] }
  | { ok: false; error: "stale"; stale: { userId: string; deviceId: string }[] }
  | { ok: false; error: string };

export type { PreKeyBundleWireT };
