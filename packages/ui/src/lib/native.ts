import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNative, platform } from "./platform";

/* ------------------------------ haptics ------------------------------ */

export type HapticKind = "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error";

/** Tactile feedback for every interaction (Capacitor Haptics; vibration API fallback on web). */
export async function haptic(kind: HapticKind = "light") {
  try {
    if (isNative()) {
      const { Haptics, ImpactStyle, NotificationType } = await import("@capacitor/haptics");
      if (kind === "selection") return void (await Haptics.selectionChanged());
      if (kind === "success" || kind === "warning" || kind === "error") {
        const map = { success: NotificationType.Success, warning: NotificationType.Warning, error: NotificationType.Error };
        return void (await Haptics.notification({ type: map[kind] }));
      }
      const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
      return void (await Haptics.impact({ style: map[kind] }));
    }
    const ms = { light: 8, selection: 5, medium: 15, heavy: 28, success: [10, 40, 10], warning: [20, 60, 20], error: [30, 50, 30, 50, 30] }[kind];
    navigator.vibrate?.(ms as number | number[]);
  } catch {
    /* haptics are best-effort */
  }
}

/* ------------------------------ secure screen (custom native plugin) ------------------------------ */

interface SecureScreenPlugin {
  /** Android: FLAG_SECURE on the activity window. iOS: content rendered inside a secure text-field layer + capture overlay. */
  enable(): Promise<void>;
  disable(): Promise<void>;
  isCaptured(): Promise<{ captured: boolean }>;
  addListener(event: "screenshotTaken", fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: "captureChanged", fn: (e: { captured: boolean }) => void): Promise<PluginListenerHandle>;
}

const SecureScreen = registerPlugin<SecureScreenPlugin>("SecureScreen");

export async function enableSecureScreen() {
  if (isNative()) await SecureScreen.enable().catch((e) => console.warn("[secure-screen]", e));
}

export async function onScreenshot(fn: () => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const h = await SecureScreen.addListener("screenshotTaken", fn);
  return () => void h.remove();
}

export async function onCaptureChanged(fn: (captured: boolean) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const h = await SecureScreen.addListener("captureChanged", (e) => fn(e.captured));
  const cur = await SecureScreen.isCaptured().catch(() => ({ captured: false }));
  fn(cur.captured);
  return () => void h.remove();
}

/* ------------------------------ biometrics ------------------------------ */

export async function biometricAvailable(): Promise<{ available: boolean; label: string }> {
  if (!isNative()) return { available: false, label: "" };
  const { BiometricAuth, BiometryType } = await import("@aparajita/capacitor-biometric-auth");
  const r = await BiometricAuth.checkBiometry();
  const label = r.biometryType === BiometryType.faceId ? "Face ID" : r.biometryType === BiometryType.touchId ? "Touch ID" : "Fingerprint";
  return { available: r.isAvailable, label };
}

export async function biometricAuthenticate(reason = "Unlock Veil"): Promise<boolean> {
  if (!isNative()) return false;
  const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
  try {
    await BiometricAuth.authenticate({ reason, cancelTitle: "Use PIN", allowDeviceCredential: false, iosFallbackTitle: "Use PIN", androidTitle: "Unlock Veil", androidSubtitle: reason, androidConfirmationRequired: false });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ app lifecycle ------------------------------ */

export async function onAppStateChange(fn: (active: boolean) => void): Promise<() => void> {
  if (isNative()) {
    const { App } = await import("@capacitor/app");
    const h = await App.addListener("appStateChange", ({ isActive }) => fn(isActive));
    return () => void h.remove();
  }
  const handler = () => fn(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

export async function onDeepLink(fn: (url: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { App } = await import("@capacitor/app");
  const h = await App.addListener("appUrlOpen", (e) => fn(e.url));
  return () => void h.remove();
}

export async function onBackButton(fn: () => boolean): Promise<() => void> {
  if (platform() !== "android") return () => {};
  const { App } = await import("@capacitor/app");
  const h = await App.addListener("backButton", () => {
    if (!fn()) void App.minimizeApp();
  });
  return () => void h.remove();
}

/* ------------------------------ push & local notifications ------------------------------ */

export async function registerPush(onToken: (token: string, platform: "fcm" | "apns" | "web") => void, onTap: (data: Record<string, string>) => void) {
  if (isNative()) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return;
    await PushNotifications.addListener("registration", (t) => onToken(t.value, platform() === "ios" ? "apns" : "fcm"));
    await PushNotifications.addListener("pushNotificationActionPerformed", (a) => onTap((a.notification.data ?? {}) as Record<string, string>));
    if (platform() === "android") {
      await PushNotifications.createChannel({ id: "messages", name: "Messages", importance: 4, visibility: 0, vibration: true });
      await PushNotifications.createChannel({ id: "calls", name: "Calls", importance: 5, visibility: 0, vibration: true, sound: "default" });
    }
    await PushNotifications.register();
    return;
  }
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if ((await Notification.requestPermission()) !== "granted") return;
  const reg = await navigator.serviceWorker.register("/sw.js");
  const raw = atob(vapid.replace(/-/g, "+").replace(/_/g, "/"));
  const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  onToken(JSON.stringify(sub), "web");
}

export async function showLocalNotification(title: string, body: string, data: Record<string, string>) {
  if (isNative()) {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== "granted") return;
    await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2 ** 31), title, body, extra: data, channelId: "messages" }] });
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
    const n = new Notification(title, { body, tag: data.chatId, data });
    n.onclick = () => {
      window.focus();
      window.dispatchEvent(new CustomEvent("veil:open-chat", { detail: data.chatId }));
    };
  }
}

export async function setBadge(count: number) {
  try {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    /* unsupported */
  }
}

/* ------------------------------ device UI ------------------------------ */

export async function setStatusBar(dark: boolean) {
  if (!isNative()) return;
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
  if (platform() === "android") await StatusBar.setBackgroundColor({ color: dark ? "#0F0F1A" : "#FFFFFF" }).catch(() => {});
}

export async function onKeyboard(fn: (height: number) => void): Promise<() => void> {
  if (!isNative()) {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const h = () => fn(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", h);
    return () => vv.removeEventListener("resize", h);
  }
  const { Keyboard } = await import("@capacitor/keyboard");
  const a = await Keyboard.addListener("keyboardWillShow", (i) => fn(i.keyboardHeight));
  const b = await Keyboard.addListener("keyboardWillHide", () => fn(0));
  return () => {
    void a.remove();
    void b.remove();
  };
}

export async function shareFile(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function getCurrentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  if (isNative()) {
    const { Geolocation } = await import("@capacitor/geolocation");
    await Geolocation.requestPermissions().catch(() => {});
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
  }
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message)),
      { enableHighAccuracy: true, timeout: 15000 },
    ),
  );
}

export async function networkIsWifi(): Promise<boolean> {
  if (isNative()) {
    const { Network } = await import("@capacitor/network");
    return (await Network.getStatus()).connectionType === "wifi";
  }
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  if (!c) return true;
  return c.type ? c.type === "wifi" || c.type === "ethernet" : !c.saveData;
}

export async function hideSplash() {
  if (!isNative()) return;
  const { SplashScreen } = await import("@capacitor/splash-screen");
  await SplashScreen.hide().catch(() => {});
}
