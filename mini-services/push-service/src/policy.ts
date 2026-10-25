/** Pure notification policy (unit-tested). */

export interface GlobalSettings {
  dnd?: boolean;
  quietHours?: { start: string; end: string; tz: string } | null;
}

export interface ScopePref {
  mode: "all" | "mentions" | "none";
  mutedUntil: number | null;
}

function minutesInTz(now: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(g: GlobalSettings | null | undefined, now = new Date()): boolean {
  if (!g) return false;
  if (g.dnd) return true;
  const q = g.quietHours;
  if (!q) return false;
  const cur = minutesInTz(now, q.tz);
  const s = toMin(q.start);
  const e = toMin(q.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e; // window may wrap past midnight
}

export function shouldNotify(opts: {
  kind: "group" | "channel" | "mention" | "message" | "reaction" | "call" | "system";
  mentioned: boolean;
  chatPref?: ScopePref | null;
  typeDefault?: ScopePref | null;
  global?: GlobalSettings | null;
  now?: Date;
}): boolean {
  const now = opts.now ?? new Date();
  if (opts.kind === "call") return true; // calls ring through DND (OS-level focus modes still apply)
  if (inQuietHours(opts.global, now)) return false;
  const pref = opts.chatPref ?? opts.typeDefault ?? { mode: opts.kind === "channel" ? "none" : "all", mutedUntil: null };
  const muted = pref.mutedUntil !== null && pref.mutedUntil > now.getTime();
  // Mentions break through muting unless the chat is fully silenced and muted.
  if (opts.mentioned) return pref.mode !== "none" || !muted;
  if (muted) return false;
  if (pref.mode === "none" || pref.mode === "mentions") return false;
  return true;
}
