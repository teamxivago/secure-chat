import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Theme } from "./theme";

const api = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veil.app";
const wsHosts = (process.env.NEXT_PUBLIC_WS_ORIGINS ?? "wss://chat.veil.app wss://calls.veil.app https://chat.veil.app https://calls.veil.app").trim();
const media = process.env.NEXT_PUBLIC_MEDIA_ORIGIN ?? "https://*.r2.cloudflarestorage.com";

export const metadata: Metadata = {
  title: "Veil",
  description: "End-to-end encrypted messenger",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#0F0F1A" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Static bundle: CSP is delivered as a meta tag (no server headers inside the WebView).
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${api}`,
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data: ${api} ${wsHosts} ${media}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join("; ");
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={csp} />
      </head>
      <body>
        <Theme>{children}</Theme>
      </body>
    </html>
  );
}
