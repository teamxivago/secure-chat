import type { NextConfig } from "next";

const svc = {
  media: process.env.MEDIA_WORKER_URL ?? "http://localhost:4002",
  link: process.env.LINK_SCRAPER_URL ?? "http://localhost:4003",
  calls: process.env.CALL_SIGNALING_URL ?? "http://localhost:4005",
};

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ["@veil/ui", "@veil/shared", "@veil/crypto", "@veil/api-client", "@veil/database"],
  serverExternalPackages: ["postgres", "ioredis", "nodemailer"],
  async rewrites() {
    return [
      { source: "/svc/media/:path*", destination: `${svc.media}/:path*` },
      { source: "/svc/link/:path*", destination: `${svc.link}/:path*` },
      { source: "/svc/calls/:path*", destination: `${svc.calls}/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self), display-capture=(self)" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default config;
