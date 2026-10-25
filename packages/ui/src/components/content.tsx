"use client";
import {
  Calendar,
  Check,
  Download,
  Eye,
  FileArchive,
  FileText,
  Flame,
  MapPin,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  UserPlus,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatDuration, type Attachment, type Content, type LinkPreview } from "@veil/shared";
import { cancelUpload, closePoll, ctx, displayName, downloadAttachment, rsvp, uploadProgress, votePoll } from "../engine";
import { useAttachment, useBus, useUser } from "../hooks";
import { cn } from "../lib/cn";
import { haptic, shareFile } from "../lib/native";
import type { StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { Avatar } from "./avatar";

type C<T extends Content["t"]> = Extract<Content, { t: T }>;

/* ------------------------------ text ------------------------------ */

const TOKEN_RE = /(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}])|(@[a-zA-Z][a-zA-Z0-9_]{4,31})|(\*\*[^*\n]+\*\*)|(`[^`\n]+`)/g;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*\s*){1,3}$/u;

export function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Renders text with links, mentions, bold and inline code — without injecting HTML. */
export function RichText({ text, outgoing, highlight }: { text: string; outgoing?: boolean; highlight?: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let k = 0;
    const pushPlain = (s: string) => {
      if (!highlight) return out.push(s);
      const i = s.toLowerCase().indexOf(highlight.toLowerCase());
      if (i < 0) return out.push(s);
      out.push(s.slice(0, i), <mark key={`h${k++}`} className="rounded bg-warning/40 text-inherit">{s.slice(i, i + highlight.length)}</mark>, s.slice(i + highlight.length));
    };
    for (const m of text.matchAll(TOKEN_RE)) {
      if (m.index! > last) pushPlain(text.slice(last, m.index));
      const [tok] = m;
      if (m[1]) {
        out.push(
          <a key={k++} href={tok} onClick={(e) => (e.preventDefault(), e.stopPropagation(), openExternal(tok))} className={cn("break-all underline underline-offset-2", outgoing ? "text-white" : "text-accent")}>
            {tok}
          </a>,
        );
      } else if (m[2]) {
        out.push(
          <span key={k++} className={cn("font-medium", outgoing ? "text-white underline" : "text-accent")}>
            {tok}
          </span>,
        );
      } else if (m[3]) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
      else if (m[4]) out.push(<code key={k++} className="rounded bg-black/10 px-1 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
      last = m.index! + tok.length;
    }
    if (last < text.length) pushPlain(text.slice(last));
    return out;
  }, [text, outgoing, highlight]);
  const big = EMOJI_ONLY.test(text.trim());
  return <span className={cn("whitespace-pre-wrap break-words", big && "text-[42px] leading-tight")}>{nodes}</span>;
}

/* ------------------------------ link preview ------------------------------ */

function proxiedImg(u?: string) {
  if (!u) return undefined;
  return u.startsWith("/") ? `${ctx.api.baseUrl}${u}` : u;
}

export function LinkPreviewCard({ p, outgoing, compact }: { p: LinkPreview; outgoing?: boolean; compact?: boolean }) {
  const host = (() => {
    try {
      return new URL(p.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const accent = p.kind === "youtube" ? "#FF0033" : p.kind === "twitter" ? (outgoing ? "#fff" : "#0F0F1A") : p.kind === "instagram" ? "#E1306C" : outgoing ? "rgba(255,255,255,.8)" : "var(--accent)";
  return (
    <button
      onClick={(e) => (e.stopPropagation(), openExternal(p.url))}
      className={cn("mt-1.5 block w-full overflow-hidden rounded-lg text-left", outgoing ? "bg-white/15" : "bg-black/[0.04] dark:bg-white/[0.06]")}
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          {p.favicon && <img src={proxiedImg(p.favicon)} alt="" className="h-4 w-4 rounded" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <span className="truncate text-[13px] font-semibold" style={{ color: outgoing ? "#fff" : p.kind === "generic" ? "var(--accent)" : accent }}>
            {p.siteName ?? host}
          </span>
        </div>
        {p.kind === "twitter" && p.author && <div className="text-[13px] opacity-80">{p.title} {p.author}</div>}
        {p.kind !== "twitter" && p.title && <div className="mt-0.5 line-clamp-2 text-[14px] font-semibold">{p.title}</div>}
        {p.description && <div className={cn("mt-0.5 text-[13px] opacity-85", compact ? "line-clamp-2" : "line-clamp-4")}>{p.description}</div>}
        {p.kind === "youtube" && p.author && <div className="mt-0.5 text-[12px] opacity-70">{p.author}</div>}
      </div>
      {p.image && !compact && (
        <div className="relative">
          <img src={proxiedImg(p.image)} alt="" className="max-h-64 w-full object-cover" loading="lazy" onError={(e) => (e.currentTarget.parentElement!.style.display = "none")} />
          {p.kind === "youtube" && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex h-12 w-16 items-center justify-center rounded-2xl bg-[#FF0033]/90 shadow-lg">
                <Play className="h-6 w-6 fill-white text-white" />
              </div>
            </div>
          )}
        </div>
      )}
    </button>
  );
}

/* ------------------------------ media ------------------------------ */

function ProgressRing({ value }: { value: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg width="44" height="44" className="-rotate-90">
      <circle cx="22" cy="22" r={r} stroke="rgba(255,255,255,.3)" strokeWidth="3" fill="none" />
      <circle cx="22" cy="22" r={r} stroke="#fff" strokeWidth="3" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round" />
    </svg>
  );
}

function mediaBox(att: Attachment, max = 320) {
  const w = att.width ?? 320;
  const h = att.height ?? 240;
  const scale = Math.min(1, max / w, 420 / h);
  return { width: Math.max(140, Math.round(w * scale)), height: Math.max(100, Math.round(h * scale)) };
}

/** Live progress of an optimistic upload placeholder, with cancel. */
export function UploadOverlay({ messageId }: { messageId: string }) {
  const [p, setP] = useState(uploadProgress(messageId) ?? 0);
  useBus("upload:progress", (e) => e.messageId === messageId && setP(e.progress), [messageId]);
  return (
    <button
      aria-label="Cancel upload"
      onClick={(e) => (e.stopPropagation(), cancelUpload(messageId))}
      className="relative flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur"
    >
      <span className="absolute inset-0 flex items-center justify-center">
        <ProgressRing value={Math.max(0.03, p)} />
      </span>
      <X className="h-4 w-4" />
    </button>
  );
}

const absUrl = (u: string) => (u.startsWith("/") ? `${ctx.api.baseUrl}${u}` : u);

export function VisualMedia({ m, c, onOpen }: { m: StoredMessage; c: C<"media">; onOpen: () => void }) {
  const att = c.attachment;
  const isVideo = c.kind === "video" || (c.kind === "gif" && att.mime.startsWith("video/"));
  // Built-in stickers and GIF-search results are public assets; everything else is an encrypted blob.
  const publicUrl = c.kind === "sticker" && c.sticker?.url ? absUrl(c.sticker.url) : c.kind === "gif" && c.gif ? absUrl(c.gif.url) : null;
  const uploading = att.mediaId.startsWith("local:");
  const dec = useAttachment(publicUrl || uploading ? null : att, isVideo ? "video" : "photo", c.kind === "gif" || c.kind === "sticker");
  const url = publicUrl ?? dec.url;
  const box = mediaBox(att, c.kind === "sticker" ? 160 : 320);
  if (c.kind === "sticker") {
    return (
      <div style={{ width: 160, height: 160 }} className="flex items-center justify-center">
        {url ? <img src={url} alt={c.sticker?.emoji ?? "sticker"} className="max-h-full max-w-full drop-shadow" draggable={false} /> : <div className="h-full w-full animate-pulse rounded-3xl bg-surface-2" />}
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-[10px] bg-black/10" style={box} onClick={(e) => (e.stopPropagation(), url ? onOpen() : !uploading && dec.download())}>
      {att.thumbnail && <img src={att.thumbnail} alt="" className={cn("absolute inset-0 h-full w-full object-cover", !url && "scale-110 blur-xl")} />}
      {url &&
        (isVideo ? (
          <video src={url} className="absolute inset-0 h-full w-full object-cover" muted playsInline loop={c.kind === "gif"} autoPlay={c.kind === "gif"} preload="metadata" />
        ) : (
          <img src={url} alt={c.caption ?? ""} className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        ))}
      {!url && (
        <div className="absolute inset-0 flex items-center justify-center">
          {uploading ? (
            <UploadOverlay messageId={m.id} />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur">
              {dec.error ? <X className="h-5 w-5" /> : dec.requested ? <ProgressRing value={dec.progress} /> : <Download className="h-5 w-5" />}
            </div>
          )}
        </div>
      )}
      {url && c.kind === "video" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur">
            <Play className="h-5 w-5 fill-white" />
          </div>
        </div>
      )}
      {(c.kind === "video" || c.kind === "gif") && (
        <span className="absolute left-2 top-2 rounded-md bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">{c.kind === "gif" ? "GIF" : formatDuration(att.duration ?? 0)}</span>
      )}
    </div>
  );
}

export function OnceViewMedia({ m, c, onOpen }: { m: StoredMessage; c: C<"media">; onOpen: () => void }) {
  const consumed = !m.outgoing && (m.onceViewedLocally || !c.attachment.key);
  const opened = m.outgoing && (m.onceViewedBy?.length ?? 0) > 0;
  return (
    <button
      onClick={(e) => (e.stopPropagation(), !m.outgoing && !consumed && onOpen())}
      disabled={m.outgoing || consumed}
      className={cn("flex w-60 items-center gap-3 rounded-[10px] p-3 text-left", m.outgoing ? "bg-white/15" : "bg-black/[0.05] dark:bg-white/[0.06]")}
    >
      <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", consumed || opened ? "bg-black/10" : "bg-gradient-to-br from-[#FF7A59] to-[#FF4D8D] text-white")}>
        {consumed || opened ? <Eye className="h-5 w-5 opacity-60" /> : <Flame className="h-6 w-6" />}
      </div>
      <div className="min-w-0">
        <div className="text-[15px] font-semibold">{c.kind === "video" ? "Once-view video" : "Once-view photo"}</div>
        <div className="text-[13px] opacity-75">
          {m.outgoing ? (opened ? "Opened" : "Not opened yet") : consumed ? "Opened" : "Tap to view · disappears after viewing"}
        </div>
        {(m.screenshotBy?.length ?? 0) > 0 && <div className="text-[12px] text-warning">Screenshot attempted</div>}
      </div>
    </button>
  );
}

export function VoiceMessage({ m, c }: { m: StoredMessage; c: C<"media"> }) {
  const att = c.attachment;
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [loading, setLoading] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const bars = att.waveform?.length ? att.waveform : Array.from({ length: 40 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 1.7)));
  const duration = att.duration ?? 0;
  const uploading = att.mediaId.startsWith("local:");

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    void haptic("light");
    if (!url) {
      setLoading(true);
      try {
        const b = await downloadAttachment(att);
        const u = URL.createObjectURL(b);
        setUrl(u);
        const a = new Audio(u);
        audio.current = a;
        a.ontimeupdate = () => setPos(a.duration ? a.currentTime / a.duration : 0);
        a.onended = () => (setPlaying(false), setPos(0));
        await a.play();
        setPlaying(true);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (playing) audio.current?.pause();
    else await audio.current?.play();
    setPlaying(!playing);
  }
  useEffect(() => () => audio.current?.pause(), []);

  if (uploading) {
    return (
      <div className="flex w-64 items-center gap-3 py-1">
        <UploadOverlay messageId={m.id} />
        <span className="text-[14px] opacity-80">Sending voice message… {formatDuration(duration)}</span>
      </div>
    );
  }

  return (
    <div className="flex w-64 items-center gap-3 py-1">
      <button onClick={toggle} aria-label={playing ? "Pause" : "Play"} className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full", m.outgoing ? "bg-white text-accent" : "bg-accent text-white")}>
        {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="ml-0.5 h-5 w-5 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className="flex h-8 cursor-pointer items-center gap-[2px]"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            const f = (e.clientX - r.left) / r.width;
            if (audio.current?.duration) audio.current.currentTime = f * audio.current.duration;
          }}
        >
          {bars.slice(0, 48).map((b, i, arr) => (
            <span
              key={i}
              className={cn("w-[3px] rounded-full transition-colors", i / arr.length <= pos ? (m.outgoing ? "bg-white" : "bg-accent") : m.outgoing ? "bg-white/45" : "bg-accent/35")}
              style={{ height: `${Math.max(12, b * 100)}%` }}
            />
          ))}
        </div>
        <div className="text-[12px] opacity-75">{formatDuration(playing || pos ? pos * duration : duration)}</div>
      </div>
    </div>
  );
}

function docIcon(name = "", mime = "") {
  if (/\.(zip|rar|7z|tar|gz|apk)$/i.test(name)) return FileArchive;
  void mime;
  return FileText;
}

export function DocumentMessage({ m, c }: { m: StoredMessage; c: C<"media"> }) {
  const att = c.attachment;
  const [progress, setProgress] = useState<number | null>(null);
  const Icon = docIcon(att.name, att.mime);
  const ext = (att.name?.split(".").pop() ?? "file").slice(0, 4).toUpperCase();
  async function open(e: React.MouseEvent) {
    e.stopPropagation();
    setProgress(0);
    try {
      const blob = await downloadAttachment(att, { onProgress: setProgress });
      await shareFile(blob, att.name ?? "file");
    } finally {
      setProgress(null);
    }
  }
  if (att.mediaId.startsWith("local:")) {
    return (
      <div className="flex w-64 items-center gap-3 py-1">
        <UploadOverlay messageId={m.id} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{att.name ?? "Document"}</div>
          <div className="text-[13px] opacity-75">{formatBytes(att.size)}</div>
        </div>
      </div>
    );
  }
  return (
    <button onClick={open} className="flex w-64 items-center gap-3 py-1 text-left">
      <div className={cn("relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl", m.outgoing ? "bg-white/20" : "bg-accent-soft text-accent")}>
        {progress !== null ? <span className="text-[11px] font-semibold">{Math.round(progress * 100)}%</span> : <Icon className="h-6 w-6" />}
        <span className="absolute -bottom-1 rounded bg-black/40 px-1 text-[9px] font-bold text-white">{ext}</span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[15px] font-medium">{att.name ?? "Document"}</div>
        <div className="text-[13px] opacity-75">{formatBytes(att.size)}</div>
      </div>
    </button>
  );
}

export function AudioFileMessage({ m, c }: { m: StoredMessage; c: C<"media"> }) {
  return (
    <div>
      <VoiceMessage m={m} c={c} />
      <div className="truncate px-1 text-[13px] opacity-80">{c.attachment.name}</div>
    </div>
  );
}

/* ------------------------------ location ------------------------------ */

function tileXY(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function StaticMap({ lat, lng, width = 260, height = 160, zoom = 15 }: { lat: number; lng: number; width?: number; height?: number; zoom?: number }) {
  const { x, y } = tileXY(lat, lng, zoom);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const offX = (x - tx) * 256;
  const offY = (y - ty) * 256;
  const tiles: { dx: number; dy: number }[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) tiles.push({ dx, dy });
  const base = ctx.svc("link");
  return (
    <div className="relative overflow-hidden bg-surface-2" style={{ width, height }}>
      {tiles.map(({ dx, dy }) => (
        <img
          key={`${dx}${dy}`}
          src={`${base}/tile/${zoom}/${tx + dx}/${ty + dy}.png`}
          alt=""
          className="absolute h-[256px] w-[256px] max-w-none"
          style={{ left: width / 2 - offX + dx * 256, top: height / 2 - offY + dy * 256 }}
          draggable={false}
        />
      ))}
      <MapPin className="absolute h-9 w-9 -translate-x-1/2 -translate-y-full fill-danger text-white drop-shadow-lg" style={{ left: width / 2, top: height / 2 }} />
      <span className="absolute bottom-0.5 right-1 text-[9px] text-black/60">© OpenStreetMap</span>
    </div>
  );
}

export function LocationMessage({ c }: { c: C<"location"> }) {
  return (
    <button
      onClick={(e) => (e.stopPropagation(), openExternal(`https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=16/${c.lat}/${c.lng}`))}
      className="block overflow-hidden rounded-[10px] text-left"
    >
      <StaticMap lat={c.lat} lng={c.lng} />
      {(c.label || c.address) && (
        <div className="px-1 pt-1.5">
          {c.label && <div className="text-[15px] font-medium">{c.label}</div>}
          {c.address && <div className="text-[13px] opacity-75">{c.address}</div>}
        </div>
      )}
    </button>
  );
}

/* ------------------------------ contact ------------------------------ */

export function ContactMessage({ c, outgoing }: { c: C<"contact">; outgoing?: boolean }) {
  const openChat = useUI((s) => s.openChat);
  return (
    <div className="w-60 py-1">
      <div className="flex items-center gap-3">
        <Avatar id={c.userId ?? c.name} name={c.name} size={44} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{c.name}</div>
          <div className="truncate text-[13px] opacity-75">{c.phone ?? (c.username ? `@${c.username}` : "")}</div>
        </div>
      </div>
      {c.userId && c.userId !== ctx.account?.userId && (
        <button
          onClick={(e) => (e.stopPropagation(), openChat(`u:${c.userId}`))}
          className={cn("mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[14px] font-medium", outgoing ? "bg-white/20" : "bg-accent-soft text-accent")}
        >
          <UserPlus className="h-4 w-4" /> Send message
        </button>
      )}
    </div>
  );
}

/* ------------------------------ poll ------------------------------ */

export function PollMessage({ m, c }: { m: StoredMessage; c: C<"poll"> }) {
  const me = ctx.account!.userId;
  const votes = m.pollVotes ?? {};
  const mine = votes[me] ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const voted = mine.length > 0;
  const closed = m.pollClosed || (c.closesAt ? Date.now() > c.closesAt : false);
  const reveal = voted || closed;
  const total = Object.values(votes).filter((v) => v.length).length;
  const counts = Object.fromEntries(c.options.map((o) => [o.id, Object.values(votes).filter((v) => v.includes(o.id)).length]));
  const vote = (ids: string[]) => {
    void haptic("light");
    void votePoll(m.chatId, m.id, ids);
  };
  return (
    <div className="w-72 py-1">
      <div className="text-[15px] font-semibold">{c.question}</div>
      <div className="mb-2 text-[12px] opacity-70">
        {c.quiz ? "Quiz" : c.anonymous ? "Anonymous poll" : "Public poll"}
        {c.multiple && " · multiple answers"}
        {closed && " · final results"}
      </div>
      <div className="space-y-1.5">
        {c.options.map((o) => {
          const pct = total ? Math.round((counts[o.id] / total) * 100) : 0;
          const isMine = mine.includes(o.id);
          const correct = c.quiz && reveal && c.quiz.correctOptionId === o.id;
          const wrong = c.quiz && reveal && isMine && !correct;
          return (
            <button
              key={o.id}
              disabled={reveal && !(!c.quiz && !closed)}
              onClick={(e) => {
                e.stopPropagation();
                if (closed) return;
                if (c.multiple && !voted) setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
                else if (!voted || !c.quiz) vote(isMine && !c.quiz ? [] : [o.id]);
              }}
              className="relative block w-full overflow-hidden rounded-lg px-3 py-2 text-left text-[14px]"
            >
              <div className={cn("absolute inset-0 rounded-lg", m.outgoing ? "bg-white/15" : "bg-black/[0.05] dark:bg-white/[0.06]")} />
              {reveal && (
                <div
                  className={cn("absolute inset-y-0 left-0 rounded-lg transition-all duration-500", correct ? "bg-online/40" : wrong ? "bg-danger/35" : m.outgoing ? "bg-white/30" : "bg-accent/25")}
                  style={{ width: `${pct}%` }}
                />
              )}
              <div className="relative flex items-center gap-2">
                {!reveal && c.multiple && (
                  <span className={cn("flex h-4 w-4 items-center justify-center rounded border", picked.includes(o.id) ? "border-transparent bg-accent text-white" : "border-current opacity-60")}>
                    {picked.includes(o.id) && <Check className="h-3 w-3" />}
                  </span>
                )}
                <span className="flex-1">{o.text}</span>
                {isMine && <Check className="h-4 w-4" />}
                {reveal && <span className="font-semibold tabular-nums">{pct}%</span>}
              </div>
            </button>
          );
        })}
      </div>
      {c.multiple && !voted && !closed && picked.length > 0 && (
        <button onClick={(e) => (e.stopPropagation(), vote(picked), setPicked([]))} className="mt-2 w-full rounded-lg bg-accent py-1.5 text-[14px] font-semibold text-white">
          Vote
        </button>
      )}
      {c.quiz && reveal && c.quiz.explanation && <div className="mt-2 rounded-lg bg-black/5 p-2 text-[13px]">💡 {c.quiz.explanation}</div>}
      <div className="mt-2 flex items-center justify-between text-[12px] opacity-75">
        <span>{total === 0 ? "No votes yet" : `${total} vote${total === 1 ? "" : "s"}`}</span>
        {m.outgoing && !closed && (
          <button onClick={(e) => (e.stopPropagation(), void closePoll(m.chatId, m.id))} className="font-medium underline">
            Stop poll
          </button>
        )}
      </div>
      {!c.anonymous && reveal && total > 0 && <PollVoters votes={votes} options={c.options} />}
    </div>
  );
}

function PollVoters({ votes, options }: { votes: Record<string, string[]>; options: { id: string; text: string }[] }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button onClick={(e) => (e.stopPropagation(), setOpen(true))} className="mt-1 text-[12px] underline opacity-75">View votes</button>;
  return (
    <div className="mt-2 space-y-1 text-[12px]">
      {options.map((o) => (
        <div key={o.id}>
          <span className="font-semibold">{o.text}:</span>{" "}
          {Object.entries(votes)
            .filter(([, v]) => v.includes(o.id))
            .map(([u]) => <VoterName key={u} id={u} />)}
        </div>
      ))}
    </div>
  );
}

function VoterName({ id }: { id: string }) {
  const u = useUser(id);
  return <span className="mr-1">{id === ctx.account?.userId ? "You" : displayName(u)}</span>;
}

/* ------------------------------ event ------------------------------ */

function icsFor(c: C<"event">) {
  const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s = "") => s.replace(/[\\,;]/g, (x) => "\\" + x).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veil//EN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@veil`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(c.startsAt)}`,
    `DTEND:${fmt(c.endsAt ?? c.startsAt + 3600000)}`,
    `SUMMARY:${esc(c.title)}`,
    c.location ? `LOCATION:${esc(c.location)}` : "",
    c.description ? `DESCRIPTION:${esc(c.description)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export function EventMessage({ m, c }: { m: StoredMessage; c: C<"event"> }) {
  const me = ctx.account!.userId;
  const rs = m.rsvps ?? {};
  const mine = rs[me];
  const count = (s: string) => Object.values(rs).filter((v) => v === s).length;
  const d = new Date(c.startsAt);
  return (
    <div className="w-72 py-1">
      <div className="flex gap-3">
        <div className={cn("flex h-14 w-12 shrink-0 flex-col items-center justify-center rounded-xl", m.outgoing ? "bg-white/20" : "bg-accent-soft text-accent")}>
          <span className="text-[11px] font-semibold uppercase">{d.toLocaleDateString([], { month: "short" })}</span>
          <span className="text-xl font-bold leading-none">{d.getDate()}</span>
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{c.title}</div>
          <div className="text-[13px] opacity-80">
            {d.toLocaleDateString([], { weekday: "long" })} · {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {c.endsAt && ` – ${new Date(c.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </div>
          {c.location && (
            <div className="mt-0.5 flex items-center gap-1 text-[13px] opacity-80">
              <MapPin className="h-3.5 w-3.5" /> {c.location}
            </div>
          )}
        </div>
      </div>
      {c.description && <p className="mt-2 whitespace-pre-wrap text-[14px]">{c.description}</p>}
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {(["going", "maybe", "declined"] as const).map((s) => (
          <button
            key={s}
            onClick={(e) => (e.stopPropagation(), void haptic("light"), void rsvp(m.chatId, m.id, s))}
            className={cn(
              "rounded-lg py-1.5 text-[13px] font-medium capitalize",
              mine === s ? (m.outgoing ? "bg-white text-accent" : "bg-accent text-white") : m.outgoing ? "bg-white/15" : "bg-black/[0.05] dark:bg-white/[0.07]",
            )}
          >
            {s === "declined" ? "Can't go" : s} {count(s) > 0 && `· ${count(s)}`}
          </button>
        ))}
      </div>
      <button
        onClick={(e) => (e.stopPropagation(), void shareFile(new Blob([icsFor(c)], { type: "text/calendar" }), `${c.title.replace(/[^\w ]/g, "")}.ics`))}
        className="mt-2 flex w-full items-center justify-center gap-1.5 text-[13px] opacity-80 hover:opacity-100"
      >
        <Calendar className="h-4 w-4" /> Add to calendar
      </button>
    </div>
  );
}

/* ------------------------------ call ------------------------------ */

export function CallMessage({ m, c }: { m: StoredMessage; c: C<"call"> }) {
  const missed = c.outcome === "missed" || c.outcome === "declined" || c.outcome === "busy";
  const Icon = missed && !m.outgoing ? PhoneMissed : m.outgoing ? PhoneOutgoing : PhoneIncoming;
  const label =
    c.outcome === "completed"
      ? `${m.outgoing ? "Outgoing" : "Incoming"} ${c.video ? "video " : ""}call`
      : c.outcome === "missed"
        ? m.outgoing ? "Cancelled call" : "Missed call"
        : c.outcome === "declined"
          ? "Declined call"
          : c.outcome === "busy"
            ? "Line busy"
            : "Cancelled call";
  return (
    <div className="flex items-center gap-3 py-1 pr-6">
      <div className={cn("flex h-10 w-10 items-center justify-center rounded-full", m.outgoing ? "bg-white/20" : missed ? "bg-danger/15 text-danger" : "bg-accent-soft text-accent")}>
        {c.video ? <Video className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
      </div>
      <div>
        <div className="text-[15px] font-medium">{label}</div>
        <div className="flex items-center gap-1 text-[13px] opacity-75">
          <Phone className="h-3 w-3" />
          {c.duration ? formatDuration(c.duration) : "—"}
        </div>
      </div>
    </div>
  );
}
