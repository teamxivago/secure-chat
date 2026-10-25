import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "app.veil.messenger",
  appName: "Veil",
  webDir: "out",
  backgroundColor: "#0F0F1A",
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
    // Live-reload during development: CAP_SERVER_URL=http://<lan-ip>:3100
    ...(process.env.CAP_SERVER_URL ? { url: process.env.CAP_SERVER_URL, cleartext: true } : {}),
  },
  android: { allowMixedContent: false, captureInput: true, webContentsDebuggingEnabled: process.env.NODE_ENV !== "production" },
  ios: { contentInset: "never", scrollEnabled: false, limitsNavigationsToAppBoundDomains: false },
  plugins: {
    SplashScreen: { launchShowDuration: 1500, launchAutoHide: false, backgroundColor: "#0F0F1A", showSpinner: false, androidScaleType: "CENTER_CROP" },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
    LocalNotifications: { smallIcon: "ic_stat_veil", iconColor: "#00A88E" },
    Keyboard: { resize: KeyboardResize.Native, resizeOnFullScreen: true },
    StatusBar: { overlaysWebView: true, style: "DARK" },
  },
};

export default config;
