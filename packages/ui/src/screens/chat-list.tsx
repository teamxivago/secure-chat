"use client";
import { AnimatePresence, motion, useAnimation, type PanInfo } from "framer-motion";
import { Archive, ArchiveRestore, BellOff, Bell, Check, CheckCheck, Clock, Edit3, Megaphone, MessageSquarePlus, Pin, PinOff, Search, Trash2, Users, AlertCircle, ChevronLeft, MailOpen } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { directChatId } from "@veil/shared";
import { ctx, deleteChatLocal, displayName, markRead, muteChat, refreshServerChats, setChatFlags, cachedUser } from "../engine";
import { useChats, useConnection, useNow, useTypingAll } from "../hooks";
import { cn } from "../lib/cn";
import { formatChatTime } from "../lib/format";
import { haptic } from "../lib/native";
import type { LocalChat } from "../lib/types";
import { useUI } from "../store/ui";
import { Badge, EmptyState, IconButton, Spinner } from "../components/primitives";
import { Menu, useConfirm } from "../components/overlays";
import { ChatAvatar, useChatIdentity } from "../components/chat-identity";

function StatusIcon({ status }: { status?: string }) {
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-subtle" />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-danger" />;
  if (status === "read") return <CheckCheck className="h-4 w-4 text-accent" />;
  if (status === "delivered") return <CheckCheck className="h-4 w-4 text-subtle" />;
  return <Check className="h-4 w-4 text-subtle" />;
}

function ChatRow({ chat, active, typing }: { chat: LocalChat; active: boolean; typing?: string }) {
  const id = useChatIdentity(chat);
  const openChat = useUI((s) => s.openChat);
  const controls = useAnimation();
  const confirm = useConfirm();
  const now = useNow(60000);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const muted = (chat.mutedUntil ?? 0) > now;
  const isGroupish = chat.type === "group" || chat.type === "channel";
  const senderPrefix =
    chat.lastOutgoing && chat.type !== "channel" && chat.type !== "self" ? "You" : isGroupish && chat.lastSenderId && chat.type === "group" ? displayName(cachedUser(chat.lastSenderId)).split(" ")[0] : null;

  async function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x < -90) {
      void haptic("light");
      await controls.start({ x: -400, opacity: 0, transition: { duration: 0.18 } });
      await setChatFlags(chat.id, { archived: !chat.archived });
      toast(chat.archived ? "Chat unarchived" : "Chat archived", {
        action: { label: "Undo", onClick: () => void setChatFlags(chat.id, { archived: chat.archived }) },
      });
      controls.set({ x: 0, opacity: 1 });
    } else void controls.start({ x: 0, transition: { type: "spring", stiffness: 500, damping: 35 } });
  }

  const actions = [
    { label: chat.pinned ? "Unpin" : "Pin", icon: chat.pinned ? <PinOff /> : <Pin />, onSelect: () => setChatFlags(chat.id, { pinned: !chat.pinned }) },
    {
      label: muted ? "Unmute" : "Mute",
      icon: muted ? <Bell /> : <BellOff />,
      onSelect: () => muteChat(chat.id, muted ? null : Number.MAX_SAFE_INTEGER).then(() => toast(muted ? "Notifications on" : "Muted")),
    },
    { label: "Mark as read", icon: <MailOpen />, onSelect: () => markRead(chat.id), hidden: !chat.unread },
    { label: chat.archived ? "Unarchive" : "Archive", icon: chat.archived ? <ArchiveRestore /> : <Archive />, onSelect: () => setChatFlags(chat.id, { archived: !chat.archived }) },
    {
      label: "Delete chat",
      icon: <Trash2 />,
      danger: true,
      hidden: isGroupish,
      onSelect: async () => {
        const r = await confirm({ title: `Delete chat with ${id.name}?`, body: "Messages are removed from all your devices.", confirm: "Delete", danger: true });
        if (r.ok) await deleteChatLocal(chat.id);
      },
    },
  ];

  return (
    <div
      className="relative overflow-hidden"
      onContextMenu={(e) => {
        e.preventDefault();
        if (pressTimer.current) clearTimeout(pressTimer.current);
        setMenuOpen(true);
      }}
    >
      <div className="absolute inset-y-0 right-0 flex w-28 items-center justify-end bg-accent pr-6 text-white">
        {chat.archived ? <ArchiveRestore className="h-6 w-6" /> : <Archive className="h-6 w-6" />}
      </div>
      <motion.button
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -140, right: 0 }}
        dragElastic={{ left: 0.2, right: 0 }}
        onDragEnd={onDragEnd}
        animate={controls}
        data-testid="chat-row"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          pressTimer.current = setTimeout(() => (void haptic("medium"), setMenuOpen(true)), 500);
        }}
        onPointerCancel={() => pressTimer.current && clearTimeout(pressTimer.current)}
        onPointerUp={() => pressTimer.current && clearTimeout(pressTimer.current)}
        onPointerLeave={() => pressTimer.current && clearTimeout(pressTimer.current)}
        onClick={() => {
          if (menuOpen) return;
          void haptic("light");
          openChat(chat.id);
        }}
        className={cn("relative flex w-full items-center gap-3 bg-bg px-3 py-2 text-left transition-colors", active ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg))]" : "hover:bg-surface")}
      >
        <ChatAvatar chat={chat} size={54} />
        <div className="min-w-0 flex-1 border-b border-border py-1.5">
          <div className="flex items-center gap-1.5">
            {chat.type === "channel" && <Megaphone className="h-4 w-4 shrink-0 text-muted" />}
            {chat.type === "group" && <Users className="h-4 w-4 shrink-0 text-muted" />}
            <span className="truncate text-[16px] font-semibold">{id.name}</span>
            {muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-subtle" />}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
              {chat.lastOutgoing && chat.type !== "channel" && <StatusIcon status={chat.lastStatus} />}
              {chat.lastMessageId ? formatChatTime(chat.lastTs, now) : ""}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <p className="line-clamp-1 flex-1 text-[15px] text-muted">
              {typing ? (
                <span className="text-accent">{typing === "recording" ? "recording voice…" : typing === "uploading" ? "sending file…" : "typing…"}</span>
              ) : chat.draft?.text ? (
                <>
                  <span className="text-danger">Draft: </span>
                  {chat.draft.text}
                </>
              ) : (
                <>
                  {senderPrefix && <span className="text-text">{senderPrefix}: </span>}
                  {chat.lastPreview || (chat.summary ? (chat.type === "channel" ? "Channel created" : "Group created") : "")}
                </>
              )}
            </p>
            {chat.mentions > 0 && <Badge className="w-5 px-0">@</Badge>}
            {chat.unread > 0 ? <Badge muted={muted}>{chat.unread > 999 ? "999+" : chat.unread}</Badge> : chat.pinned ? <Pin className="h-4 w-4 rotate-45 text-subtle" /> : null}
          </div>
        </div>
      </motion.button>
      <div className="pointer-events-none absolute right-6 top-6">
        <Menu open={menuOpen} onOpenChange={setMenuOpen} items={actions} trigger={<span className="block h-1 w-1" aria-hidden />} />
      </div>
    </div>
  );
}

export function ChatListScreen() {
  const { chats, loading } = useChats();
  const typing = useTypingAll();
  const { activeChatId, showArchived, set, openChat } = useUI();
  const conn = useConnection();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => chats.filter((c) => c.archived === showArchived), [chats, showArchived]);
  const archived = useMemo(() => chats.filter((c) => c.archived), [chats]);
  const archivedUnread = archived.reduce((n, c) => n + (c.unread ? 1 : 0), 0);

  async function refresh() {
    setRefreshing(true);
    void haptic("light");
    try {
      await refreshServerChats();
    } catch {
      /* offline */
    }
    setTimeout(() => setRefreshing(false), 400);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top shrink-0 px-4 pb-2">
        <div className="flex h-14 items-center gap-2">
          {showArchived ? (
            <>
              <IconButton label="Back" onClick={() => set({ showArchived: false })}>
                <ChevronLeft className="h-6 w-6" />
              </IconButton>
              <h1 className="text-[22px] font-semibold tracking-tight">Archived</h1>
            </>
          ) : (
            <h1 className="flex items-center gap-2 text-[26px] font-bold tracking-tight">
              {conn === "online" ? "Chats" : conn === "syncing" ? "Updating…" : conn === "connecting" ? "Connecting…" : "Waiting for network…"}
              {conn !== "online" && <Spinner className="h-4 w-4" />}
            </h1>
          )}
          <div className="ml-auto flex gap-1">
            <IconButton label="New message" onClick={() => set({ newChat: "menu" })}>
              <Edit3 className="h-5 w-5" />
            </IconButton>
          </div>
        </div>
        <button
          onClick={() => set({ globalSearch: true })}
          className="flex h-10 w-full items-center gap-2 rounded-xl bg-surface px-3 text-[15px] text-subtle transition hover:bg-surface-2"
          data-testid="global-search"
        >
          <Search className="h-4 w-4" /> Search
        </button>
      </header>

      <div
        ref={listRef}
        className="relative flex-1 overflow-y-auto overscroll-contain"
        onTouchStart={(e) => listRef.current && listRef.current.scrollTop === 0 && (listRef.current.dataset.y = String(e.touches[0].clientY))}
        onTouchMove={(e) => {
          const y0 = Number(listRef.current?.dataset.y ?? NaN);
          if (!Number.isNaN(y0)) setPull(Math.max(0, Math.min(90, (e.touches[0].clientY - y0) / 2)));
        }}
        onTouchEnd={() => {
          if (pull > 60) void refresh();
          setPull(0);
          if (listRef.current) delete listRef.current.dataset.y;
        }}
      >
        <div className="flex items-center justify-center overflow-hidden transition-[height]" style={{ height: refreshing ? 44 : pull }}>
          <Spinner className={cn(!refreshing && "animate-none")} />
        </div>

        {!showArchived && archived.length > 0 && (
          <button onClick={() => set({ showArchived: true })} className="flex w-full items-center gap-3 px-3 py-2 hover:bg-surface">
            <div className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-surface-2 text-muted">
              <Archive className="h-6 w-6" />
            </div>
            <div className="flex-1 border-b border-border py-3 text-left">
              <span className="text-[16px] font-semibold">Archived Chats</span>
              <p className="text-sm text-muted">{archived.length} chats</p>
            </div>
            {archivedUnread > 0 && <Badge muted>{archivedUnread}</Badge>}
          </button>
        )}

        {loading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<MessageSquarePlus className="h-8 w-8" />}
            title={showArchived ? "No archived chats" : "No chats yet"}
            body={showArchived ? "Swipe a chat left to archive it." : "Start an end-to-end encrypted conversation."}
            action={
              !showArchived && (
                <div className="flex gap-2">
                  <button className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white" onClick={() => set({ newChat: "menu" })}>
                    New message
                  </button>
                  <button className="rounded-xl bg-surface px-4 py-2 text-sm font-medium" onClick={() => openChat(directChatId(ctx.userId))}>
                    Saved Messages
                  </button>
                </div>
              )
            }
          />
        ) : (
          <AnimatePresence initial={false}>
            {visible.map((c, i) => (
              <motion.div key={c.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.02 } }} exit={{ opacity: 0, height: 0 }}>
                <ChatRow chat={c} active={c.id === activeChatId} typing={typing[c.id]} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
        <div className="h-24" />
      </div>

      <motion.button
        whileTap={{ scale: 0.92 }}
        onClick={() => {
          void haptic("medium");
          set({ newChat: "menu" });
        }}
        aria-label="New chat"
        className="absolute bottom-24 right-5 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-float md:bottom-20"
      >
        <MessageSquarePlus className="h-6 w-6" />
      </motion.button>
    </div>
  );
}

