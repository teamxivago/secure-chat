"use client";
import dynamic from "next/dynamic";

// The app is fully client-side (keys live in IndexedDB); skip SSR entirely.
const VeilApp = dynamic(() => import("@veil/ui").then((m) => m.VeilApp), { ssr: false });

export default function ClientApp() {
  return <VeilApp />;
}
