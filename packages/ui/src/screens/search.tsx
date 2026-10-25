"use client";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, FileText, Image as ImageIcon, Link2, Megaphone, Mic, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { directChatId } from "@veil/shared";
import { contentPreview, ctx, displayName, ensureChat, primeUser, searchMessages, type SearchFilters } from "../engine";
import { useChats } from "../hooks";
import { cn } from "../lib/cn";
import { formatChatTime, plural } from "../lib/format";
import type { StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { Avatar } from "../components/avatar";
import { ChatAvatar, useChatIdentity } from "../components/chat-identity";
import { IconButton, Spinner } from "../components/primitives";

function MessageHit({ m, q }: { m: StoredMessage; q: string }) {
  const { chats } = useChats();
  const chat = chats.find((c) => c.id === m.chatId) ?? null;
  const id = useChatIdentity(chat);
  const jumpTo = useUI((s) => s.jumpTo);
  const set = useUI((s) => s.set);
  const text = contentPreview(m.content);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return (
    <button
      onClick={() => {
        set({ globalSearch: false, searchHighlight: q });
        jumpTo(m.chatId, m.id);
      }}
      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface"
    >
      {chat && <ChatAvatar chat={chat} size={44} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[15px] font-semibold">{id.name}</span>
          <span className="shrink-0 text-xs text-muted">{formatChatTime(m.ts)}</span>
        </div>
        <p className="truncate text-[14px] text-muted">
          {i >= 0 && q ? (
            <>
              {text.slice(Math.max(0, i - 20), i)}
              <mark className="rounded bg-warning/40 text-text">{text.slice(i, i + q.length)}</mark>
              {text.slice(i + q.length)}
            </>
          ) : (
            text
          )}
        </p>
      </div>
    </button>
  );
}

export function GlobalSearch() {
  const { globalSearch, set, openChat } = useUI();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<SearchFilters["type"]>("all");
  const [range, setRange] = useState<"any" | "week" | "month" | "year">("any");
  const [msgs, setMsgs] = useState<StoredMessage[] | null>(null);
  const dir = useQuery({ queryKey: ["dir", q], queryFn: () => ctx.api.users.search(q), enabled: q.trim().length >= 2, staleTime: 30_000 });
  const { chats } = useChats();
  const localChats = q.trim() ? chats.filter((c) => (c.title ?? "").toLowerCase().includes(q.toLowerCase())) : [];

  useEffect(() => {
    if (!globalSearch) {
      setQ("");
      setMsgs(null);
    }
  }, [globalSearch]);

  useEffect(() => {
    if (q.trim().length < 2 && filter === "all") return setMsgs(null);
    const t = setTimeout(async () => {
      const from = range === "any" ? undefined : Date.now() - { week: 7, month: 30, year: 365 }[range] * 86400000;
      setMsgs(await searchMessages(q, { type: filter, from, limit: 100 }));
    }, 200);
    return () => clearTimeout(t);
  }, [q, filter, range]);

  const close = () => set({ globalSearch: false });
  const filters: { v: NonNullable<SearchFilters["type"]>; label: string; icon: typeof Search }[] = [
    { v: "all", label: "All", icon: Search },
    { v: "media", label: "Media", icon: ImageIcon },
    { v: "link", label: "Links", icon: Link2 },
    { v: "document", label: "Files", icon: FileText },
    { v: "voice", label: "Voice", icon: Mic },
  ];

  return (
    <AnimatePresence>
      {globalSearch && (
        <motion.div className="absolute inset-0 z-20 flex flex-col bg-bg" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18 }}>
          <div className="safe-top flex items-center gap-2 px-2 pb-2 pt-2">
            <IconButton label="Close search" onClick={close}>
              <ChevronLeft className="h-6 w-6" />
            </IconButton>
            <div className="flex h-10 flex-1 items-center gap-2 rounded-xl bg-surface px-3">
              <Search className="h-4 w-4 text-muted" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, chats & messages" className="flex-1 bg-transparent text-[15px] outline-none" data-testid="global-search-input" />
            </div>
          </div>
          <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
            {filters.map((f) => (
              <button key={f.v} onClick={() => setFilter(f.v)} className={cn("flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-medium", filter === f.v ? "bg-accent text-white" : "bg-surface text-muted")}>
                <f.icon className="h-3.5 w-3.5" /> {f.label}
              </button>
            ))}
            <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} className="rounded-full bg-surface px-3 text-[13px] text-muted outline-none" aria-label="Date range">
              <option value="any">Any time</option>
              <option value="week">Past week</option>
              <option value="month">Past month</option>
              <option value="year">Past year</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto">
            {localChats.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-[13px] font-medium uppercase text-muted">Chats</div>
                {localChats.slice(0, 5).map((c) => (
                  <button key={c.id} onClick={() => (openChat(c.id), close())} className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface">
                    <ChatAvatar chat={c} size={42} />
                    <span className="text-[15px] font-medium">{c.title}</span>
                  </button>
                ))}
              </>
            )}
            {dir.isFetching && <div className="flex justify-center p-3"><Spinner /></div>}
            {!!dir.data?.users.length && (
              <>
                <div className="px-4 py-1.5 text-[13px] font-medium uppercase text-muted">People</div>
                {dir.data.users.map((u) => (
                  <button
                    key={u.id}
                    data-testid="search-user"
                    onClick={async () => {
                      primeUser(u);
                      await ensureChat(directChatId(u.id));
                      openChat(directChatId(u.id));
                      close();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface"
                  >
                    <Avatar id={u.id} name={displayName(u)} mediaId={u.avatarMediaId} mediaKey={u.avatarKey} size={42} online={u.presence?.online} />
                    <span className="text-left">
                      <span className="block text-[15px] font-medium">{displayName(u)}</span>
                      <span className="block text-[13px] text-muted">@{u.username}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {!!dir.data?.chats.length && (
              <>
                <div className="px-4 py-1.5 text-[13px] font-medium uppercase text-muted">Public groups & channels</div>
                {dir.data.chats.map((c) => (
                  <button
                    key={c.id}
                    onClick={async () => {
                      try {
                        const s = await ctx.api.chats.get(c.id);
                        await ensureChat(c.id, s);
                        openChat(c.id);
                        close();
                      } catch (e) {
                        toast.error((e as Error).message);
                      }
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface"
                  >
                    <Avatar id={c.id} name={c.title} mediaId={c.avatarMediaId} mediaKey={c.avatarKey} size={42} kind={c.type === "channel" ? "channel" : "group"} />
                    <span className="min-w-0 text-left">
                      <span className="flex items-center gap-1 text-[15px] font-medium">
                        {c.type === "channel" ? <Megaphone className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />} {c.title}
                      </span>
                      <span className="block text-[13px] text-muted">
                        @{c.username}
                        {c.memberCount >= 0 && ` · ${plural(c.memberCount, c.type === "channel" ? "subscriber" : "member")}`}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {msgs && (
              <>
                <div className="px-4 py-1.5 text-[13px] font-medium uppercase text-muted">Messages {msgs.length ? `· ${msgs.length}` : ""}</div>
                {msgs.length === 0 ? <p className="px-4 py-3 text-sm text-muted">No messages found</p> : msgs.map((m) => <MessageHit key={m.id} m={m} q={q} />)}
                <p className="px-4 py-4 text-center text-xs text-subtle">Message search runs on this device. Your messages never leave it unencrypted.</p>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
