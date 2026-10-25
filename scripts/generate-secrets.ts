/**
 * Generates fresh server secrets. Usage: pnpm tsx scripts/generate-secrets.ts >> .env
 * Rotate SEALED_SENDER_PRIVATE_KEY only with a client release carrying the new trust root.
 */
import { randomBytes } from "node:crypto";
import { generateDiscoveryKey, generateSigningKeyPair, toB64 } from "@veil/crypto";

const sealed = generateSigningKeyPair();
const lines = {
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  SEALED_SENDER_PRIVATE_KEY: toB64(sealed.privateKey),
  NEXT_PUBLIC_SEALED_SENDER_TRUST_ROOT: toB64(sealed.publicKey),
  DISCOVERY_OPRF_KEY: generateDiscoveryKey(),
  SENDER_TAG_PEPPER: randomBytes(32).toString("base64url"),
  MEDIA_URL_SECRET: randomBytes(32).toString("base64url"),
  LINK_PROXY_SECRET: randomBytes(32).toString("base64url"),
};
for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
