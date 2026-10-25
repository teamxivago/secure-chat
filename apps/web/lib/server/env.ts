import "server-only";

function req(name: string, fallbackForDev?: string): string {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV !== "production" && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable ${name}`);
}

export const env = {
  get appUrl() {
    return req("APP_URL", "http://localhost:3000");
  },
  get trustedOrigins() {
    return (process.env.TRUSTED_ORIGINS ?? "capacitor://localhost,https://localhost,http://localhost")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get authSecret() {
    return req("BETTER_AUTH_SECRET", "dev-only-secret-change-me-0123456789abcdef");
  },
  get redisUrl() {
    return req("REDIS_URL", "redis://localhost:6379");
  },
  /** Ed25519 seed (b64) used to sign sealed-sender certificates. Public half ships to clients. */
  get sealedSenderKey() {
    return req("SEALED_SENDER_PRIVATE_KEY", "");
  },
  /** ristretto255 OPRF secret for contact discovery. */
  get discoveryKey() {
    return req("DISCOVERY_OPRF_KEY", "");
  },
  /** Pepper for group sender tags. */
  get senderTagPepper() {
    return req("SENDER_TAG_PEPPER", "dev-pepper");
  },
  smsProvider: process.env.SMS_PROVIDER ?? (process.env.NODE_ENV === "production" ? "twilio" : "console"),
  emailProvider: process.env.EMAIL_PROVIDER ?? (process.env.NODE_ENV === "production" ? "smtp" : "console"),
  /** Dev-only: OTP codes exposed via /api/dev/otp for automated tests. Never enable in production. */
  get devOtpEnabled() {
    return process.env.NODE_ENV !== "production" && process.env.DEV_EXPOSE_OTP === "1";
  },
};
