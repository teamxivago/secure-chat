"use client";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Clock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ctx, sendMessage } from "../engine";
import { EMOJI_CATEGORIES, pushRecentEmoji, recentEmoji, splitEmoji } from "../lib/emoji";
import { cn } from "../lib/cn";
import { haptic } from "../lib/native";
import type { LocalChat } from "../lib/types";
import { useUI } from "../store/ui";
import { Input, Segmented, Spinner } from "./primitives";

const EMPTY_ATT = { mediaId: "", key: "", size: 0, encryptedSize: 0 };

interface Gif {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  mp4: boolean;
}

const abs = (u: string) => (u.startsWith("/") ? `${ctx.api.baseUrl}${u}` : u);

export function EmojiPanel({ chat, onEmoji, onClose }: { chat: LocalChat; onEmoji: (e: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"emoji" | "stickers" | "gifs">("emoji");
  const [recent, setRecent] = useState<string[]>([]);
  const replyTo = useUI((s) => s.replyTo[chat.id]);
  const setReply = useUI((s) => s.setReply);
  useEffect(() => setRecent(recentEmoji()), []);
  const cats = useMemo(() => EMOJI_CATEGORIES.map((c) => ({ ...c, list: splitEmoji(c.emojis) })), []);

  const stickers = useQuery({ queryKey: ["stickers"], queryFn: () => ctx.api.stickers.list(), enabled: tab === "stickers", staleTime: 300_000 });
  const [gq, setGq] = useState("");
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [gifErr, setGifErr] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "gifs") return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${ctx.svc("link")}/gifs${gq ? `?q=${encodeURIComponent(gq)}` : ""}`, { headers: { Authorization: `Bearer ${ctx.account?.token}` }, signal: ctrl.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setGifs(data.results);
        setGifErr(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setGifErr((e as Error).message);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [tab, gq]);

  async function sendSticker(packId: string, s: { id: string; emoji: string; url: string; mime: string }) {
    void haptic("light");
    onClose();
    await sendMessage(chat.id, { t: "media", kind: "sticker", attachment: { ...EMPTY_ATT, mime: s.mime, width: 256, height: 256 }, sticker: { packId, stickerId: s.id, emoji: s.emoji, url: s.url } }, { replyTo: replyTo ?? undefined });
    setReply(chat.id, null);
  }

  async function sendGif(g: Gif) {
    void haptic("light");
    onClose();
    await sendMessage(chat.id, {
      t: "media",
      kind: "gif",
      attachment: { ...EMPTY_ATT, mime: g.mp4 ? "video/mp4" : "image/gif", width: g.width, height: g.height },
      gif: { url: g.url, previewUrl: g.previewUrl, width: g.width, height: g.height },
    }, { replyTo: replyTo ?? undefined }).catch((e) => toast.error(e.message));
    setReply(chat.id, null);
  }

  return (
    <motion.div initial={{ height: 0 }} animate={{ height: 320 }} exit={{ height: 0 }} transition={{ type: "spring", stiffness: 400, damping: 38 }} className="overflow-hidden border-t border-border bg-bg">
      <div className="flex h-[320px] flex-col">
        <div className="p-2">
          <Segmented value={tab} onChange={setTab} options={[{ value: "emoji", label: "Emoji" }, { value: "stickers", label: "Stickers" }, { value: "gifs", label: "GIFs" }]} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {tab === "emoji" && (
            <>
              {recent.length > 0 && (
                <EmojiGroup title="Recent" icon={<Clock className="h-3.5 w-3.5" />} list={recent} onPick={(e) => (pushRecentEmoji(e), setRecent(recentEmoji()), onEmoji(e))} />
              )}
              {cats.map((c) => (
                <EmojiGroup key={c.id} title={c.label} list={c.list} onPick={(e) => (pushRecentEmoji(e), setRecent(recentEmoji()), onEmoji(e))} />
              ))}
            </>
          )}
          {tab === "stickers" &&
            (stickers.isLoading ? (
              <div className="flex justify-center p-6"><Spinner /></div>
            ) : (
              stickers.data?.packs.map((p) => (
                <div key={p.id} className="mb-3">
                  <div className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted">{p.title}</div>
                  <div className="grid grid-cols-5 gap-1 sm:grid-cols-6">
                    {p.stickers.map((s) => (
                      <button key={s.id} onClick={() => sendSticker(p.id, s)} className="aspect-square rounded-xl p-1 transition hover:bg-surface active:scale-90" aria-label={`Sticker ${s.emoji}`}>
                        <img src={abs(s.url)} alt={s.emoji} className="h-full w-full" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ))}
          {tab === "gifs" && (
            <>
              <Input leading={<Search className="h-4 w-4" />} placeholder="Search GIFs" value={gq} onChange={(e) => setGq(e.target.value)} className="mb-2" />
              {gifErr ? (
                <p className="p-4 text-center text-sm text-muted">{gifErr}</p>
              ) : !gifs ? (
                <div className="flex justify-center p-6"><Spinner /></div>
              ) : (
                <div className="columns-2 gap-1 sm:columns-3">
                  {gifs.map((g) => (
                    <button key={g.id} onClick={() => sendGif(g)} className="mb-1 block w-full overflow-hidden rounded-lg">
                      <img src={abs(g.previewUrl)} alt={g.title} className="w-full" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function EmojiGroup({ title, list, onPick, icon }: { title: string; list: string[]; onPick: (e: string) => void; icon?: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1 px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted">
        {icon}
        {title}
      </div>
      <div className="grid grid-cols-8 sm:grid-cols-10">
        {list.map((e, i) => (
          <button key={e + i} onClick={() => (void haptic("selection"), onPick(e))} className={cn("flex aspect-square items-center justify-center rounded-lg text-[26px] transition hover:bg-surface active:scale-90")}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
