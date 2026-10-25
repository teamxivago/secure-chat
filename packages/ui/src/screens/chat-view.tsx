"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  Ban,
  Bell,
  BellOff,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Download,
  Forward,
  Flag,
  KeyRound,
  LogOut,
  MoreVertical,
  Phone,
  Pin,
  Search,
  Trash2,
  Video,
  X,
  Eraser,
  Lock,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isDirectChatId, type Content } from "@veil/shared";
import {
  clearHistory,
  contentPreview,
  ctx,
  deleteChatLocal,
  deleteMessages,
  displayName,
  exportChat,
  markRead,
  muteChat,
  pinMessage,
  searchMessages,
  setActiveChat,
  setBlocked,
  startCall,
} from "../engine";
import { getMessage } from "../lib/db";
import { useChat, useMessages, useTyping, useUser, useBus } from "../hooks";
import { cn } from "../lib/cn";
import { dayLabel } from "../lib/format";
import { haptic, shareFile } from "../lib/native";
import type { LocalChat, StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { ChatAvatar, useChatIdentity } from "../components/chat-identity";
import { ComposeBar } from "../components/compose";
import { MessageBubble, MessageMenu } from "../components/message";
import { Menu, useConfirm } from "../components/overlays";
import { EmptyState, IconButton, Spinner } from "../components/primitives";
import { OnceViewViewer } from "../components/viewer";

type Row = { kind: "day"; key: string; label: string } | { kind: "unread"; key: string } | { kind: "msg"; key: string; m: StoredMessage; first: boolean; last: boolean };

const GROUP_GAP = 5 * 60 * 1000;

function buildRows(messages: StoredMessage[], unreadFromTs: number | null): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let unreadPlaced = false;
  messages.forEach((m, i) => {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `d:${day}`, label: dayLabel(m.ts) });
      lastDay = day;
    }
    if (!unreadPlaced && unreadFromTs !== null && !m.outgoing && m.ts > unreadFromTs) {
      rows.push({ kind: "unread", key: "unread" });
      unreadPlaced = true;
    }
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const same = (a?: StoredMessage) => !!a && a.senderId === m.senderId && a.content.t !== "system" && Math.abs(a.ts - m.ts) < GROUP_GAP && new Date(a.ts).toDateString() === day;
    rows.push({ kind: "msg", key: m.id, m, first: !same(prev), last: !same(next) });
  });
  return rows;
}

function TypingDots() {
  return (
    <span className="inline-flex gap-0.5 align-middle">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 rounded-full bg-accent" style={{ animation: `typing-dot 1.2s ${i * 0.15}s infinite` }} />
      ))}
    </span>
  );
}

function Header({ chat, onSearch }: { chat: LocalChat; onSearch: () => void }) {
  const id = useChatIdentity(chat);
  const typing = useTyping(chat.id);
  const { openChat, setPanel, selection, clearSelection, set } = useUI();
  const confirm = useConfirm();
  const firstTyper = useUser(typing[0]?.userId);
  const muted = (chat.mutedUntil ?? 0) > Date.now();
  const isDirect = isDirectChatId(chat.id);
  const isSelf = id.kind === "self";
  const s = chat.summary;

  async function call(video: boolean) {
    try {
      void haptic("heavy");
      if (isDirect && id.peerId) await startCall({ userId: id.peerId }, video, id.name);
      else await startCall({ chatId: chat.id }, video, id.name);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (selection.size > 0) {
    return (
      <SelectionHeader chat={chat} />
    );
  }

  const status = typing.length
    ? chat.type === "group"
      ? `${displayName(firstTyper).split(" ")[0]} ${typing[0].action === "recording" ? "is recording" : "is typing"}`
      : typing[0].action === "recording"
        ? "recording voice"
        : typing[0].action === "uploading"
          ? "sending file"
          : "typing"
    : id.subtitle;

  return (
    <header className="safe-top z-10 shrink-0 border-b border-border bg-bg/85 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-1 px-1.5">
        <IconButton label="Back" className="md:hidden" onClick={() => openChat(null)}>
          <ChevronLeft className="h-7 w-7" />
        </IconButton>
        <button className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 py-1 text-left hover:bg-surface" onClick={() => setPanel(isDirect && id.peerId && !isSelf ? { kind: "user", userId: id.peerId } : { kind: "chat", chatId: chat.id })}>
          <ChatAvatar chat={chat} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-[16px] font-semibold" data-testid="chat-title">
              {id.name}
              {muted && <BellOff className="h-3.5 w-3.5 text-subtle" />}
            </div>
            <div className={cn("truncate text-[13px]", typing.length || ("online" in id && id.online) ? "text-accent" : "text-muted")}>
              {typing.length ? (
                <>
                  {status} <TypingDots />
                </>
              ) : (
                status
              )}
            </div>
          </div>
        </button>
        {!isSelf && isDirect && !id.peer?.blocked && (
          <>
            <IconButton label="Video call" onClick={() => call(true)}>
              <Video className="h-5 w-5" />
            </IconButton>
            <IconButton label="Voice call" onClick={() => call(false)}>
              <Phone className="h-5 w-5" />
            </IconButton>
          </>
        )}
        {chat.type === "group" && s?.myRole && (
          <IconButton label="Group call" onClick={() => call(false)}>
            <Phone className="h-5 w-5" />
          </IconButton>
        )}
        <IconButton label="Search in chat" onClick={onSearch} className="hidden sm:inline-flex">
          <Search className="h-5 w-5" />
        </IconButton>
        <Menu
          trigger={
            <IconButton label="More">
              <MoreVertical className="h-5 w-5" />
            </IconButton>
          }
          items={[
            { label: "Search", icon: <Search />, onSelect: onSearch },
            { label: muted ? "Unmute" : "Mute", icon: muted ? <Bell /> : <BellOff />, onSelect: () => void muteChat(chat.id, muted ? null : Number.MAX_SAFE_INTEGER), hidden: isSelf },
            {
              label: "Export chat",
              icon: <Download />,
              onSelect: async () => {
                const blob = await exportChat(chat.id, id.name, "json");
                await shareFile(blob, `veil-${id.name.replace(/\W+/g, "_")}.json`);
              },
            },
            {
              label: "Export as text",
              icon: <Download />,
              onSelect: async () => shareFile(await exportChat(chat.id, id.name, "txt"), `veil-${id.name.replace(/\W+/g, "_")}.txt`),
            },
            {
              label: "Rotate encryption keys",
              icon: <KeyRound />,
              hidden: !(chat.type !== "direct" && s?.myRights?.changeInfo),
              onSelect: async () => {
                await ctx.api.chats.rotateKeys(chat.id);
                toast("Group keys will rotate on the next message");
              },
            },
            {
              label: "Clear history",
              icon: <Eraser />,
              onSelect: async () => {
                const r = await confirm({ title: "Clear chat history?", confirm: "Clear", danger: true, checkbox: isDirect && !isSelf ? `Also clear for ${id.name}` : undefined });
                if (r.ok) await clearHistory(chat.id, r.checked);
              },
            },
            {
              label: id.peer?.blocked ? "Unblock user" : "Block user",
              icon: <Ban />,
              danger: !id.peer?.blocked,
              hidden: !isDirect || isSelf,
              onSelect: async () => {
                const blocking = !id.peer?.blocked;
                if (blocking) {
                  const r = await confirm({ title: `Block ${id.name}?`, body: "They won't be able to message or call you, or see your profile details.", confirm: "Block", danger: true });
                  if (!r.ok) return;
                }
                await setBlocked(id.peerId!, blocking);
                toast(blocking ? "User blocked" : "User unblocked");
              },
            },
            {
              label: chat.type === "channel" ? "Leave channel" : "Leave group",
              icon: <LogOut />,
              danger: true,
              hidden: isDirect || !s?.myRole,
              onSelect: async () => {
                const r = await confirm({ title: `Leave ${id.name}?`, confirm: "Leave", danger: true });
                if (r.ok) {
                  await ctx.api.chats.leave(chat.id);
                  openChat(null);
                }
              },
            },
            {
              label: "Delete chat",
              icon: <Trash2 />,
              danger: true,
              hidden: !isDirect,
              onSelect: async () => {
                const r = await confirm({ title: "Delete this chat?", body: "It will be removed from all your devices.", confirm: "Delete", danger: true });
                if (r.ok) {
                  await deleteChatLocal(chat.id);
                  openChat(null);
                }
              },
            },
          ]}
        />
      </div>
      <PinnedBar chat={chat} />
    </header>
  );

  function SelectionHeader({ chat }: { chat: LocalChat }) {
    const count = selection.size;
    const canDeleteAll = isDirect || !!s?.myRights?.deleteMessages;
    return (
      <header className="safe-top z-10 shrink-0 border-b border-border bg-bg/85 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-1 px-2">
          <IconButton label="Cancel selection" onClick={clearSelection}>
            <X className="h-6 w-6" />
          </IconButton>
          <span className="flex-1 text-[17px] font-semibold">{count} selected</span>
          <IconButton
            label="Forward"
            onClick={async () => {
              const msgs = (await Promise.all([...selection].map((i) => getMessage(i)))).filter(Boolean) as StoredMessage[];
              set({ forwarding: msgs.sort((a, b) => a.ts - b.ts) });
            }}
          >
            <Forward className="h-5 w-5" />
          </IconButton>
          <IconButton
            label="Report"
            onClick={async () => {
              const msgs = (await Promise.all([...selection].map((i) => getMessage(i)))).filter((m): m is StoredMessage => !!m && !m.outgoing);
              if (msgs.length) set({ reporting: { chatId: chat.id, messages: msgs } });
            }}
          >
            <Flag className="h-5 w-5" />
          </IconButton>
          <IconButton
            label="Delete"
            className="text-danger"
            onClick={async () => {
              const msgs = (await Promise.all([...selection].map((i) => getMessage(i)))).filter(Boolean) as StoredMessage[];
              const allMine = msgs.every((m) => m.outgoing);
              const r = await confirm({ title: `Delete ${count} message${count > 1 ? "s" : ""}?`, confirm: "Delete", danger: true, checkbox: allMine || canDeleteAll ? "Delete for everyone" : undefined });
              if (!r.ok) return;
              await deleteMessages(chat.id, [...selection], r.checked);
              clearSelection();
              void haptic("medium");
            }}
          >
            <Trash2 className="h-5 w-5" />
          </IconButton>
        </div>
      </header>
    );
  }
}

function PinnedBar({ chat }: { chat: LocalChat }) {
  const ids = chat.pinnedMessageIds ?? [];
  const [idx, setIdx] = useState(0);
  const [msg, setMsg] = useState<StoredMessage | null>(null);
  const jumpTo = useUI((s) => s.jumpTo);
  const canUnpin = isDirectChatId(chat.id) || !!chat.summary?.myRights?.pinMessages;
  useEffect(() => setIdx(0), [ids.length]);
  useEffect(() => {
    const id = ids[idx % Math.max(1, ids.length)];
    if (!id) return setMsg(null);
    void getMessage(id).then((m) => setMsg(m ?? null));
  }, [ids, idx]);
  if (!ids.length) return null;
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5">
      <div className="flex h-8 flex-col gap-0.5">
        {ids.slice(0, 5).map((_, i) => (
          <span key={i} className={cn("w-0.5 flex-1 rounded-full", i === idx % ids.length ? "bg-accent" : "bg-accent/30")} />
        ))}
      </div>
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => {
          void haptic("light");
          if (msg) jumpTo(chat.id, msg.id);
          setIdx((i) => (i + 1) % ids.length);
        }}
      >
        <div className="text-[13px] font-semibold text-accent">Pinned message{ids.length > 1 ? ` #${(idx % ids.length) + 1}` : ""}</div>
        <div className="truncate text-[13px] text-muted">{msg ? contentPreview(msg.content) : "Message not available on this device"}</div>
      </button>
      <Pin className="h-4 w-4 text-subtle" />
      {canUnpin && (
        <button aria-label="Unpin" onClick={() => void pinMessage(chat.id, ids[idx % ids.length], true)} className="rounded-full p-1 text-muted hover:bg-surface">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function ChatSearchBar({ chat, onClose, onJump }: { chat: LocalChat; onClose: () => void; onJump: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [results, setResults] = useState<StoredMessage[]>([]);
  const [i, setI] = useState(0);
  const set = useUI((s) => s.set);
  useEffect(() => {
    set({ searchHighlight: q });
    if (q.trim().length < 2 && !from) return setResults([]);
    const t = setTimeout(async () => {
      const r = await searchMessages(q, { chatId: chat.id, from: from ? new Date(from).getTime() : undefined, to: from ? new Date(from).getTime() + 86400000 : undefined });
      setResults(r);
      setI(0);
      if (r[0]) onJump(r[0].id);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, from, chat.id]);
  useEffect(() => () => set({ searchHighlight: "" }), [set]);
  const nav = (d: number) => {
    if (!results.length) return;
    const n = (i + d + results.length) % results.length;
    setI(n);
    onJump(results[n].id);
  };
  return (
    <div className="flex items-center gap-2 border-b border-border bg-bg px-2 py-2">
      <div className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-surface px-3">
        <Search className="h-4 w-4 text-muted" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages" className="flex-1 bg-transparent text-[15px] outline-none" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[8.5rem] bg-transparent text-sm text-muted outline-none" aria-label="Filter by date" />
      </div>
      <span className="w-14 text-center text-sm tabular-nums text-muted">{results.length ? `${i + 1}/${results.length}` : "0/0"}</span>
      <IconButton label="Older result" onClick={() => nav(1)}>
        <ChevronUp className="h-5 w-5" />
      </IconButton>
      <IconButton label="Newer result" onClick={() => nav(-1)}>
        <ChevronDown className="h-5 w-5" />
      </IconButton>
      <IconButton label="Close search" onClick={onClose}>
        <X className="h-5 w-5" />
      </IconButton>
    </div>
  );
}

export function ChatView({ chatId }: { chatId: string }) {
  const chat = useChat(chatId);
  const { messages, loaded, hasOlder, loadOlder, jumpAround, detached, backToLatest } = useMessages(chatId);
  const { selection, jump, set, chatSearchOpen } = useUI();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ m: StoredMessage; rect: DOMRect } | null>(null);
  const [onceView, setOnceView] = useState<StoredMessage | null>(null);
  const [unreadFrom] = useState<number | null>(() => null);
  const unreadAnchor = useRef<number | null>(null);
  const prepend = useRef<{ fromBottom: number } | null>(null);
  const initialScrolled = useRef(false);
  const viewed = useRef(new Set<string>());

  useEffect(() => {
    setActiveChat(chatId);
    initialScrolled.current = false;
    unreadAnchor.current = null;
    return () => setActiveChat(null);
  }, [chatId]);

  useEffect(() => {
    if (chat && unreadAnchor.current === null) unreadAnchor.current = chat.unread > 0 ? chat.lastReadTs : -1;
  }, [chat]);

  const rows = useMemo(() => buildRows(messages, unreadAnchor.current !== null && unreadAnchor.current >= 0 ? unreadAnchor.current : unreadFrom), [messages, unreadFrom]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "msg" ? 72 : 40),
    getItemKey: (i) => rows[i].key,
    overscan: 10,
  });

  // Keep the viewport anchored when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop = el.scrollHeight - prepend.current.fromBottom;
      prepend.current = null;
      return;
    }
    if (!loaded || !rows.length) return;
    if (!initialScrolled.current) {
      initialScrolled.current = true;
      const unreadIdx = rows.findIndex((r) => r.kind === "unread");
      requestAnimationFrame(() => {
        if (unreadIdx > 0) virt.scrollToIndex(unreadIdx, { align: "start" });
        else el.scrollTop = el.scrollHeight;
      });
      return;
    }
    if (atBottom && !detached) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, loaded]);

  // Mark as read while the chat is visible and scrolled to the newest messages.
  useEffect(() => {
    if (!chat || !atBottom || detached || document.visibilityState !== "visible") return;
    if (chat.unread > 0 || messages.some((m) => !m.outgoing && m.ts > chat.lastReadTs)) void markRead(chatId);
  }, [messages, atBottom, chat, chatId, detached]);

  useBus("account:changed", () => {});

  const onScroll = useCallback(() => {
    const el = scrollRef.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(dist < 120);
    if (el.scrollTop < 400 && hasOlder && !prepend.current) {
      prepend.current = { fromBottom: el.scrollHeight - el.scrollTop };
      void loadOlder().then(() => {
        // nothing loaded → clear anchor
        setTimeout(() => (prepend.current = null), 50);
      });
    }
  }, [hasOlder, loadOlder]);

  const doJump = useCallback(
    async (id: string) => {
      const ok = await jumpAround(id);
      if (!ok) return toast("Message not found on this device");
      setTimeout(() => {
        const idx = rows.findIndex((r) => r.key === id);
        const all = scrollRef.current?.querySelector(`[data-mid="${id}"]`);
        if (all) all.scrollIntoView({ block: "center", behavior: "smooth" });
        else if (idx >= 0) virt.scrollToIndex(idx, { align: "center" });
        setHighlight(id);
        setTimeout(() => setHighlight(null), 1600);
      }, 60);
    },
    [jumpAround, rows, virt],
  );

  useEffect(() => {
    if (jump && jump.chatId === chatId) void doJump(jump.messageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);

  // Channel post view counting (once per post per user).
  useEffect(() => {
    if (chat?.type !== "channel") return;
    const items = virt.getVirtualItems();
    const ids = items.map((v) => rows[v.index]).filter((r): r is Extract<Row, { kind: "msg" }> => r?.kind === "msg" && !viewed.current.has(r.m.id) && !r.m.outgoing).map((r) => r.m.id);
    if (!ids.length) return;
    ids.forEach((i) => viewed.current.add(i));
    void ctx.api.chats.views(chatId, ids).catch(() => {});
  });

  const openMedia = useCallback(
    (m: StoredMessage) => {
      const c = m.content as Extract<Content, { t: "media" }>;
      if (c.onceView) return setOnceView(m);
      const media = messages.filter((x) => x.content.t === "media" && !x.content.onceView && ["photo", "video", "gif"].includes(x.content.kind));
      set({ viewer: { items: media, index: Math.max(0, media.findIndex((x) => x.id === m.id)) } });
    },
    [messages, set],
  );

  if (!chat) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-bg">
      <Header chat={chat} onSearch={() => set({ chatSearchOpen: true })} />
      {chatSearchOpen && <ChatSearchBar chat={chat} onClose={() => set({ chatSearchOpen: false })} onJump={doJump} />}
      <div ref={scrollRef} onScroll={onScroll} className="chat-wallpaper relative flex-1 overflow-y-auto overflow-x-hidden overscroll-contain" data-testid="message-list">
        {!loaded ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Lock className="h-8 w-8" />}
            title={chat.type === "self" ? "Saved Messages" : "No messages here yet"}
            body={chat.type === "self" ? "Forward messages here or jot down notes. Synced end-to-end encrypted across your devices." : "Messages and calls are end-to-end encrypted. No one outside this chat, not even Veil, can read them."}
          />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }} className="pt-2">
            {virt.getVirtualItems().map((v) => {
              const r = rows[v.index];
              return (
                <div key={v.key} data-index={v.index} ref={virt.measureElement} className="absolute left-0 top-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                  {r.kind === "day" ? (
                    <div className="sticky top-2 z-[1] flex justify-center py-2">
                      <span className="rounded-full bg-black/25 px-3 py-1 text-[13px] font-medium text-white backdrop-blur-sm dark:bg-white/10">{r.label}</span>
                    </div>
                  ) : r.kind === "unread" ? (
                    <div className="my-2 bg-surface/80 py-1 text-center text-[13px] font-medium text-muted backdrop-blur">Unread messages</div>
                  ) : (
                    <MessageBubble
                      m={r.m}
                      chat={chat}
                      firstInGroup={r.first}
                      lastInGroup={r.last}
                      selectionMode={selection.size > 0}
                      selected={selection.has(r.m.id)}
                      highlighted={highlight === r.m.id}
                      onJump={doJump}
                      onOpenMedia={openMedia}
                      onMenu={(m, rect) => setMenu({ m, rect })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {(!atBottom || detached) && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={async () => {
              void haptic("light");
              if (detached) await backToLatest();
              const el = scrollRef.current;
              requestAnimationFrame(() => el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
            }}
            aria-label="Scroll to newest"
            className="absolute bottom-24 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-elevated text-muted shadow-float ring-1 ring-border"
          >
            <ArrowDown className="h-5 w-5" />
            {chat.unread > 0 && <span className="absolute -top-2 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{chat.unread}</span>}
          </motion.button>
        )}
      </AnimatePresence>

      <ComposeBar chat={chat} />
      <MessageMenu target={menu} chat={chat} onClose={() => setMenu(null)} />
      <OnceViewViewer m={onceView} onClose={() => setOnceView(null)} />
    </div>
  );
}
