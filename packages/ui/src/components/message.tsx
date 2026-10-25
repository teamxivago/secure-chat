"use client";
import { AnimatePresence, motion, useAnimation } from "framer-motion";
import {
  AlertCircle,
  Check,
  CheckCheck,
  CircleCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  Edit3,
  Eye,
  Flag,
  Forward,
  Info,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { DEFAULT_REACTIONS, EDIT_WINDOW_MS, isDirectChatId, type Content } from "@veil/shared";
import { contentPreview, ctx, deleteMessages, displayName, downloadAttachment, pinMessage, retryMessage, toggleReaction } from "../engine";
import { useSettings, useUser } from "../hooks";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { haptic, shareFile } from "../lib/native";
import type { LocalChat, StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { Avatar } from "./avatar";
import {
  AudioFileMessage,
  CallMessage,
  ContactMessage,
  DocumentMessage,
  EventMessage,
  LinkPreviewCard,
  LocationMessage,
  OnceViewMedia,
  PollMessage,
  RichText,
  VisualMedia,
  VoiceMessage,
} from "./content";
import { Dialog, useConfirm } from "./overlays";
import { Button } from "./primitives";

const NAME_COLORS = ["#E17076", "#7BC862", "#E5CA77", "#65AADD", "#A695E7", "#EE7AAE", "#6EC9CB", "#FAA774"];
const nameColor = (id: string) => NAME_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % NAME_COLORS.length];

function Status({ m }: { m: StoredMessage }) {
  if (!m.outgoing) return null;
  if (m.status === "pending") return <Clock className="h-3 w-3" />;
  if (m.status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-danger" />;
  if (m.status === "read") return <CheckCheck className="h-4 w-4 text-sky-200" />;
  if (m.status === "delivered") return <CheckCheck className="h-4 w-4" />;
  return <Check className="h-4 w-4" />;
}

function SenderName({ id }: { id: string }) {
  const u = useUser(id);
  return (
    <div className="mb-0.5 truncate text-[13px] font-semibold" style={{ color: nameColor(id) }}>
      {displayName(u)}
    </div>
  );
}

function ReplyQuote({ m, outgoing, onJump }: { m: StoredMessage; outgoing: boolean; onJump: () => void }) {
  const r = m.meta.replyTo!;
  const u = useUser(r.senderId);
  const name = r.senderId === ctx.account?.userId ? "You" : displayName(u);
  return (
    <button
      onClick={(e) => (e.stopPropagation(), onJump())}
      className={cn("mb-1 block w-full rounded-md border-l-[3px] px-2 py-1 text-left", outgoing ? "border-white/80 bg-white/15" : "bg-black/[0.04] dark:bg-white/[0.06]")}
      style={outgoing ? undefined : { borderColor: nameColor(r.senderId) }}
    >
      <div className="truncate text-[13px] font-semibold" style={outgoing ? undefined : { color: nameColor(r.senderId) }}>
        {name}
      </div>
      <div className="truncate text-[13px] opacity-80">{r.snippet}</div>
    </button>
  );
}

function Reactions({ m }: { m: StoredMessage }) {
  const me = ctx.account!.userId;
  const entries = Object.entries(m.reactions).filter(([, u]) => u.length);
  if (!entries.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([emoji, users]) => {
        const mine = users.includes(me);
        return (
          <motion.button
            key={emoji}
            layout
            initial={{ scale: 0.6 }}
            animate={{ scale: 1 }}
            whileTap={{ scale: 0.85 }}
            onClick={(e) => {
              e.stopPropagation();
              void haptic("light");
              void toggleReaction(m.chatId, m.id, emoji);
            }}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2 text-[14px]",
              m.outgoing ? (mine ? "bg-white text-accent" : "bg-white/20") : mine ? "bg-accent text-white" : "bg-accent-soft text-accent",
            )}
          >
            <span>{emoji}</span>
            <span className="text-[12px] font-semibold tabular-nums">{users.length}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

function Body({ m, onOpenMedia }: { m: StoredMessage; onOpenMedia: () => void }) {
  const c = m.content;
  const chatSearchHighlight = useUI((s) => s.searchHighlight);
  switch (c.t) {
    case "text":
      return (
        <>
          <RichText text={c.text} outgoing={m.outgoing} highlight={chatSearchHighlight} />
          {c.preview && !c.noPreview && <LinkPreviewCard p={c.preview} outgoing={m.outgoing} />}
        </>
      );
    case "media": {
      if (c.onceView) return <OnceViewMedia m={m} c={c} onOpen={onOpenMedia} />;
      let el;
      if (c.kind === "voice") el = <VoiceMessage m={m} c={c} />;
      else if (c.kind === "audio") el = <AudioFileMessage m={m} c={c} />;
      else if (c.kind === "document") el = <DocumentMessage m={m} c={c} />;
      else el = <VisualMedia m={m} c={c} onOpen={onOpenMedia} />;
      return (
        <>
          {el}
          {c.caption && (
            <div className="px-1 pt-1">
              <RichText text={c.caption} outgoing={m.outgoing} />
            </div>
          )}
        </>
      );
    }
    case "location":
      return <LocationMessage c={c} />;
    case "contact":
      return <ContactMessage c={c} outgoing={m.outgoing} />;
    case "poll":
      return <PollMessage m={m} c={c} />;
    case "event":
      return <EventMessage m={m} c={c} />;
    case "call":
      return <CallMessage m={m} c={c} />;
    default:
      return null;
  }
}

const isBare = (c: Content) => c.t === "media" && (c.kind === "sticker" || ((c.kind === "photo" || c.kind === "video" || c.kind === "gif") && !c.caption && !c.onceView));

export interface BubbleProps {
  m: StoredMessage;
  chat: LocalChat;
  firstInGroup: boolean;
  lastInGroup: boolean;
  selectionMode: boolean;
  selected: boolean;
  highlighted: boolean;
  onJump: (id: string) => void;
  onOpenMedia: (m: StoredMessage) => void;
  onMenu: (m: StoredMessage, rect: DOMRect) => void;
}

export const MessageBubble = memo(function MessageBubble({ m, chat, firstInGroup, lastInGroup, selectionMode, selected, highlighted, onJump, onOpenMedia, onMenu }: BubbleProps) {
  const { setReply, toggleSelect } = useUI();
  const controls = useAnimation();
  const ref = useRef<HTMLDivElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGroup = chat.type === "group";
  const isChannel = chat.type === "channel";
  const showSender = isGroup && !m.outgoing && firstInGroup;
  const showAvatar = isGroup && !m.outgoing;
  const bare = isBare(m.content);
  const sender = useUser(showAvatar && lastInGroup ? m.senderId : null);

  if (m.content.t === "system") {
    return (
      <div className="my-2 flex justify-center px-4">
        <span className="rounded-full bg-black/25 px-3 py-1 text-center text-[13px] text-white backdrop-blur-sm dark:bg-white/10">
          <SystemText m={m} />
        </span>
      </div>
    );
  }

  const outgoingSide = m.outgoing && !isChannel;

  return (
    <div
      ref={ref}
      data-mid={m.id}
      className={cn("group relative flex px-2 transition-colors duration-700 md:px-4", lastInGroup ? "mb-2" : "mb-[3px]", highlighted && "bg-accent/15", selected && "bg-accent/10")}
      onClick={() => selectionMode && (void haptic("selection"), toggleSelect(m.id))}
    >
      {selectionMode && (
        <div className="flex w-9 shrink-0 items-center">
          <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border-2", selected ? "border-accent bg-accent text-white" : "border-subtle")}>
            {selected && <Check className="h-4 w-4" />}
          </span>
        </div>
      )}
      <div className={cn("flex min-w-0 flex-1 items-end gap-2", outgoingSide ? "justify-end" : "justify-start")}>
        {showAvatar && (
          <div className="w-9 shrink-0">
            {lastInGroup && <Avatar id={m.senderId} name={displayName(sender)} mediaId={sender?.avatarMediaId} mediaKey={sender?.avatarKey} size={36} />}
          </div>
        )}
        <motion.div
          drag={selectionMode ? false : "x"}
          dragDirectionLock
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={{ left: 0, right: 0.35 }}
          animate={controls}
          onDragEnd={(_, info) => {
            if (info.offset.x > 60) {
              void haptic("light");
              setReply(m.chatId, m);
            }
            void controls.start({ x: 0 });
          }}
          onPointerDown={(e) => {
            // Long-press is a touch/primary-button gesture; right-click uses onContextMenu.
            if (selectionMode || e.button !== 0) return;
            press.current = setTimeout(() => {
              void haptic("medium");
              onMenu(m, ref.current!.getBoundingClientRect());
            }, 450);
          }}
          onPointerUp={() => press.current && clearTimeout(press.current)}
          onPointerMove={() => press.current && clearTimeout(press.current)}
          onPointerCancel={() => press.current && clearTimeout(press.current)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (press.current) clearTimeout(press.current);
            if (!selectionMode) onMenu(m, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          className={cn(
            "no-select relative max-w-[min(78%,520px)] text-[15px] leading-[1.35]",
            bare
              ? ""
              : cn(
                  "rounded-[var(--radius-bubble)] px-2.5 py-1.5 shadow-soft",
                  outgoingSide ? "bg-bubble-out text-bubble-out-text" : "bg-bubble-in text-bubble-in-text",
                  lastInGroup && (outgoingSide ? "bubble-tail-out rounded-br-[4px]" : "bubble-tail-in rounded-bl-[4px]"),
                ),
          )}
        >
          {showSender && !bare && <SenderName id={m.senderId} />}
          {m.meta.forwardedFrom && (
            <div className={cn("mb-0.5 flex items-center gap-1 text-[13px]", outgoingSide ? "text-white/85" : "text-accent")}>
              <Forward className="h-3.5 w-3.5" /> Forwarded from <b className="truncate">{m.meta.forwardedFrom.name}</b>
            </div>
          )}
          {m.meta.replyTo && <ReplyQuote m={m} outgoing={outgoingSide} onJump={() => onJump(m.meta.replyTo!.id)} />}
          <Body m={m} onOpenMedia={() => onOpenMedia(m)} />
          <Reactions m={m} />
          <div
            className={cn(
              "float-right ml-2 mt-1 flex items-center gap-1 text-[11px] leading-none",
              bare ? "absolute bottom-1.5 right-1.5 rounded-full bg-black/45 px-1.5 py-1 text-white" : outgoingSide ? "text-white/75" : "text-muted",
            )}
          >
            {isChannel && m.views !== undefined && (
              <span className="flex items-center gap-0.5">
                <Eye className="h-3 w-3" /> {m.views}
              </span>
            )}
            {m.editedAt && <span>edited</span>}
            <span>{formatTime(m.ts)}</span>
            {outgoingSide && <Status m={m} />}
          </div>
          {m.status === "failed" && (
            <button onClick={(e) => (e.stopPropagation(), void retryMessage(m.id))} className="absolute -left-8 bottom-1 text-danger" aria-label="Retry">
              <RotateCw className="h-5 w-5" />
            </button>
          )}
        </motion.div>
      </div>
    </div>
  );
});

function SystemText({ m }: { m: StoredMessage }) {
  const c = m.content as Extract<Content, { t: "system" }>;
  const u = useUser(c.actorId);
  const who = c.actorId === ctx.account?.userId ? "You" : displayName(u);
  if (c.text) return <>{c.text}</>;
  switch (c.action) {
    case "screenshot":
      return <>📸 {who} took a screenshot</>;
    case "identityChanged":
      return <>🔐 {who}'s security code changed</>;
    case "keysRotated":
      return <>🔄 Encryption keys were rotated</>;
    default:
      return <>{contentPreview(m.content)}</>;
  }
}

/* ------------------------------ context menu ------------------------------ */

export function MessageMenu({ target, chat, onClose }: { target: { m: StoredMessage; rect: DOMRect } | null; chat: LocalChat; onClose: () => void }) {
  const { setReply, setEditing, toggleSelect, set } = useUI();
  const settings = useSettings();
  const confirm = useConfirm();
  const [moreEmoji, setMoreEmoji] = useState(false);
  const [info, setInfo] = useState<StoredMessage | null>(null);
  useEffect(() => setMoreEmoji(false), [target]);
  if (typeof document === "undefined") return null;
  const m = target?.m;
  const rights = chat.summary?.myRights ?? {};
  const isDirect = isDirectChatId(chat.id);
  const canEdit = !!m && m.outgoing && Date.now() - m.ts < EDIT_WINDOW_MS && (m.content.t === "text" || (m.content.t === "media" && !m.content.onceView));
  const canPin = !!m && (isDirect || rights.pinMessages || chat.summary?.defaultPermissions?.pinMessages);
  const pinned = !!m && (chat.pinnedMessageIds ?? []).includes(m.id);
  const canDeleteEveryone = !!m && (m.outgoing || (!isDirect && rights.deleteMessages));
  const once = m?.content.t === "media" && !!m.content.onceView;
  const text = m?.content.t === "text" ? m.content.text : m?.content.t === "media" ? m.content.caption : undefined;
  const quick = settings?.reactionsQuick ?? DEFAULT_REACTIONS.slice(0, 7);
  const allowed = chat.summary?.reactionsMode === "none" ? [] : chat.summary?.reactionsMode === "some" ? chat.summary.allowedReactions : null;
  const emojis = (moreEmoji ? DEFAULT_REACTIONS : quick).filter((e) => !allowed || allowed.includes(e));

  const run = (fn: () => void | Promise<void>) => () => {
    void haptic("light");
    onClose();
    void fn();
  };

  const items = m
    ? [
        { label: "Reply", icon: CornerUpLeft, on: () => setReply(chat.id, m), show: chat.type !== "channel" || !!rights.postMessages },
        { label: "Copy", icon: Copy, on: () => navigator.clipboard.writeText(text ?? "").then(() => toast("Copied to clipboard")), show: !!text && !once },
        { label: "Edit", icon: Edit3, on: () => setEditing(chat.id, m), show: canEdit },
        { label: pinned ? "Unpin" : "Pin", icon: pinned ? PinOff : Pin, on: () => pinMessage(chat.id, m.id, pinned).then(() => toast(pinned ? "Message unpinned" : "Message pinned")), show: !!canPin },
        { label: "Forward", icon: Forward, on: () => set({ forwarding: [m] }), show: !once && m.content.t !== "call" },
        {
          label: "Save",
          icon: Download,
          on: async () => {
            if (m.content.t !== "media") return;
            const b = await downloadAttachment(m.content.attachment);
            await shareFile(b, m.content.attachment.name ?? `veil-${m.id.slice(0, 8)}.${m.content.attachment.mime.split("/")[1] ?? "bin"}`);
          },
          show: m.content.t === "media" && !once,
        },
        { label: "Select", icon: CircleCheck, on: () => toggleSelect(m.id), show: true },
        { label: "Info", icon: Info, on: () => setInfo(m), show: m.outgoing && chat.type === "group" },
        { label: "Report", icon: Flag, on: () => set({ reporting: { chatId: chat.id, messages: [m] } }), show: !m.outgoing },
        {
          label: "Delete",
          icon: Trash2,
          danger: true,
          on: async () => {
            const r = await confirm({
              title: "Delete message?",
              body: isDirect ? undefined : canDeleteEveryone ? "Delete for all members?" : "It will be removed only for you.",
              confirm: "Delete",
              danger: true,
              checkbox: canDeleteEveryone ? (isDirect ? "Also delete for the other person" : "Delete for everyone") : undefined,
            });
            if (r.ok) {
              await deleteMessages(chat.id, [m.id], r.checked);
              void haptic("medium");
              toast("Message deleted");
            }
          },
          show: true,
        },
      ].filter((i) => i.show)
    : [];

  const vw = typeof window !== "undefined" ? window.innerWidth : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const width = 260;
  const left = target ? Math.min(Math.max(12, (m!.outgoing ? target.rect.right - width : target.rect.left + 44)), vw - width - 12) : 0;
  const menuH = 56 + items.length * 44 + 16;
  const top = target ? Math.min(Math.max(12, target.rect.bottom + 8), vh - menuH - 12) : 0;

  return createPortal(
    <>
      <AnimatePresence>
        {target && (
          <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
            <div className="absolute inset-0 bg-black/25 backdrop-blur-[3px]" />
            <motion.div
              className="absolute"
              style={{ left, top: Math.max(12, top - 64), width }}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              {(allowed === null || allowed.length > 0) && !once && (
                <div className={cn("mb-2 flex flex-wrap items-center gap-0.5 rounded-[22px] bg-elevated p-1.5 shadow-float ring-1 ring-border", moreEmoji && "max-h-48 overflow-y-auto")}>
                  {emojis.map((e) => (
                    <motion.button
                      key={e}
                      whileHover={{ scale: 1.25 }}
                      whileTap={{ scale: 0.85 }}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-[22px]"
                      onClick={run(() => toggleReaction(chat.id, m!.id, e))}
                    >
                      {e}
                    </motion.button>
                  ))}
                  {!moreEmoji && allowed === null && (
                    <button className="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted" onClick={() => setMoreEmoji(true)} aria-label="More reactions">
                      <Plus className="h-5 w-5" />
                    </button>
                  )}
                </div>
              )}
              <div className="overflow-hidden rounded-2xl bg-elevated/95 p-1.5 shadow-float ring-1 ring-border backdrop-blur-xl">
                {items.map((i) => (
                  <button key={i.label} onClick={run(i.on)} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] hover:bg-surface", "danger" in i && i.danger && "text-danger")}>
                    <i.icon className={cn("h-5 w-5", "danger" in i && i.danger ? "text-danger" : "text-muted")} />
                    {i.label}
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <ReadInfo m={info} onClose={() => setInfo(null)} />
    </>,
    document.body,
  );
}

function ReadInfo({ m, onClose }: { m: StoredMessage | null; onClose: () => void }) {
  const entries = Object.entries(m?.receipts ?? {});
  return (
    <Dialog open={!!m} onOpenChange={(o) => !o && onClose()} title="Message info">
      {entries.length === 0 ? (
        <p className="text-sm text-muted">No one has read this message yet.</p>
      ) : (
        <div className="space-y-1">
          {entries
            .sort((a, b) => (b[1].read ?? 0) - (a[1].read ?? 0))
            .map(([uid, r]) => (
              <ReceiptRow key={uid} userId={uid} read={r.read} delivered={r.delivered} />
            ))}
        </div>
      )}
      <Button variant="ghost" className="mt-4 w-full" onClick={onClose}>
        Close
      </Button>
    </Dialog>
  );
}

function ReceiptRow({ userId, read, delivered }: { userId: string; read?: number; delivered?: number }) {
  const u = useUser(userId);
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-2">
      <Avatar id={userId} name={displayName(u)} mediaId={u?.avatarMediaId} mediaKey={u?.avatarKey} size={36} />
      <div className="flex-1">
        <div className="text-[15px] font-medium">{displayName(u)}</div>
        <div className="text-[13px] text-muted">{read ? `Read ${new Date(read).toLocaleString()}` : delivered ? `Delivered ${new Date(delivered).toLocaleString()}` : ""}</div>
      </div>
      {read ? <CheckCheck className="h-4 w-4 text-accent" /> : <Check className="h-4 w-4 text-muted" />}
    </div>
  );
}
