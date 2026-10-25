"use client";
import dynamic from "next/dynamic";

const VeilApp = dynamic(() => import("@veil/ui").then((m) => m.VeilApp), { ssr: false });

export default function Page() {
  return <VeilApp apiBase={process.env.NEXT_PUBLIC_API_URL} />;
}
