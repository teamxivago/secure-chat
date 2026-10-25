export const directChatId = (peerUserId: string) => `u:${peerUserId}`;
export const isDirectChatId = (id: string) => id.startsWith("u:");
export const peerFromChatId = (id: string) => (id.startsWith("u:") ? id.slice(2) : null);

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/gi;
export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

export function classifyUrl(url: string): "youtube" | "twitter" | "instagram" | "generic" {
  try {
    const h = new URL(url).hostname.replace(/^www\.|^m\./, "");
    if (h === "youtube.com" || h === "youtu.be" || h === "music.youtube.com") return "youtube";
    if (h === "twitter.com" || h === "x.com" || h === "mobile.twitter.com") return "twitter";
    if (h === "instagram.com" || h === "instagr.am") return "instagram";
  } catch {
    /* noop */
  }
  return "generic";
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Telegram-style coarse presence strings. */
export function presenceLabel(p: { online?: boolean; lastSeenAt?: number | null; approx?: "recently" | "week" | "month" | "long" | null }, now = Date.now()): string {
  if (p.online) return "online";
  if (p.approx === "recently") return "last seen recently";
  if (p.approx === "week") return "last seen within a week";
  if (p.approx === "month") return "last seen within a month";
  if (p.approx === "long" || !p.lastSeenAt) return "last seen a long time ago";
  const diff = Math.max(0, now - p.lastSeenAt);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "last seen just now";
  if (min < 60) return `last seen ${min} minute${min === 1 ? "" : "s"} ago`;
  const d = new Date(p.lastSeenAt);
  const today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `last seen today at ${time}`;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString()}`;
}

/** Coarsens a last-seen timestamp for viewers who may not see the exact time. */
export function coarsenLastSeen(ts: number | null, now = Date.now()): "recently" | "week" | "month" | "long" {
  if (!ts) return "long";
  const d = now - ts;
  if (d < 3 * 86400000) return "recently";
  if (d < 7 * 86400000) return "week";
  if (d < 30 * 86400000) return "month";
  return "long";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function snippet(text: string, n = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
