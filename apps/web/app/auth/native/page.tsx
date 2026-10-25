"use client";
import { useEffect, useState } from "react";

/**
 * Native OAuth handoff: the Capacitor app opens this page in the system browser; we start the
 * provider flow here and land on /auth/native/done, which deep-links the session token back.
 */
export default function NativeAuthStart() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const provider = new URLSearchParams(window.location.search).get("provider");
    if (provider !== "google" && provider !== "apple") return setError("Unknown provider");
    fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/auth/native/done" }),
    })
      .then((r) => r.json())
      .then((d) => (d.url ? (window.location.href = d.url) : setError("Sign-in unavailable")))
      .catch(() => setError("Sign-in unavailable"));
  }, []);
  return <p style={{ fontFamily: "system-ui", padding: 32, textAlign: "center" }}>{error ?? "Redirecting…"}</p>;
}
