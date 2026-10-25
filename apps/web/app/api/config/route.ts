import { fromB64, signingPublicKey, toB64 } from "@veil/crypto";
import { env } from "@/lib/server/env";

/** Public runtime configuration for clients. */
export async function GET() {
  const seed = env.sealedSenderKey;
  return Response.json(
    {
      trustRoot: seed ? toB64(signingPublicKey(fromB64(seed))) : null,
      chatWsUrl: process.env.PUBLIC_CHAT_WS_URL ?? "http://localhost:4001",
      callWsUrl: process.env.PUBLIC_CALL_WS_URL ?? "http://localhost:4005",
      mediaUrl: process.env.PUBLIC_MEDIA_URL ?? "/svc/media",
      linkUrl: process.env.PUBLIC_LINK_URL ?? "/svc/link",
      providers: {
        google: !!process.env.GOOGLE_CLIENT_ID,
        apple: !!process.env.APPLE_CLIENT_ID,
        phone: true,
        email: true,
      },
      gifs: !!(process.env.GIPHY_API_KEY || process.env.TENOR_API_KEY),
      contactDiscovery: !!env.discoveryKey,
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
