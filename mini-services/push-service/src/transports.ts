import { connect, type ClientHttp2Session } from "node:http2";
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";
import webpush from "web-push";
import type { App } from "firebase-admin/app";

export interface PushMessage {
  token: string;
  platform: "fcm" | "apns" | "web";
  voip?: boolean;
  title?: string;
  body?: string;
  data: Record<string, string>;
  badge?: number;
  sound?: string;
  priority: "high" | "normal";
  collapseKey?: string;
  ttlSec?: number;
}

export type SendOutcome = "ok" | "invalid" | "error";

/* ------------------------------ FCM ------------------------------ */

let fcmApp: App | null | undefined;
async function fcm() {
  if (fcmApp !== undefined) return fcmApp;
  const creds = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? (process.env.FIREBASE_SERVICE_ACCOUNT_FILE ? readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, "utf8") : null);
  if (!creds) {
    fcmApp = null;
    return null;
  }
  const { initializeApp, cert } = await import("firebase-admin/app");
  fcmApp = initializeApp({ credential: cert(JSON.parse(creds)) }, "veil-push");
  return fcmApp;
}

export async function sendFcm(msgs: PushMessage[]): Promise<SendOutcome[]> {
  const app = await fcm();
  if (!app) return msgs.map(() => "error");
  const { getMessaging } = await import("firebase-admin/messaging");
  const out: SendOutcome[] = [];
  for (let i = 0; i < msgs.length; i += 500) {
    const batch = msgs.slice(i, i + 500);
    const r = await getMessaging(app).sendEach(
      batch.map((m) => ({
        token: m.token,
        data: m.data,
        notification: m.title ? { title: m.title, body: m.body } : undefined,
        android: {
          priority: m.priority,
          ttl: (m.ttlSec ?? 86400) * 1000,
          collapseKey: m.collapseKey,
          notification: m.title ? { channelId: m.data.type === "call" ? "calls" : "messages", sound: m.sound ?? "default", tag: m.collapseKey, notificationCount: m.badge } : undefined,
        },
        apns: { payload: { aps: { badge: m.badge, sound: m.sound ?? "default", "mutable-content": true } } },
      })),
    );
    r.responses.forEach((res) => {
      const code = res.error?.code ?? "";
      out.push(res.success ? "ok" : code.includes("registration-token-not-registered") || code.includes("invalid-argument") ? "invalid" : "error");
    });
  }
  return out;
}

/* ------------------------------ APNs (HTTP/2, token auth) ------------------------------ */

let apnsSession: ClientHttp2Session | null = null;
let apnsJwt: { token: string; at: number } | null = null;

async function apnsToken(): Promise<string | null> {
  const keyPem = process.env.APNS_KEY_P8 ?? (process.env.APNS_KEY_FILE ? readFileSync(process.env.APNS_KEY_FILE, "utf8") : null);
  if (!keyPem || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) return null;
  if (apnsJwt && Date.now() - apnsJwt.at < 50 * 60 * 1000) return apnsJwt.token;
  const key = await importPKCS8(keyPem, "ES256");
  const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: process.env.APNS_KEY_ID }).setIssuer(process.env.APNS_TEAM_ID).setIssuedAt().sign(key);
  apnsJwt = { token, at: Date.now() };
  return token;
}

function apnsConn() {
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed) return apnsSession;
  const host = process.env.APNS_PRODUCTION === "true" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  apnsSession = connect(host);
  apnsSession.on("error", () => (apnsSession = null));
  apnsSession.on("goaway", () => (apnsSession = null));
  return apnsSession;
}

export async function sendApns(m: PushMessage): Promise<SendOutcome> {
  const jwt = await apnsToken();
  const bundle = process.env.APNS_BUNDLE_ID;
  if (!jwt || !bundle) return "error";
  const payload = m.voip
    ? { ...m.data }
    : { aps: { alert: m.title ? { title: m.title, body: m.body } : undefined, badge: m.badge, sound: m.title ? (m.sound ?? "default") : undefined, "mutable-content": 1, "thread-id": m.collapseKey, "content-available": m.title ? undefined : 1 }, ...m.data };
  return new Promise((resolve) => {
    const req = apnsConn().request({
      ":method": "POST",
      ":path": `/3/device/${m.token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": m.voip ? `${bundle}.voip` : bundle,
      "apns-push-type": m.voip ? "voip" : m.title ? "alert" : "background",
      "apns-priority": m.priority === "high" || m.voip ? "10" : "5",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + (m.ttlSec ?? 86400)),
      ...(m.collapseKey ? { "apns-collapse-id": m.collapseKey.slice(0, 64) } : {}),
    });
    let status = 0;
    let body = "";
    req.on("response", (h) => (status = Number(h[":status"])));
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(status === 200 ? "ok" : status === 410 || (status === 400 && body.includes("BadDeviceToken")) ? "invalid" : "error"));
    req.on("error", () => resolve("error"));
    req.setTimeout(10000, () => {
      req.close();
      resolve("error");
    });
    req.end(JSON.stringify(payload));
  });
}

/* ------------------------------ Web Push (desktop PWA) ------------------------------ */

let vapidReady: boolean | undefined;
export async function sendWeb(m: PushMessage): Promise<SendOutcome> {
  if (vapidReady === undefined) {
    vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
    if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@veil.app", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  }
  if (!vapidReady) return "error";
  try {
    await webpush.sendNotification(JSON.parse(m.token), JSON.stringify({ title: m.title, body: m.body, data: m.data, badge: m.badge, tag: m.collapseKey }), {
      TTL: m.ttlSec ?? 86400,
      urgency: m.priority === "high" ? "high" : "normal",
      topic: m.collapseKey?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
    });
    return "ok";
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    return code === 404 || code === 410 ? "invalid" : "error";
  }
}
