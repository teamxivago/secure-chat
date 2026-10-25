import type { ChatSummary, Content, MessagePayload, PublicUser } from "@veil/shared";

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export interface StoredMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderDeviceId?: string;
  ts: number;
  /** Ordering key: group seq (padded) or timestamp. */
  sortKey: string;
  seq?: number;
  content: Content;
  meta: MessagePayload["meta"];
  outgoing: boolean;
  status: MessageStatus;
  editedAt?: number;
  /** emoji → userIds */
  reactions: Record<string, string[]>;
  /** per recipient (groups) */
  receipts: Record<string, { delivered?: number; read?: number }>;
  pollVotes?: Record<string, string[]>;
  pollClosed?: boolean;
  rsvps?: Record<string, "going" | "maybe" | "declined">;
  onceViewedBy?: string[];
  onceViewedLocally?: boolean;
  screenshotBy?: string[];
  views?: number;
  error?: string;
}

export interface LocalChat {
  id: string;
  type: "direct" | "group" | "channel" | "self";
  peerId?: string;
  title?: string;
  lastMessageId?: string;
  lastPreview?: string;
  lastTs: number;
  lastSenderId?: string;
  lastStatus?: MessageStatus;
  lastOutgoing?: boolean;
  unread: number;
  mentions: number;
  pinned: boolean;
  pinnedAt?: number;
  archived: boolean;
  /** Local notification mute (synced across own devices); groups also mute server-side push. */
  mutedUntil?: number | null;
  draft?: { text: string; replyToId?: string; ts: number } | null;
  lastReadTs: number;
  groupCursor?: number;
  pinnedMessageIds?: string[];
  summary?: ChatSummary;
  hidden?: boolean;
  /** remote typing indicator state: userId → expiry */
  typing?: Record<string, { action: string; until: number }>;
}

export interface CachedUser extends PublicUser {
  fetchedAt: number;
  localName?: string;
}

export interface DeviceAddress {
  userId: string;
  deviceId: string;
  registrationId: number;
  identityKey?: string;
}
