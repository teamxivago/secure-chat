import { Capacitor } from "@capacitor/core";

export const isNative = () => Capacitor.isNativePlatform();
export const platform = (): "ios" | "android" | "web" => Capacitor.getPlatform() as "ios" | "android" | "web";
export const isBrowser = typeof window !== "undefined";

export function deviceName(): string {
  if (!isBrowser) return "Unknown device";
  const p = platform();
  if (p === "ios") return /iPad/.test(navigator.userAgent) ? "iPad" : "iPhone";
  if (p === "android") {
    const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
    return m?.[1]?.trim() || "Android";
  }
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : /CrOS/.test(ua) ? "ChromeOS" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
