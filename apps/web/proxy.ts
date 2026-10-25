import { NextResponse, type NextRequest } from "next/server";

/**
 * Strict nonce-based Content Security Policy for pages, and CORS for the native (Capacitor)
 * app origins on API routes.
 */
const NATIVE_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost", ...(process.env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin");

  if (pathname.startsWith("/api/") || pathname.startsWith("/svc/")) {
    const allowed = origin && NATIVE_ORIGINS.has(origin);
    if (req.method === "OPTIONS") {
      return new NextResponse(null, {
        status: allowed ? 204 : 403,
        headers: allowed
          ? {
              "Access-Control-Allow-Origin": origin!,
              "Access-Control-Allow-Credentials": "true",
              "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "authorization,content-type,x-upload-token",
              "Access-Control-Max-Age": "600",
              Vary: "Origin",
            }
          : {},
      });
    }
    const res = NextResponse.next();
    if (allowed) {
      res.headers.set("Access-Control-Allow-Origin", origin!);
      res.headers.set("Access-Control-Allow-Credentials", "true");
      res.headers.set("Access-Control-Expose-Headers", "set-auth-token");
      res.headers.set("Vary", "Origin");
    }
    return res;
  }

  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const ws = [process.env.PUBLIC_CHAT_WS_URL ?? "http://localhost:4001", process.env.PUBLIC_CALL_WS_URL ?? "http://localhost:4005"];
  const wsOrigins = ws.flatMap((u) => [u, u.replace(/^http/, "ws")]).join(" ");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data: ${wsOrigins} ${process.env.MEDIA_PUBLIC_ORIGIN ?? (dev ? "http://localhost:4002" : "")} https://*.r2.cloudflarestorage.com https://accounts.google.com https://appleid.apple.com`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com https://appleid.apple.com",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js).*)" }],
};
