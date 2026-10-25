"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Attachment, MeUser } from "@veil/shared";
import { allChats, getChat, getMessage, messagesAround, messagesForChat } from "../lib/db";
import type { CachedUser, LocalChat, StoredMessage } from "../lib/types";
import { attachmentUrl, bus, callStore, cachedUser, connectionState, ctx, getSettings, getUser, type SyncedSettings } from "../engine";
import { networkIsWifi } from "../lib/native";

export function useBus<K extends Parameters<typeof bus.on>[0]>(event: K, fn: Parameters<typeof bus.on<K>>[1], deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => bus.on(event, ((p: never) => ref.current(p)) as never), deps);
}

export function useMe(): MeUser | null {
  const [me, setMe] = useState(ctx.me);
  useBus("account:changed", () => setMe(ctx.me ? { ...ctx.me } : null));
  return me;
}

export function sortChats(a: LocalChat, b: LocalChat) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  return b.lastTs - a.lastTs;
}

export function useChats(): { chats: LocalChat[]; loading: boolean } {
  const [chats, setChats] = useState<LocalChat[]>([]);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    const all = await allChats();
    setChats(all.filter((c) => !c.hidden && (c.lastMessageId || c.summary || c.draft)).sort(sortChats));
    setLoading(false);
  }, []);
  useEffect(() => void load(), [load]);
  useBus("chats:changed", () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 60);
  });
  return { chats, loading };
}

export function useChat(id: string | null): LocalChat | null {
  const [chat, setChat] = useState<LocalChat | null>(null);
  useEffect(() => {
    if (!id) return setChat(null);
    void getChat(id).then((c) => setChat(c ?? null));
  }, [id]);
  useBus("chats:changed", (e) => {
    if (id && e.ids.includes(id)) void getChat(id).then((c) => setChat(c ?? null));
  }, [id]);
  return chat;
}

const PAGE = 60;

export function useMessages(chatId: string | null) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [detached, setDetached] = useState(false); // viewing an older window (after jump)
  const loadingOlder = useRef(false);

  useEffect(() => {
    if (!chatId) return;
    let cancel = false;
    setLoaded(false);
    setDetached(false);
    void messagesForChat(chatId, { limit: PAGE }).then((m) => {
      if (cancel) return;
      setMessages(m);
      setHasOlder(m.length === PAGE);
      setLoaded(true);
    });
    return () => {
      cancel = true;
    };
  }, [chatId]);

  useBus("messages:changed", (e) => {
    if (e.chatId !== chatId) return;
    void (async () => {
      const updated = (await Promise.all(e.ids.map((id) => getMessage(id)))).filter(Boolean) as StoredMessage[];
      setMessages((prev) => {
        const map = new Map(prev.map((m) => [m.id, m]));
        for (const id of e.removed ?? []) map.delete(id);
        for (const m of updated) if (m.chatId === chatId && (!detached || map.has(m.id))) map.set(m.id, m);
        return [...map.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      });
    })();
  }, [chatId, detached]);

  const loadOlder = useCallback(async () => {
    if (!chatId || loadingOlder.current || !hasOlder || !messages.length) return;
    loadingOlder.current = true;
    const older = await messagesForChat(chatId, { beforeKey: messages[0].sortKey, limit: PAGE });
    setMessages((prev) => [...older, ...prev.filter((p) => !older.some((o) => o.id === p.id))]);
    setHasOlder(older.length === PAGE);
    loadingOlder.current = false;
  }, [chatId, hasOlder, messages]);

  const jumpAround = useCallback(
    async (messageId: string) => {
      if (!chatId) return false;
      if (messages.some((m) => m.id === messageId)) return true;
      const target = await getMessage(messageId);
      if (!target || target.chatId !== chatId) return false;
      const around = await messagesAround(chatId, target.sortKey);
      setMessages(around);
      setHasOlder(true);
      setDetached(true);
      return true;
    },
    [chatId, messages],
  );

  const backToLatest = useCallback(async () => {
    if (!chatId) return;
    setMessages(await messagesForChat(chatId, { limit: PAGE }));
    setDetached(false);
    setHasOlder(true);
  }, [chatId]);

  return { messages, loaded, hasOlder, loadOlder, jumpAround, detached, backToLatest };
}

export function useUser(id: string | null | undefined): CachedUser | undefined {
  const [u, setU] = useState<CachedUser | undefined>(() => (id ? cachedUser(id) : undefined));
  useEffect(() => {
    if (!id) return setU(undefined);
    setU(cachedUser(id));
    let cancel = false;
    void getUser(id).then((x) => !cancel && setU(x));
    return () => {
      cancel = true;
    };
  }, [id]);
  useBus("presence", (p) => {
    if (p.userId === id) setU((prev) => (prev ? { ...cachedUser(id!)!, fetchedAt: prev.fetchedAt } : prev));
  }, [id]);
  return u;
}

export function useTyping(chatId: string | null): { userId: string; action: string }[] {
  const [map, setMap] = useState<Record<string, { action: string; until: number }>>({});
  useEffect(() => setMap({}), [chatId]);
  useBus("typing", (t) => {
    if (t.chatId !== chatId) return;
    setMap((m) => {
      const next = { ...m };
      if (t.action === "stop") delete next[t.userId];
      else next[t.userId] = { action: t.action, until: Date.now() + 6000 };
      return next;
    });
  }, [chatId]);
  useEffect(() => {
    const i = setInterval(() => setMap((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.until > Date.now()))), 1500);
    return () => clearInterval(i);
  }, []);
  return useMemo(() => Object.entries(map).map(([userId, v]) => ({ userId, action: v.action })), [map]);
}

/** Typing state for many chats at once (chat list). */
export function useTypingAll(): Record<string, string> {
  const [map, setMap] = useState<Record<string, { until: number; action: string }>>({});
  useBus("typing", (t) => setMap((m) => ({ ...m, [t.chatId]: { until: t.action === "stop" ? 0 : Date.now() + 6000, action: t.action } })));
  useEffect(() => {
    const i = setInterval(() => setMap((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.until > Date.now()))), 1500);
    return () => clearInterval(i);
  }, []);
  return useMemo(() => Object.fromEntries(Object.entries(map).filter(([, v]) => v.until > Date.now()).map(([k, v]) => [k, v.action])), [map]);
}

export function useConnection() {
  const [state, setState] = useState<"connecting" | "online" | "offline" | "syncing">(connectionState);
  useBus("connection", (c) => setState(c.state));
  return state;
}

export function useCall() {
  return useSyncExternalStore(callStore.subscribe, callStore.get, callStore.get);
}

export function useSettings(): SyncedSettings | null {
  const [s, setS] = useState<SyncedSettings | null>(null);
  const load = useCallback(() => void getSettings().then(setS), []);
  useEffect(load, [load]);
  useBus("account:changed", load);
  return s;
}

type MediaClass = "photo" | "video" | "document" | "audio";

/** Decrypted object URL for an attachment, honoring auto-download preferences. */
export function useAttachment(att: Pick<Attachment, "mediaId" | "key" | "mime" | "encryptedSize"> | null | undefined, cls: MediaClass = "photo", force = false) {
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(force);
  const [loading, setLoading] = useState(false);
  const settings = useSettings();

  useEffect(() => {
    if (!att?.key || !settings) return;
    let cancel = false;
    void (async () => {
      const mode = settings.autoDownload[cls];
      const auto = requested || mode === "always" || (mode === "wifi" && (await networkIsWifi()));
      if (!auto) return;
      setLoading(true);
      try {
        const u = await attachmentUrl(att, { onProgress: (f) => !cancel && setProgress(f) });
        if (!cancel) setUrl(u);
      } catch (e) {
        if (!cancel) setError((e as Error).message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [att?.mediaId, att?.key, requested, settings, cls]); // eslint-disable-line react-hooks/exhaustive-deps

  return { url, progress, error, download: () => setRequested(true), requested: requested || loading || !!url };
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    h();
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [q]);
  return m;
}

export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(i);
  }, [intervalMs]);
  return now;
}
