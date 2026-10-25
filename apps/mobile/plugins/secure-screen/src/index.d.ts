import type { PluginListenerHandle } from "@capacitor/core";
export interface SecureScreenPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
  isCaptured(): Promise<{ captured: boolean }>;
  addListener(event: "screenshotTaken", fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: "captureChanged", fn: (e: { captured: boolean }) => void): Promise<PluginListenerHandle>;
}
export declare const SecureScreen: SecureScreenPlugin;
