import type { NextConfig } from "next";

/** Static export bundled into the native apps; all data comes from the API origin over HTTPS. */
const config: NextConfig = {
  output: "export",
  reactStrictMode: true,
  devIndicators: false,
  images: { unoptimized: true },
  trailingSlash: true,
  transpilePackages: ["@veil/ui", "@veil/shared", "@veil/crypto", "@veil/api-client"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "https://api.veil.app",
  },
};

export default config;
