import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, phoneNumber, username } from "better-auth/plugins";
import { getDb, schema, eq } from "@veil/database";
import { discoveryToken, normalizePhone } from "@veil/crypto";
import { USERNAME_RE } from "@veil/shared";
import { env } from "./env";
import { redis } from "./redis";
import { sendEmailOtp, sendSmsOtp, verifySmsOtp } from "./otp-delivery";

function createAuth() {
  const socialProviders: Parameters<typeof betterAuth>[0]["socialProviders"] = {};
  if (process.env.GOOGLE_CLIENT_ID) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    };
  }
  if (process.env.APPLE_CLIENT_ID) {
    socialProviders.apple = {
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET ?? "",
      appBundleIdentifier: process.env.APPLE_APP_BUNDLE_IDENTIFIER,
    };
  }

  return betterAuth({
    baseURL: env.appUrl,
    secret: env.authSecret,
    trustedOrigins: [env.appUrl, ...env.trustedOrigins, ...(process.env.APPLE_CLIENT_ID ? ["https://appleid.apple.com"] : [])],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    secondaryStorage: {
      get: async (k) => (await redis().get(`ba:${k}`)) ?? null,
      set: async (k, v, ttl) => {
        if (ttl) await redis().set(`ba:${k}`, v, "EX", ttl);
        else await redis().set(`ba:${k}`, v);
      },
      delete: async (k) => {
        await redis().del(`ba:${k}`);
      },
      getAndDelete: async (k) => (await redis().getdel(`ba:${k}`)) ?? null,
      increment: async (k, ttl) => {
        const [[, n]] = (await redis().multi().incr(`ba:${k}`).expire(`ba:${k}`, ttl, "NX").exec()) as [[unknown, number]];
        return n;
      },
    },
    session: {
      // Sessions are stored in Postgres (other services validate tokens against it).
      storeSessionInDatabase: true,
      expiresIn: 60 * 60 * 24 * 365,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
      window: 60,
      max: 100,
      customRules: {
        // OTP sends per IP per hour (raise only for automated test environments).
        "/phone-number/send-otp": { window: 3600, max: Number(process.env.OTP_SENDS_PER_HOUR ?? 5) },
        "/email-otp/send-verification-otp": { window: 3600, max: Number(process.env.OTP_SENDS_PER_HOUR ?? 5) },
        "/sign-in/email-otp": { window: 300, max: Number(process.env.OTP_VERIFIES_PER_5MIN ?? 10) },
        "/phone-number/verify": { window: 300, max: Number(process.env.OTP_VERIFIES_PER_5MIN ?? 10) },
        "/sign-in/social": { window: 60, max: 10 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
      defaultCookieAttributes: { sameSite: "lax", secure: env.appUrl.startsWith("https") },
    },
    socialProviders,
    account: { accountLinking: { enabled: true, trustedProviders: ["google", "apple", "email-otp", "phone-number"] } },
    user: {
      additionalFields: {
        lastName: { type: "string", required: false, input: false },
        onboarded: { type: "boolean", required: false, input: false, defaultValue: false },
      },
    },
    plugins: [
      bearer(),
      username({
        minUsernameLength: 5,
        maxUsernameLength: 32,
        usernameValidator: (u) => USERNAME_RE.test(u),
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp, type }) {
          await sendEmailOtp(email, otp, type);
        },
      }),
      phoneNumber({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 5,
        phoneNumberValidator: (p) => normalizePhone(p) === p,
        async sendOTP({ phoneNumber: phone, code }) {
          await sendSmsOtp(phone, code);
        },
        ...(env.smsProvider === "twilio-verify"
          ? { verifyOTP: async ({ phoneNumber: phone, code }: { phoneNumber: string; code: string }) => verifySmsOtp(phone, code) }
          : {}),
        signUpOnVerification: {
          // Phone-only accounts get a non-routable placeholder address (never emailed).
          getTempEmail: (phone) => `${phone.replace(/\D/g, "")}@phone.veil.invalid`,
          getTempName: () => "",
        },
        async callbackOnVerification({ phoneNumber: phone, user }) {
          const key = env.discoveryKey;
          if (!key) return;
          await getDb()
            .update(schema.user)
            .set({ discoveryToken: discoveryToken(key, phone) })
            .where(eq(schema.user.id, user.id));
        },
      }),
    ],
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __veilAuth: ReturnType<typeof createAuth> | undefined;
}

export function auth() {
  globalThis.__veilAuth ??= createAuth();
  return globalThis.__veilAuth;
}
