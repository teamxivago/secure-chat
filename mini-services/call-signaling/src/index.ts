import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { z } from "zod";
import { getDb, schema, and, eq, inArray, verifySessionToken, type AuthedDevice } from "@veil/database";
import { MAX_GROUP_CALL_PARTICIPANTS } from "@veil/shared";

/**
 * call-signaling: call lifecycle + relay of E2EE signaling.
 * SDP offers/answers and ICE candidates are sealed-sender Signal messages produced by clients;
 * this service only routes them between participant devices. Media flows peer-to-peer over
 * DTLS-SRTP (TURN relays see only encrypted SRTP). Group calls use a full mesh (≤ 32).
 */

const PORT = Number(process.env.PORT ?? 4005);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,capacitor://localhost,https://localhost,http://localhost").split(",");
const RING_TIMEOUT_MS = 45_000;

const pub = new Redis(REDIS_URL);
const sub = pub.duplicate();
const redis = pub.duplicate();

async function iceServers(userId: string) {
  const servers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: (process.env.STUN_URLS ?? "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302").split(",") },
  ];
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    // Cloudflare Calls TURN: short-lived credentials from the TURN key API.
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (r.ok) {
      const { iceServers: ice } = (await r.json()) as { iceServers: { urls: string[]; username: string; credential: string } };
      servers.push(ice);
    }
  } else if (process.env.TURN_SECRET && process.env.TURN_URLS) {
    // coturn REST API (use-auth-secret): username = expiry:user, credential = base64(HMAC-SHA1(secret, username)).
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
    const credential = createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64");
    servers.push({ urls: process.env.TURN_URLS.split(","), username, credential });
  }
  return servers;
}

function tokenFrom(headers: IncomingMessage["headers"], authToken?: string) {
  if (authToken) return authToken;
  const h = headers.authorization;
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7);
  return headers.cookie?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/)?.[1] ?? null;
}

const http = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin && ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {};
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "Access-Control-Allow-Headers": "authorization", "Access-Control-Allow-Methods": "GET" }).end();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.url?.startsWith("/ice")) {
    const a = await verifySessionToken(tokenFrom(req.headers));
    if (!a || a.deviceStatus !== "active") {
      res.writeHead(401, cors).end();
      return;
    }
    const servers = await iceServers(a.userId).catch(() => []);
    res.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ iceServers: servers }));
    return;
  }
  if (!req.url?.startsWith("/socket.io")) res.writeHead(404).end();
});

const io = new Server(http, { cors: { origin: ORIGINS, credentials: true }, maxHttpBufferSize: 512 * 1024 });
io.adapter(createAdapter(pub, sub));

const rooms = { user: (id: string) => `user:${id}`, device: (id: string) => `device:${id}`, call: (id: string) => `call:${id}` };
const ringTimers = new Map<string, NodeJS.Timeout>();

io.use(async (socket, next) => {
  const a = await verifySessionToken(tokenFrom(socket.handshake.headers, (socket.handshake.auth as { token?: string })?.token)).catch(() => null);
  if (!a || !a.deviceId || a.deviceStatus !== "active") return next(new Error("unauthorized"));
  Object.assign(socket.data, a);
  next();
});

const ack = <T>(cb: unknown): ((r: T) => void) => (typeof cb === "function" ? (cb as (r: T) => void) : () => {});
const push = (job: Record<string, unknown>) => redis.lpush("push:queue", JSON.stringify(job));

async function loadCall(callId: string) {
  const [c] = await getDb().select().from(schema.call).where(eq(schema.call.id, callId));
  return c ?? null;
}

async function participants(callId: string) {
  return getDb().select().from(schema.callParticipant).where(eq(schema.callParticipant.callId, callId));
}

async function setParticipant(callId: string, userId: string, set: Partial<typeof schema.callParticipant.$inferInsert>) {
  await getDb().update(schema.callParticipant).set(set).where(and(eq(schema.callParticipant.callId, callId), eq(schema.callParticipant.userId, userId)));
}

async function endCall(callId: string, reason: "completed" | "missed" | "declined" | "cancelled" | "busy", by?: string) {
  const call = await loadCall(callId);
  if (!call || call.status === "ended") return;
  clearTimeout(ringTimers.get(callId));
  ringTimers.delete(callId);
  const now = new Date();
  await getDb().update(schema.call).set({ status: "ended", endedAt: now }).where(eq(schema.call.id, callId));
  const parts = await participants(callId);
  for (const p of parts) {
    const state = p.state === "joined" ? "left" : p.state === "invited" || p.state === "ringing" ? (reason === "missed" ? "missed" : p.state === "invited" ? "missed" : p.state) : p.state;
    await setParticipant(callId, p.userId, { state, leftAt: p.leftAt ?? now });
    await redis.del(`incall:${p.userId}`);
  }
  const duration = call.connectedAt ? Math.round((now.getTime() - call.connectedAt.getTime()) / 1000) : 0;
  const payload = { callId, reason, by, duration };
  for (const p of parts) io.to(rooms.user(p.userId)).emit("call:ended", payload);
  const unanswered = parts.filter((p) => p.state === "invited" || p.state === "ringing").map((p) => p.userId);
  if (unanswered.length) await push({ kind: "call_cancel", userIds: unanswered, callId });
}

type CSocket = Socket & { data: AuthedDevice & { userId: string; deviceId: string } };

io.on("connection", (raw) => {
  const socket = raw as CSocket;
  const { userId, deviceId } = socket.data;
  // Every handler is guarded: a failure answers the ack with an error instead of crashing the process.
  const on = (event: string, fn: (...args: any[]) => unknown) =>
    socket.on(event, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        console.error(`[${event}]`, e);
        const cb = args[args.length - 1];
        if (typeof cb === "function") cb({ ok: false, error: "internal error" });
      }
    });
  socket.join([rooms.user(userId), rooms.device(deviceId)]);

  on("call:start", async (payload: unknown, cb: unknown) => {
    const reply = ack<{ ok: boolean; error?: string; iceServers?: unknown }>(cb);
    const p = z
      .object({ callId: z.string().uuid(), peerUserId: z.string().max(64).optional(), chatId: z.string().max(64).optional(), video: z.boolean() })
      .refine((v) => !!v.peerUserId !== !!v.chatId)
      .safeParse(payload);
    if (!p.success) return reply({ ok: false, error: "invalid payload" });
    const { callId, peerUserId, chatId, video } = p.data;
    const db = getDb();
    const [me] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId));
    let invitees: string[] = [];
    let title = me?.name ?? "Veil";
    if (peerUserId) {
      if (peerUserId === userId) return reply({ ok: false, error: "cannot call yourself" });
      const [blocked] = await db
        .select()
        .from(schema.blockedUser)
        .where(and(eq(schema.blockedUser.userId, peerUserId), eq(schema.blockedUser.blockedUserId, userId)));
      if (blocked) return reply({ ok: false, error: "unavailable" });
      if (await redis.exists(`incall:${peerUserId}`)) return reply({ ok: false, error: "busy" });
      invitees = [peerUserId];
    } else {
      const [m] = await db.select().from(schema.chatMember).where(and(eq(schema.chatMember.chatId, chatId!), eq(schema.chatMember.userId, userId)));
      const [chat] = await db.select().from(schema.chat).where(eq(schema.chat.id, chatId!));
      if (!m || !chat || chat.type !== "group") return reply({ ok: false, error: "not a group member" });
      title = chat.title;
      // Ring everyone in small groups; large groups just see the active call banner.
      if (chat.memberCount <= 100) {
        const members = await db.select({ u: schema.chatMember.userId }).from(schema.chatMember).where(eq(schema.chatMember.chatId, chatId!));
        invitees = members.map((x) => x.u).filter((u) => u !== userId);
      }
    }
    await db.insert(schema.call).values({ id: callId, chatId: chatId ?? null, initiatorId: userId, video, isGroup: !!chatId, status: "ringing" });
    await db.insert(schema.callParticipant).values([
      { callId, userId, deviceId, state: "joined", joinedAt: new Date() },
      ...invitees.map((u) => ({ callId, userId: u, state: "invited" })),
    ]);
    await redis.set(`incall:${userId}`, callId, "EX", 6 * 3600);
    socket.join(rooms.call(callId));
    const incoming = { callId, fromUserId: userId, fromDeviceId: deviceId, video, group: !!chatId, chatId: chatId ?? null, title };
    for (const u of invitees) io.to(rooms.user(u)).emit("call:incoming", incoming);
    if (chatId) io.to(`chat:${chatId}`).emit("call:groupActive", { callId, chatId, video });
    if (invitees.length) await push({ kind: "call", userIds: invitees, callId, video, title, body: video ? "Incoming video call" : "Incoming voice call", data: { fromUserId: userId, chatId: chatId ?? "" } });
    if (!chatId) {
      ringTimers.set(
        callId,
        setTimeout(() => void endCall(callId, "missed").catch(console.error), RING_TIMEOUT_MS),
      );
    }
    reply({ ok: true, iceServers: await iceServers(userId).catch(() => []) });
  });

  on("call:ringing", async (payload: unknown) => {
    const callId = z.string().uuid().safeParse((payload as { callId?: string })?.callId);
    if (!callId.success) return;
    const call = await loadCall(callId.data);
    if (!call || call.status === "ended") return;
    await setParticipant(callId.data, userId, { state: "ringing" });
    io.to(rooms.user(call.initiatorId)).emit("call:ringing", { callId: callId.data, userId });
  });

  on("call:accept", async (payload: unknown, cb: unknown) => {
    const reply = ack<{ ok: boolean; error?: string; participants?: { userId: string; deviceId: string | null }[]; iceServers?: unknown }>(cb);
    const callId = z.string().uuid().safeParse((payload as { callId?: string })?.callId);
    if (!callId.success) return reply({ ok: false, error: "invalid" });
    const call = await loadCall(callId.data);
    if (!call || call.status === "ended") return reply({ ok: false, error: "call ended" });
    const parts = await participants(call.id);
    const mine = parts.find((p) => p.userId === userId);
    if (!mine && !call.isGroup) return reply({ ok: false, error: "not invited" });
    const joined = parts.filter((p) => p.state === "joined");
    if (joined.length >= MAX_GROUP_CALL_PARTICIPANTS) return reply({ ok: false, error: "call is full" });
    if (!mine) {
      const [m] = await getDb().select().from(schema.chatMember).where(and(eq(schema.chatMember.chatId, call.chatId!), eq(schema.chatMember.userId, userId)));
      if (!m) return reply({ ok: false, error: "not a member" });
      await getDb().insert(schema.callParticipant).values({ callId: call.id, userId, deviceId, state: "joined", joinedAt: new Date() });
    } else {
      await setParticipant(call.id, userId, { state: "joined", deviceId, joinedAt: new Date() });
    }
    clearTimeout(ringTimers.get(call.id));
    ringTimers.delete(call.id);
    if (call.status === "ringing") await getDb().update(schema.call).set({ status: "active", connectedAt: new Date() }).where(eq(schema.call.id, call.id));
    await redis.set(`incall:${userId}`, call.id, "EX", 6 * 3600);
    socket.join(rooms.call(call.id));
    // Stop ringing on this user's other devices.
    socket.to(rooms.user(userId)).emit("call:answeredElsewhere", { callId: call.id });
    io.to(rooms.call(call.id)).emit("call:participant", { callId: call.id, userId, deviceId, state: "joined" });
    reply({
      ok: true,
      participants: joined.filter((p) => p.userId !== userId).map((p) => ({ userId: p.userId, deviceId: p.deviceId })),
      iceServers: await iceServers(userId).catch(() => []),
    });
  });

  on("call:decline", async (payload: unknown) => {
    const callId = z.string().uuid().safeParse((payload as { callId?: string })?.callId);
    if (!callId.success) return;
    const call = await loadCall(callId.data);
    if (!call || call.status === "ended") return;
    await setParticipant(call.id, userId, { state: "declined", leftAt: new Date() });
    socket.to(rooms.user(userId)).emit("call:answeredElsewhere", { callId: call.id });
    if (!call.isGroup) await endCall(call.id, (payload as { busy?: boolean })?.busy ? "busy" : "declined", userId);
  });

  async function leave(callId: string) {
    const call = await loadCall(callId);
    if (!call || call.status === "ended") return;
    socket.leave(rooms.call(callId));
    await redis.del(`incall:${userId}`);
    if (!call.isGroup) return endCall(callId, call.status === "ringing" ? "cancelled" : "completed", userId);
    await setParticipant(callId, userId, { state: "left", leftAt: new Date() });
    io.to(rooms.call(callId)).emit("call:participant", { callId, userId, deviceId, state: "left" });
    const remaining = (await participants(callId)).filter((p) => p.state === "joined");
    if (!remaining.length) await endCall(callId, "completed", userId);
  }

  on("call:hangup", async (payload: unknown) => {
    const callId = z.string().uuid().safeParse((payload as { callId?: string })?.callId);
    if (callId.success) await leave(callId.data);
  });

  /** Relay an encrypted signaling blob to one participant device. */
  on("call:signal", async (payload: unknown) => {
    const p = z.object({ callId: z.string().uuid(), toUserId: z.string().max(64), toDeviceId: z.string().max(64), payload: z.string().max(200_000) }).safeParse(payload);
    if (!p.success || !socket.rooms.has(rooms.call(p.data.callId))) {
      // The callee isn't in the room until it accepts, but the caller may still need to send the offer.
      const call = p.success ? await loadCall(p.data.callId) : null;
      if (!p.success || !call || call.status === "ended") return;
      const parts = await participants(call.id);
      if (!parts.some((x) => x.userId === userId) || !parts.some((x) => x.userId === p.data.toUserId)) return;
    }
    io.to(rooms.device(p.data.toDeviceId)).emit("call:signal", { callId: p.data.callId, fromUserId: userId, fromDeviceId: deviceId, payload: p.data.payload });
  });

  on("call:state", async (payload: unknown) => {
    const p = z.object({ callId: z.string().uuid(), muted: z.boolean().optional(), video: z.boolean().optional(), hold: z.boolean().optional(), screen: z.boolean().optional() }).safeParse(payload);
    if (!p.success || !socket.rooms.has(rooms.call(p.data.callId))) return;
    socket.to(rooms.call(p.data.callId)).emit("call:state", { ...p.data, userId, deviceId });
  });

  on("call:active", async (payload: unknown, cb: unknown) => {
    const chatIds = z.array(z.string().max(64)).max(500).safeParse(payload);
    if (!chatIds.success || !chatIds.data.length) return ack<unknown>(cb)({ calls: [] });
    const rows = await getDb()
      .select()
      .from(schema.call)
      .where(and(inArray(schema.call.chatId, chatIds.data), inArray(schema.call.status, ["ringing", "active"])));
    ack<unknown>(cb)({ calls: rows.map((c) => ({ callId: c.id, chatId: c.chatId, video: c.video })) });
  });

  on("disconnecting", async () => {
    // Rooms are still populated during "disconnecting": leave any call this socket was in.
    for (const r of [...socket.rooms]) if (r.startsWith("call:")) await leave(r.slice(5)).catch(() => {});
  });
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

http.listen(PORT, () => console.log(`[call-signaling] listening on :${PORT}`));
