"use client";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, BellOff, ChevronLeft, CornerUpLeft, Edit3, Link2, Lock, Mic, Paperclip, Send, Smile, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDuration, isDirectChatId, peerFromChatId, type ChatMemberInfo, type LinkPreview } from "@veil/shared";
import {
  contentPreview,
  ctx,
  displayName,
  editMessage,
  fetchLinkPreview,
  muteChat,
  saveDraft,
  sendFile,
  sendMessage,
  setBlocked,
  setTyping,
} from "../engine";
import { getMessage } from "../lib/db";
import { useSettings, useUser } from "../hooks";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";
import type { LocalChat } from "../lib/types";
import { useUI } from "../store/ui";
import { AttachmentSheet } from "./attach";
import { EmojiPanel } from "./emoji-panel";
import { Button } from "./primitives";

/* ------------------------------ voice recorder ------------------------------ */

function pickMime() {
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

function useRecorder(onDone: (file: File, duration: number, waveform: number[]) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const samples = useRef<number[]>([]);
  const started = useRef(0);
  const cancelled = useRef(false);
  const cleanup = useRef<() => void>(() => {});

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      const ac = new AudioContext();
      const an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      samples.current = [];
      chunks.current = [];
      cancelled.current = false;
      const iv = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const rms = Math.min(1, Math.sqrt(sum / buf.length) * 3);
        samples.current.push(rms);
        setLevel(rms);
        setElapsed((Date.now() - started.current) / 1000);
      }, 80);
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        const duration = (Date.now() - started.current) / 1000;
        cleanup.current();
        if (cancelled.current || duration < 0.6) return;
        const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
        const s = samples.current;
        const bars = 48;
        const wave = Array.from({ length: bars }, (_, i) => {
          const slice = s.slice(Math.floor((i * s.length) / bars), Math.max(Math.floor(((i + 1) * s.length) / bars), Math.floor((i * s.length) / bars) + 1));
          return Math.min(1, Math.max(0.05, slice.reduce((a, b) => Math.max(a, b), 0)));
        });
        const ext = r.mimeType.includes("mp4") ? "m4a" : r.mimeType.includes("ogg") ? "ogg" : "webm";
        onDone(new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type }), duration, wave);
      };
      cleanup.current = () => {
        clearInterval(iv);
        stream.getTracks().forEach((t) => t.stop());
        void ac.close();
        setRecording(false);
        setElapsed(0);
      };
      started.current = Date.now();
      r.start(250);
      rec.current = r;
      setRecording(true);
      void haptic("medium");
    } catch {
      toast.error("Microphone access is needed to record voice messages");
    }
  }, [onDone]);

  const stop = useCallback((cancel = false) => {
    cancelled.current = cancel;
    if (rec.current?.state === "recording") rec.current.stop();
    void haptic(cancel ? "warning" : "light");
  }, []);

  return { recording, elapsed, level, start, stop };
}

/* ------------------------------ mention suggestions ------------------------------ */

function useMentionSuggestions(chat: LocalChat, text: string, caret: number) {
  const [items, setItems] = useState<ChatMemberInfo[]>([]);
  const m = text.slice(0, caret).match(/(?:^|\s)@([a-zA-Z0-9_]{0,32})$/);
  const q = m?.[1];
  useEffect(() => {
    if (q === undefined || chat.type !== "group") return setItems([]);
    let cancel = false;
    const t = setTimeout(async () => {
      try {
        const r = await ctx.api.chats.members(chat.id, { q, limit: 8 });
        if (!cancel) setItems(r.members.filter((x) => x.userId !== ctx.account?.userId && x.user.username));
      } catch {
        /* ignore */
      }
    }, 150);
    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [q, chat.id, chat.type]);
  return { items, query: q };
}

/* ------------------------------ compose bar ------------------------------ */

export function ComposeBar({ chat }: { chat: LocalChat }) {
  const settings = useSettings();
  const { replyTo, editing, setReply, setEditing } = useUI();
  const reply = replyTo[chat.id] ?? null;
  const edit = editing[chat.id] ?? null;
  const [text, setText] = useState(chat.draft?.text ?? "");
  const [caret, setCaret] = useState(0);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [previewOff, setPreviewOff] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [attach, setAttach] = useState(false);
  const [mentions, setMentions] = useState<Record<string, string>>({});
  const [slowUntil, setSlowUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [locked, setLocked] = useState(false);
  const [dragX, setDragX] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const peerId = isDirectChatId(chat.id) ? peerFromChatId(chat.id) : null;
  const peer = useUser(peerId && peerId !== ctx.account?.userId ? peerId : null);
  const sug = useMentionSuggestions(chat, text, caret);

  const recorder = useRecorder(
    useCallback(
      (file, duration, waveform) => {
        void sendFile(chat.id, file, { kind: "voice", duration, waveform, replyTo: reply ?? undefined }).catch((e) => toast.error(e.message));
        setReply(chat.id, null);
      },
      [chat.id, reply, setReply],
    ),
  );

  useEffect(() => {
    setText(chat.draft?.text ?? "");
    setPreview(null);
    setPreviewOff(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  useEffect(() => {
    if (edit) {
      const t = edit.content.t === "text" ? edit.content.text : edit.content.t === "media" ? (edit.content.caption ?? "") : "";
      setText(t);
      setTimeout(() => ta.current?.focus(), 0);
    }
  }, [edit]);

  useEffect(() => {
    if (reply) ta.current?.focus();
  }, [reply]);

  // Draft persistence (synced to other devices through the vault).
  useEffect(() => {
    if (edit) return;
    const t = setTimeout(() => void saveDraft(chat.id, text, reply?.id), 700);
    return () => clearTimeout(t);
  }, [text, chat.id, reply?.id, edit]);

  // Link preview (fetched by the sender; the server sees only the URL).
  useEffect(() => {
    if (!settings?.linkPreviews || previewOff || !/https?:\/\//i.test(text)) return setPreview(null);
    const ctrl = new AbortController();
    const t = setTimeout(async () => setPreview(await fetchLinkPreview(text, ctrl.signal)), 600);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, settings?.linkPreviews, previewOff]);

  useEffect(() => {
    if (slowUntil <= Date.now()) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, [slowUntil]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(160, el.scrollHeight) + "px";
  }, [text]);

  const s = chat.summary;
  const isAdmin = s?.myRole === "owner" || s?.myRole === "admin";
  const slowMode = chat.type === "group" && !isAdmin ? (s?.slowModeSeconds ?? 0) : 0;
  const slowLeft = Math.max(0, Math.ceil((slowUntil - now) / 1000));
  const canSendMedia = isAdmin || chat.type !== "group" || s?.defaultPermissions?.sendMedia !== false;

  async function submit() {
    const body = text.trim();
    if (!body) return;
    if (slowLeft > 0) {
      void haptic("warning");
      return toast(`Slow mode: wait ${slowLeft}s`);
    }
    void haptic("light");
    try {
      if (edit) {
        if (edit.content.t === "text") await editMessage(edit.id, { ...edit.content, text: body, preview: preview ?? undefined });
        else if (edit.content.t === "media") await editMessage(edit.id, { ...edit.content, caption: body });
        setEditing(chat.id, null);
      } else {
        const ids = Object.entries(mentions)
          .filter(([u]) => body.includes(`@${u}`))
          .map(([, id]) => id);
        const linkPreview = preview && !previewOff ? preview : null;
        setText("");
        setPreview(null);
        setReply(chat.id, null);
        setMentions({});
        await sendMessage(chat.id, { t: "text", text: body, preview: linkPreview, noPreview: previewOff || undefined }, { replyTo: reply ?? undefined, mentions: ids });
        if (slowMode) setSlowUntil(Date.now() + slowMode * 1000);
      }
      setText("");
      void setTyping(chat.id, "stop");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function insert(str: string) {
    const el = ta.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + str + text.slice(end);
    setText(next);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + str.length, start + str.length);
    }, 0);
  }

  function pickMention(m: ChatMemberInfo) {
    const u = m.user.username!;
    const before = text.slice(0, caret).replace(/@([a-zA-Z0-9_]{0,32})$/, `@${u} `);
    setText(before + text.slice(caret));
    setMentions((x) => ({ ...x, [u]: m.userId }));
    ta.current?.focus();
  }

  /* ---------- special states ---------- */

  if (chat.type === "channel" && !s?.myRights?.postMessages) {
    const muted = (chat.mutedUntil ?? 0) > Date.now();
    return (
      <div className="safe-bottom border-t border-border bg-bg/90 p-2 backdrop-blur-xl">
        {s?.myRole ? (
          <Button variant="ghost" className="w-full text-accent" onClick={() => muteChat(chat.id, muted ? null : Number.MAX_SAFE_INTEGER)}>
            {muted ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />} {muted ? "Unmute" : "Mute"}
          </Button>
        ) : (
          <Button className="w-full" onClick={() => ctx.api.chats.join(chat.id).then(() => toast("Joined"))}>
            Join channel
          </Button>
        )}
      </div>
    );
  }
  if ((chat.type === "group" || chat.type === "channel") && s && !s.myRole) {
    return <div className="safe-bottom border-t border-border bg-bg/90 p-4 text-center text-sm text-muted backdrop-blur-xl">You are no longer a member of this {chat.type}.</div>;
  }
  if (peer?.blocked) {
    return (
      <div className="safe-bottom border-t border-border bg-bg/90 p-2 backdrop-blur-xl">
        <Button variant="ghost" className="w-full text-danger" onClick={() => setBlocked(peer.id, false).then(() => toast("User unblocked"))}>
          Unblock
        </Button>
      </div>
    );
  }
  if (chat.type === "group" && !isAdmin && s?.defaultPermissions?.sendMessages === false) {
    return <div className="safe-bottom border-t border-border bg-bg/90 p-4 text-center text-sm text-muted backdrop-blur-xl">Only admins can send messages.</div>;
  }

  const hasText = text.trim().length > 0;

  return (
    <div className="safe-bottom relative z-10 border-t border-border bg-bg/85 backdrop-blur-xl">
      {/* mention suggestions */}
      <AnimatePresence>
        {sug.items.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute inset-x-2 bottom-full mb-2 overflow-hidden rounded-2xl bg-elevated shadow-float ring-1 ring-border">
            {sug.items.map((m) => (
              <button key={m.userId} onClick={() => pickMention(m)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface">
                <span className="font-medium">{displayName(m.user)}</span>
                <span className="text-sm text-muted">@{m.user.username}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* reply / edit strip */}
      <AnimatePresence>
        {(reply || edit) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex items-center gap-3 px-3 pt-2">
              {edit ? <Edit3 className="h-5 w-5 text-accent" /> : <CornerUpLeft className="h-5 w-5 text-accent" />}
              <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
                <div className="text-[13px] font-semibold text-accent">{edit ? "Edit message" : <ReplyName id={reply!.senderId} />}</div>
                <div className="truncate text-[13px] text-muted">{contentPreview((edit ?? reply)!.content)}</div>
              </div>
              <button
                aria-label="Cancel"
                onClick={() => {
                  if (edit) {
                    setEditing(chat.id, null);
                    setText("");
                  } else setReply(chat.id, null);
                }}
                className="rounded-full p-1 text-muted hover:bg-surface"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* link preview strip */}
      {preview && !previewOff && (
        <div className="flex items-center gap-3 px-3 pt-2">
          <Link2 className="h-5 w-5 text-accent" />
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
            <div className="truncate text-[13px] font-semibold text-accent">{preview.siteName ?? preview.title}</div>
            <div className="truncate text-[13px] text-muted">{preview.title ?? preview.description}</div>
          </div>
          <button aria-label="Remove link preview" onClick={() => setPreviewOff(true)} className="rounded-full p-1 text-muted hover:bg-surface">
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-1 px-2 py-2">
        {recorder.recording ? (
          <div className="flex h-11 flex-1 items-center gap-3 px-2">
            <span className="h-3 w-3 animate-pulse rounded-full bg-danger" style={{ transform: `scale(${1 + recorder.level})` }} />
            <span className="font-mono text-[15px] tabular-nums">{formatDuration(recorder.elapsed)}</span>
            {locked ? (
              <button onClick={() => (recorder.stop(true), setLocked(false))} className="ml-auto flex items-center gap-1 text-danger">
                <Trash2 className="h-5 w-5" /> Cancel
              </button>
            ) : (
              <span className="ml-auto flex items-center gap-1 text-sm text-muted" style={{ transform: `translateX(${dragX}px)` }}>
                <ChevronLeft className="h-4 w-4" /> Slide to cancel
              </span>
            )}
          </div>
        ) : (
          <>
            {canSendMedia && (
              <button aria-label="Attach" onClick={() => (void haptic("light"), setAttach(true))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface hover:text-text">
                <Paperclip className="h-6 w-6" />
              </button>
            )}
            <div className="flex min-h-11 flex-1 items-end rounded-[22px] bg-surface px-3 ring-accent/30 focus-within:ring-2">
              <textarea
                ref={ta}
                rows={1}
                value={text}
                placeholder={slowLeft > 0 ? `Slow mode · ${slowLeft}s` : chat.type === "channel" ? "Broadcast" : "Message"}
                aria-label="Message"
                data-testid="composer"
                onChange={(e) => {
                  setText(e.target.value);
                  setCaret(e.target.selectionStart);
                  if (e.target.value) void setTyping(chat.id, "typing");
                }}
                onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
                onBlur={() => text && void setTyping(chat.id, "stop")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && settings?.sendWithEnter !== false && !("ontouchstart" in window)) {
                    e.preventDefault();
                    void submit();
                  }
                  if (e.key === "ArrowUp" && !text) {
                    // Edit the last outgoing message (desktop shortcut).
                    void (async () => {
                      if (chat.lastOutgoing && chat.lastMessageId) {
                        const m = await getMessage(chat.lastMessageId);
                        if (m) setEditing(chat.id, m);
                      }
                    })();
                  }
                  if (e.key === "Escape") {
                    setReply(chat.id, null);
                    setEditing(chat.id, null);
                  }
                }}
                className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[16px] leading-[22px] outline-none placeholder:text-subtle"
              />
              <button aria-label="Emoji, stickers and GIFs" onClick={() => (void haptic("light"), setEmoji((v) => !v))} className="mb-[9px] ml-1 text-muted hover:text-text">
                <Smile className="h-6 w-6" />
              </button>
            </div>
          </>
        )}

        <div className="relative h-11 w-11 shrink-0">
          <AnimatePresence initial={false} mode="popLayout">
            {hasText || edit ? (
              <motion.button
                key="send"
                aria-label={edit ? "Save" : "Send"}
                data-testid="send"
                initial={{ scale: 0.4, rotate: -90, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                exit={{ scale: 0.4, rotate: 90, opacity: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 30 }}
                onClick={submit}
                className="absolute inset-0 flex items-center justify-center rounded-full bg-accent text-white shadow-soft"
              >
                {edit ? <Square className="h-5 w-5 fill-white" /> : <Send className="ml-0.5 h-5 w-5" />}
              </motion.button>
            ) : recorder.recording && locked ? (
              <motion.button key="stop" initial={{ scale: 0.6 }} animate={{ scale: 1 }} onClick={() => (recorder.stop(false), setLocked(false))} className="absolute inset-0 flex items-center justify-center rounded-full bg-accent text-white" aria-label="Send voice message">
                <Send className="h-5 w-5" />
              </motion.button>
            ) : (
              <motion.button
                key="mic"
                aria-label="Hold to record a voice message"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: recorder.recording ? 1.5 : 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ type: "spring", stiffness: 520, damping: 30 }}
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  pressStart.current = { x: e.clientX, y: e.clientY };
                  void recorder.start();
                }}
                onPointerMove={(e) => {
                  if (!pressStart.current || !recorder.recording) return;
                  const dx = Math.min(0, e.clientX - pressStart.current.x);
                  const dy = e.clientY - pressStart.current.y;
                  setDragX(dx);
                  if (dx < -120) {
                    pressStart.current = null;
                    setDragX(0);
                    recorder.stop(true);
                  } else if (dy < -80) {
                    pressStart.current = null;
                    setLocked(true);
                    void haptic("medium");
                  }
                }}
                onPointerUp={() => {
                  if (!pressStart.current) return;
                  pressStart.current = null;
                  setDragX(0);
                  if (!locked) recorder.stop(false);
                }}
                className={cn("absolute inset-0 flex touch-none items-center justify-center rounded-full", recorder.recording ? "bg-accent text-white" : "text-muted hover:bg-surface hover:text-text")}
              >
                <Mic className="h-6 w-6" />
                {recorder.recording && !locked && <Lock className="absolute -top-10 h-4 w-4 text-muted" />}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>{emoji && <EmojiPanel chat={chat} onEmoji={insert} onClose={() => setEmoji(false)} />}</AnimatePresence>
      <AttachmentSheet open={attach} onOpenChange={setAttach} chat={chat} replyTo={reply} onSent={() => setReply(chat.id, null)} />
    </div>
  );
}

function ReplyName({ id }: { id: string }) {
  const u = useUser(id);
  return <>Reply to {id === ctx.account?.userId ? "yourself" : displayName(u)}</>;
}
