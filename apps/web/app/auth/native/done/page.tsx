"use client";
import { useEffect, useState } from "react";

export default function NativeAuthDone() {
  const [msg, setMsg] = useState("Returning to Veil…");
  useEffect(() => {
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => {
        const token = d?.session?.token;
        if (!token) return setMsg("Sign-in failed. Close this window and try again.");
        window.location.href = `veil://auth?token=${encodeURIComponent(token)}`;
        setMsg("You can close this window.");
      })
      .catch(() => setMsg("Sign-in failed."));
  }, []);
  return <p style={{ fontFamily: "system-ui", padding: 32, textAlign: "center" }}>{msg}</p>;
}
