/**
 * Backend smoke test: two users sign up via email OTP, register devices with real Signal keys,
 * then exchange a sealed-sender Double Ratchet message through chat-ws. Also verifies the server
 * stored only ciphertext. Requires DEV_EXPOSE_OTP=1 on the web server.
 */
import { io } from "socket.io-client";
import {
  MemoryProtocolStore, generateIdentityKeyPair, generateRegistrationId, generateSignedPreKey, generateOneTimePreKeys,
  toB64, fromB64, utf8, fromUtf8, processPreKeyBundle, encryptMessage, decryptMessage, sealedSenderEncrypt, sealedSenderDecrypt,
} from "@veil/crypto";
import postgres from "postgres";

const API = process.env.API ?? "http://localhost:3000";
const WS = process.env.WS ?? "http://localhost:4001";

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), Origin: API },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text}`);
  return { data: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signUp(email: string) {
  await call("/api/auth/email-otp/send-verification-otp", { method: "POST", body: JSON.stringify({ email, type: "sign-in" }) });
  const { data: otp } = await call(`/api/dev/otp?to=${encodeURIComponent(email)}`);
  const { data, headers } = await call("/api/auth/sign-in/email-otp", { method: "POST", body: JSON.stringify({ email, otp: otp.code }) });
  const token = headers.get("set-auth-token") ?? data.token;
  const identity = generateIdentityKeyPair();
  const store = new MemoryProtocolStore(identity, generateRegistrationId());
  const spk = generateSignedPreKey(identity, 1);
  store.signedPreKeys.set(1, spk);
  const otpks = generateOneTimePreKeys(1, 10);
  otpks.forEach((k) => store.oneTimePreKeys.set(k.keyId, k));
  const { data: reg } = await call("/api/devices", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "smoke", platform: "web", registrationId: store.registrationId, identityKey: toB64(identity.publicKey),
      signedPreKey: { keyId: 1, publicKey: toB64(spk.keyPair.publicKey), signature: toB64(spk.signature) },
      oneTimePreKeys: otpks.map((k) => ({ keyId: k.keyId, publicKey: toB64(k.keyPair.publicKey) })),
    }),
  });
  return { token, userId: data.user.id as string, deviceId: reg.deviceId as string, status: reg.status, store, identity };
}

const stamp = Date.now();
const a = await signUp(`alice${stamp}@example.com`);
const b = await signUp(`bob${stamp}@example.com`);
console.log("registered", a.status, b.status);
const { data: cfg } = await call("/api/config");
const trustRoot = fromB64(cfg.trustRoot);

const sa = io(WS, { auth: { token: a.token }, transports: ["websocket"] });
const sb = io(WS, { auth: { token: b.token }, transports: ["websocket"] });
await Promise.all([new Promise((r) => sa.on("connect", r)), new Promise((r) => sb.on("connect", r))]);

const received = new Promise<string>((resolve) => {
  sb.on("envelope", async (env: { id: string; content: string; type: number; sealed: boolean; senderUserId: string | null }) => {
    if (env.senderUserId !== null) throw new Error("sealed envelope leaked sender");
    const un = sealedSenderDecrypt(b.identity, trustRoot, fromB64(env.content));
    const { plaintext } = await decryptMessage(b.store, `${un.senderUserId}.${un.senderDeviceId}`, un.type, un.body);
    sb.emit("ack", [env.id]);
    resolve(fromUtf8(plaintext));
  });
});

const { data: bundles } = await call(`/api/keys/${b.userId}`, { token: a.token });
const { data: cert } = await call("/api/keys/certificate", { token: a.token });
const out = [];
for (const bundle of bundles.bundles) {
  const addr = `${b.userId}.${bundle.deviceId}`;
  await processPreKeyBundle(a.store, addr, bundle);
  const ct = await encryptMessage(a.store, addr, utf8("hello from alice, secretly"));
  const sealed = sealedSenderEncrypt(a.identity, cert.certificate, fromB64(bundle.identityKey), ct.type, ct.body);
  out.push({ userId: b.userId, deviceId: bundle.deviceId, registrationId: bundle.registrationId, type: 6, content: toB64(sealed) });
}
const t0 = performance.now();
const res = await new Promise((r) => sa.emit("send", { messages: out, sealed: true }, r));
console.log("send result", res);
const text = await received;
console.log(`bob decrypted: "${text}" in ${(performance.now() - t0).toFixed(1)}ms`);

// Server-side storage check: nothing readable, no sender recorded.
const sql = postgres(process.env.DATABASE_URL!);
await new Promise((r) => setTimeout(r, 300));
const leftovers = await sql`select count(*)::int as n from envelope where recipient_device_id = ${b.deviceId}`;
const plaintextHits = await sql`select count(*)::int as n from envelope where position(${Buffer.from("hello from alice")} in content) > 0`;
console.log("envelopes after ack:", leftovers[0].n, "| plaintext matches in DB:", plaintextHits[0].n);
await sql.end();
sa.close();
sb.close();
if (text !== "hello from alice, secretly" || plaintextHits[0].n !== 0) process.exit(1);
console.log("SMOKE OK");
process.exit(0);
