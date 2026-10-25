import { kvGet, kvSet } from "../lib/db";
import { bus } from "./bus";
import { vaultWrite } from "./vault";

/** User preferences. "synced" ones roam across devices via the vault; app-lock stays per device. */

export interface SyncedSettings {
  readReceipts: boolean;
  linkPreviews: boolean;
  sendWithEnter: boolean;
  autoDownload: { photo: AutoMode; video: AutoMode; document: AutoMode; audio: AutoMode };
  reactionsQuick: string[];
  textSize: number;
  chatWallpaper: string;
}
export type AutoMode = "always" | "wifi" | "never";

export interface LockSettings {
  enabled: boolean;
  method: "pin" | "biometric" | "both";
  timeoutSec: number;
  pinHash?: string;
  pinSalt?: string;
  pinLength?: number;
  failedAttempts?: number;
  lockedUntil?: number;
}

export const DEFAULT_SETTINGS: SyncedSettings = {
  readReceipts: true,
  linkPreviews: true,
  sendWithEnter: true,
  autoDownload: { photo: "always", video: "wifi", document: "wifi", audio: "always" },
  reactionsQuick: ["👍", "❤️", "🔥", "😂", "😮", "😢", "🙏"],
  textSize: 15,
  chatWallpaper: "default",
};

export async function getSettings(): Promise<SyncedSettings> {
  return { ...DEFAULT_SETTINGS, ...((await kvGet<Partial<SyncedSettings>>("settings:app")) ?? {}) };
}

export async function updateSettings(patch: Partial<SyncedSettings>) {
  const next = { ...(await getSettings()), ...patch };
  await kvSet("settings:app", next);
  await kvSet("settings:readReceipts", next.readReceipts);
  vaultWrite("settings", "app", next);
  bus.emit("account:changed", undefined);
  return next;
}

/* ------------------------------ app lock (device-local) ------------------------------ */

const LOCK_KEY = "veil:lock";

/** Lock settings live in localStorage (not the encrypted DB) so the gate can render before anything else loads.
 *  The PIN is stored only as a salted PBKDF2-SHA256 hash. */
export function getLockSettings(): LockSettings {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) return JSON.parse(raw) as LockSettings;
  } catch {
    /* noop */
  }
  return { enabled: false, method: "pin", timeoutSec: 0 };
}

export function saveLockSettings(s: LockSettings) {
  localStorage.setItem(LOCK_KEY, JSON.stringify(s));
}

export async function hashPin(pin: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, key, 256);
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  return { hash: b64(new Uint8Array(bits)), salt: b64(salt) };
}

export async function verifyPin(pin: string): Promise<boolean> {
  const s = getLockSettings();
  if (!s.pinHash || !s.pinSalt) return false;
  const { hash } = await hashPin(pin, s.pinSalt);
  // Constant-time-ish compare on equal-length base64 strings.
  let diff = hash.length ^ s.pinHash.length;
  for (let i = 0; i < Math.min(hash.length, s.pinHash.length); i++) diff |= hash.charCodeAt(i) ^ s.pinHash.charCodeAt(i);
  return diff === 0;
}
