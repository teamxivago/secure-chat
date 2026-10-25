"use client";
import { BadgeCheck } from "lucide-react";
import { isDirectChatId, peerFromChatId, presenceLabel } from "@veil/shared";
import { ctx, displayName } from "../engine";
import { useUser } from "../hooks";
import type { LocalChat } from "../lib/types";
import { plural } from "../lib/format";
import { Avatar } from "./avatar";

/** Resolves display name/avatar/status for any chat type. */
export function useChatIdentity(chat: LocalChat | null) {
  const peerId = chat && isDirectChatId(chat.id) ? peerFromChatId(chat.id) : null;
  const peer = useUser(peerId);
  if (!chat) return { name: "", subtitle: "", peerId: null, peer: undefined, kind: "user" as const };
  const isSelf = peerId === ctx.account?.userId;
  if (isSelf) return { name: "Saved Messages", subtitle: "your cloud notes · end-to-end encrypted", peerId, peer, kind: "self" as const };
  if (peerId) {
    const blocked = peer?.blocked || peer?.blockedMe;
    return {
      name: displayName(peer),
      subtitle: blocked ? "" : peer?.presence ? presenceLabel(peer.presence) : "",
      peerId,
      peer,
      kind: "user" as const,
      online: !blocked && !!peer?.presence?.online,
    };
  }
  const s = chat.summary;
  const count = s?.memberCount ?? 0;
  return {
    name: chat.title ?? s?.title ?? "Group",
    subtitle: chat.type === "channel" ? (count >= 0 ? plural(count, "subscriber") : "channel") : count >= 0 ? plural(count, "member") : "group",
    peerId: null,
    peer: undefined,
    kind: (chat.type === "channel" ? "channel" : "group") as "channel" | "group",
  };
}

export function ChatAvatar({ chat, size = 52 }: { chat: LocalChat; size?: number }) {
  const id = useChatIdentity(chat);
  if (id.kind === "self") return <Avatar id={chat.id} name="Saved" kind="self" size={size} />;
  if (id.peerId) {
    return <Avatar id={id.peerId} name={id.name} mediaId={id.peer?.avatarMediaId} mediaKey={id.peer?.avatarKey} size={size} online={"online" in id && id.online} />;
  }
  return <Avatar id={chat.id} name={id.name} mediaId={chat.summary?.avatarMediaId} mediaKey={chat.summary?.avatarKey} size={size} kind={id.kind} />;
}

export function Verified() {
  return <BadgeCheck className="h-4 w-4 shrink-0 fill-accent text-white" />;
}
