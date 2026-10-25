import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Theme } from "./theme";

export const metadata: Metadata = {
  title: "Veil — Private Messenger",
  description: "End-to-end encrypted messaging, calls and file sharing.",
  manifest: "/manifest.webmanifest",
  applicationName: "Veil",
  appleWebApp: { capable: true, title: "Veil", statusBarStyle: "black-translucent" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0F0F1A" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce (set in proxy.ts) for the theme bootstrap script.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Theme nonce={nonce}>{children}</Theme>
      </body>
    </html>
  );
}
