"use client";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Download, Flame, Forward, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Content } from "@veil/shared";
import { attachmentUrl, consumeOnceView, ctx, deleteMessages, displayName, downloadAttachment, reportScreenshot } from "../engine";
import { useUser } from "../hooks";
import { cn } from "../lib/cn";
import { formatTime } from "../lib/format";
import { enableSecureScreen, haptic, onCaptureChanged, onScreenshot, shareFile } from "../lib/native";
import type { StoredMessage } from "../lib/types";
import { useUI } from "../store/ui";
import { Spinner } from "./primitives";

type Media = Extract<Content, { t: "media" }>;

function useDecrypted(m: StoredMessage | null, noCache = false) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!m || m.content.t !== "media") return;
    const c = m.content;
    if (c.kind === "gif" && c.gif) return setUrl(c.gif.url.startsWith("/") ? ctx.api.baseUrl + c.gif.url : c.gif.url);
    let cancel = false;
    let local: string | null = null;
    (noCache ? downloadAttachment(c.attachment, { noCache: true }).then((b) => (local = URL.createObjectURL(b))) : attachmentUrl(c.attachment))
      .then((u) => !cancel && setUrl(u))
      .catch((e) => !cancel && setError(e.message));
    return () => {
      cancel = true;
      if (local) URL.revokeObjectURL(local);
    };
  }, [m, noCache]);
  return { url, error };
}

/** Full-screen gallery for photos, videos and GIFs in a chat. */
export function MediaViewer() {
  const { viewer, set } = useUI();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (viewer) setIndex(viewer.index);
    setZoom(1);
  }, [viewer]);
  const m = viewer?.items[index] ?? null;
  const { url, error } = useDecrypted(m);
  const sender = useUser(m?.senderId);
  const close = () => set({ viewer: null });
  const go = (d: number) => {
    if (!viewer) return;
    const n = index + d;
    if (n >= 0 && n < viewer.items.length) {
      void haptic("light");
      setIndex(n);
      setZoom(1);
    }
  };
  useEffect(() => {
    if (!viewer) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const c = m?.content as Media | undefined;
  const isVideo = !!c && (c.kind === "video" || (c.kind === "gif" && c.attachment.mime.startsWith("video/")));

  return (
    <AnimatePresence>
      {viewer && m && c && (
        <motion.div className="fixed inset-0 z-[60] flex flex-col bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="safe-top flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent p-3 text-white">
            <button onClick={close} aria-label="Close" className="rounded-full p-2 hover:bg-white/10">
              <X className="h-6 w-6" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{m.outgoing ? "You" : displayName(sender)}</div>
              <div className="text-sm text-white/70">
                {new Date(m.ts).toLocaleDateString()} {formatTime(m.ts)} · {index + 1} of {viewer.items.length}
              </div>
            </div>
            <button
              aria-label="Forward"
              className="rounded-full p-2 hover:bg-white/10"
              onClick={() => {
                close();
                set({ forwarding: [m] });
              }}
            >
              <Forward className="h-5 w-5" />
            </button>
            <button aria-label="Save" className="rounded-full p-2 hover:bg-white/10" onClick={async () => shareFile(await downloadAttachment(c.attachment), c.attachment.name ?? `veil-${m.id.slice(0, 8)}`)}>
              <Download className="h-5 w-5" />
            </button>
            {m.outgoing && (
              <button
                aria-label="Delete"
                className="rounded-full p-2 hover:bg-white/10"
                onClick={async () => {
                  await deleteMessages(m.chatId, [m.id], true);
                  close();
                  toast("Deleted for everyone");
                }}
              >
                <Trash2 className="h-5 w-5" />
              </button>
            )}
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden" onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2.5))}>
            {!url && !error && <Spinner className="text-white" />}
            {error && <p className="text-white/70">{error}</p>}
            {url && (
              <motion.div
                key={m.id}
                className="flex h-full w-full items-center justify-center"
                drag={zoom === 1 ? "x" : true}
                dragConstraints={zoom === 1 ? { left: 0, right: 0 } : undefined}
                onDragEnd={(_, i) => zoom === 1 && (i.offset.x < -80 ? go(1) : i.offset.x > 80 ? go(-1) : undefined)}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: zoom }}
              >
                {isVideo ? (
                  <video src={url} controls autoPlay playsInline loop={c.kind === "gif"} className="max-h-full max-w-full" />
                ) : (
                  <img src={url} alt={c.caption ?? ""} className="max-h-full max-w-full select-none object-contain" draggable={false} />
                )}
              </motion.div>
            )}
            {index > 0 && (
              <button onClick={() => go(-1)} className="absolute left-3 hidden rounded-full bg-white/10 p-3 text-white hover:bg-white/20 md:block" aria-label="Previous">
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}
            {index < viewer.items.length - 1 && (
              <button onClick={() => go(1)} className="absolute right-3 hidden rounded-full bg-white/10 p-3 text-white hover:bg-white/20 md:block" aria-label="Next">
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>
          {c.caption && <div className="safe-bottom bg-gradient-to-t from-black/80 to-transparent p-4 text-center text-white">{c.caption}</div>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Once-view viewer. Screen capture is blocked by the native secure-window flag; if a capture is
 * detected (iOS screenshot / screen recording) the sender is notified and content is hidden. When
 * closed, the blob is deleted from storage and the local key destroyed.
 */
export function OnceViewViewer({ m, onClose }: { m: StoredMessage | null; onClose: () => void }) {
  const { url, error } = useDecrypted(m, true);
  const [captured, setCaptured] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!m) return;
    void enableSecureScreen();
    let offShot: (() => void) | undefined;
    let offCap: (() => void) | undefined;
    void onScreenshot(() => {
      void haptic("warning");
      void reportScreenshot(m.chatId, m.id);
      toast.warning("Screenshots are blocked — the sender has been notified");
    }).then((f) => (offShot = f));
    void onCaptureChanged((c) => {
      setCaptured(c);
      if (c) void reportScreenshot(m.chatId, m.id);
    }).then((f) => (offCap = f));
    const blur = () => setHidden(true);
    const focus = () => setHidden(false);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", blur);
    const k = (e: KeyboardEvent) => {
      // PrintScreen / macOS screenshot chords on desktop browsers
      if (e.key === "PrintScreen" || (e.metaKey && e.shiftKey && ["3", "4", "5"].includes(e.key))) {
        setHidden(true);
        void reportScreenshot(m.chatId, m.id);
      }
    };
    window.addEventListener("keyup", k);
    return () => {
      offShot?.();
      offCap?.();
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", blur);
      window.removeEventListener("keyup", k);
    };
  }, [m]);

  // A viewing window of 10s for photos (videos play once) before auto-destruction.
  useEffect(() => {
    if (!url || !m) return;
    const isVideo = (m.content as Media).kind === "video";
    if (isVideo) return;
    setLeft(10);
    const i = setInterval(() => setLeft((l) => (l !== null && l > 1 ? l - 1 : 0)), 1000);
    return () => clearInterval(i);
  }, [url, m]);
  useEffect(() => {
    if (left === 0) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  function finish() {
    if (m) void consumeOnceView(m.chatId, m.id);
    setLeft(null);
    onClose();
  }

  const c = m?.content as Media | undefined;
  return (
    <AnimatePresence>
      {m && c && (
        <motion.div className="no-select fixed inset-0 z-[70] flex flex-col bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onContextMenu={(e) => e.preventDefault()}>
          <div className="safe-top flex items-center gap-3 p-3 text-white">
            <button onClick={finish} aria-label="Close" className="rounded-full p-2 hover:bg-white/10">
              <X className="h-6 w-6" />
            </button>
            <Flame className="h-5 w-5 text-[#FF4D8D]" />
            <span className="flex-1 font-medium">Once-view</span>
            {left !== null && <span className="rounded-full bg-white/15 px-3 py-1 font-mono text-sm tabular-nums">{left}s</span>}
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden">
            {!url && !error && <Spinner className="text-white" />}
            {error && <p className="text-white/70">This media was already viewed or has expired.</p>}
            {url &&
              (c.kind === "video" ? (
                <video src={url} autoPlay playsInline controls={false} onEnded={finish} className={cn("max-h-full max-w-full", (hidden || captured) && "secure-blur")} />
              ) : (
                <img src={url} alt="" className={cn("max-h-full max-w-full object-contain", (hidden || captured) && "secure-blur")} draggable={false} />
              ))}
            {(hidden || captured) && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
                <ShieldAlert className="h-10 w-10" />
                <p>{captured ? "Screen recording detected" : "Hidden while the app isn't focused"}</p>
              </div>
            )}
          </div>
          <p className="safe-bottom p-4 text-center text-sm text-white/60">This media will be destroyed when you close it.</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
