import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { z } from "zod";
import { getDb, getSql, schema, verifySessionToken, and, eq, inArray, type AuthedDevice } from "@veil/database";
import { ADMIN_RIGHTS, DEFAULT_MEMBER_PERMISSIONS, EDIT_WINDOW_MS, type SendResult } from "@veil/shared";

/**
 * chat-ws: real-time relay.
 *  - 1:1: per-device Double Ratchet envelopes, usually sealed-sender (no sender stored).
 *  - groups/channels: one Sender Key ciphertext per message, sequenced and fanned out.
 * The service never sees plaintext; it enforces membership, roles, slow mode and device lists.
 */

const PORT = Number(process.env.PORT ?? 4001);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PEPPER = process.env.SENDER_TAG_PEPPER ?? "dev-pepper";
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000,capacitor://localhost,https://localhost,http://localhost").split(",");
const ONLINE_TTL = 75;

const pub = new Redis(REDIS_URL);
const sub = pub.duplicate();
const redis = pub.duplicate();

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(http, {
  cors: { origin: ORIGINS, credentials: true },
  maxHttpBufferSize: 4 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});
io.adapter(createAdapter(pub, sub));

type VSocket = Socket & { data: AuthedDevice & { presenceSubs?: Set<string> } };

const rooms = {
  user: (id: string) => `user:${id}`,
  device: (id: string) => `device:${id}`,
  chat: (id: string) => `chat:${id}`,
  presence: (id: string) => `presence:${id}`,
};

const senderTag = (userId: string, chatId: string) => createHmac("sha256", PEPPER).update(`${userId}:${chatId}`).digest("base64url");

function tokenFromSocket(s: Socket): string | null {
  const t = (s.handshake.auth as { token?: string })?.token;
  if (t) return t;
  const cookie = s.handshake.headers.cookie ?? "";
  const m = cookie.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return m ? m[1] : null;
}

io.use(async (socket, next) => {
  try {
    const a = await verifySessionToken(tokenFromSocket(socket));
    if (!a || !a.deviceId) return next(new Error("unauthorized"));
    Object.assign(socket.data, a);
    next();
  } catch (e) {
    next(e as Error);
  }
});

/* ------------------------------ presence ------------------------------ */

async function setOnline(userId: string, deviceId: string, online: boolean) {
  const db = getDb();
  if (online) {
    const wasOnline = await redis.exists(`online:user:${userId}`);
    await redis.multi().set(`online:user:${userId}`, "1", "EX", ONLINE_TTL).set(`online:device:${deviceId}`, "1", "EX", ONLINE_TTL).exec();
    if (!wasOnline) await broadcastPresence(userId, true, null);
  } else {
    await redis.del(`online:device:${deviceId}`);
    const remaining = await io.in(rooms.user(userId)).fetchSockets();
    const now = new Date();
    await db.update(schema.device).set({ lastSeenAt: now }).where(eq(schema.device.id, deviceId));
    if (!remaining.length) {
      await redis.del(`online:user:${userId}`);
      await db.update(schema.user).set({ lastSeenAt: now }).where(eq(schema.user.id, userId));
      await broadcastPresence(userId, false, now.getTime());
    }
  }
}

/** Sends presence to subscribers, honoring the user's last-seen privacy setting per viewer. */
async function broadcastPresence(userId: string, online: boolean, lastSeenAt: number | null) {
  const subs = await io.in(rooms.presence(userId)).fetchSockets();
  if (!subs.length) return;
  const [u] = await getDb().select({ v: schema.user.lastSeenVisibility }).from(schema.user).where(eq(schema.user.id, userId));
  if (!u) return;
  let theirContacts = new Set<string>();
  if (u.v === "contacts") {
    const viewers = [...new Set(subs.map((s) => (s.data as AuthedDevice).userId))];
    const rows = await getDb()
      .select({ c: schema.contact.contactUserId })
      .from(schema.contact)
      .where(and(eq(schema.contact.ownerId, userId), inArray(schema.contact.contactUserId, viewers)));
    theirContacts = new Set(rows.map((r) => r.c));
  }
  for (const s of subs) {
    const viewer = (s.data as AuthedDevice).userId;
    const visible = viewer === userId || u.v === "everyone" || (u.v === "contacts" && theirContacts.has(viewer));
    s.emit("presence", visible ? { userId, online, lastSeenAt } : { userId, online: false, lastSeenAt: null, approx: "recently" });
  }
}

/* ------------------------------ helpers ------------------------------ */

const envelopeSchema = z.object({
  userId: z.string().max(64),
  deviceId: z.string().max(64),
  registrationId: z.number().int(),
  type: z.number().int(),
  content: z.string().max(3_000_000),
});

const sendSchema = z.object({
  messages: z.array(envelopeSchema).min(1).max(2000),
  sealed: z.boolean().default(true),
  ephemeral: z.boolean().default(false),
  push: z.enum(["message", "reaction", "silent", "call"]).default("message"),
});

async function activeDevices(userIds: string[]) {
  if (!userIds.length) return [];
  return getDb()
    .select({ id: schema.device.id, userId: schema.device.userId, registrationId: schema.device.registrationId })
    .from(schema.device)
    .where(and(inArray(schema.device.userId, userIds), eq(schema.device.status, "active")));
}

async function blockedBy(recipients: string[], senderId: string): Promise<Set<string>> {
  if (!recipients.length) return new Set();
  const rows = await getDb()
    .select({ u: schema.blockedUser.userId })
    .from(schema.blockedUser)
    .where(and(inArray(schema.blockedUser.userId, recipients), eq(schema.blockedUser.blockedUserId, senderId)));
  return new Set(rows.map((r) => r.u));
}

const ack = <T>(cb: unknown): ((r: T) => void) => (typeof cb === "function" ? (cb as (r: T) => void) : () => {});

async function enqueuePush(job: Record<string, unknown>) {
  await redis.lpush("push:queue", JSON.stringify(job));
}

function rights(m: typeof schema.chatMember.$inferSelect | undefined): Record<string, boolean> {
  if (!m) return {};
  if (m.role === "owner") return Object.fromEntries(ADMIN_RIGHTS.map((r) => [r, true]));
  if (m.role === "admin") return m.rights;
  return {};
}

/* ------------------------------ connection ------------------------------ */

io.on("connection", async (raw) => {
  const socket = raw as VSocket;
  const { userId, deviceId } = socket.data as { userId: string; deviceId: string };
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
  const isActive = () => socket.data.deviceStatus === "active";

  async function joinChats() {
    const chats = await getDb().select({ id: schema.chatMember.chatId }).from(schema.chatMember).where(eq(schema.chatMember.userId, userId));
    socket.join(chats.map((c) => rooms.chat(c.id)));
  }

  on("device:refresh", async (_: unknown, cb: unknown) => {
    const a = await verifySessionToken(tokenFromSocket(socket));
    if (!a || a.deviceId !== deviceId) {
      socket.disconnect(true);
      return;
    }
    socket.data.deviceStatus = a.deviceStatus;
    if (isActive()) await joinChats();
    ack<{ status: string | null }>(cb)({ status: a.deviceStatus });
  });

  on("presence:ping", async () => {
    await redis.multi().expire(`online:user:${userId}`, ONLINE_TTL).expire(`online:device:${deviceId}`, ONLINE_TTL).exec();
  });

  on("presence:away", async () => {
    await setOnline(userId, deviceId, false);
  });
  on("presence:back", async () => {
    await setOnline(userId, deviceId, true);
  });

  on("presence:sub", async (payload: unknown) => {
    const ids = z.array(z.string().max(64)).max(500).safeParse(payload);
    if (!ids.success) return;
    const prev = socket.data.presenceSubs ?? new Set<string>();
    for (const p of prev) if (!ids.data.includes(p)) socket.leave(rooms.presence(p));
    socket.data.presenceSubs = new Set(ids.data);
    socket.join(ids.data.map(rooms.presence));
  });

  /* ---------- 1:1 envelopes ---------- */

  on("send", async (payload: unknown, cb: unknown) => {
    const reply = ack<SendResult>(cb);
    if (!isActive()) return reply({ ok: false, error: "device not active" });
    const parsed = sendSchema.safeParse(payload);
    if (!parsed.success) return reply({ ok: false, error: "invalid payload" });
    const { messages, sealed, ephemeral, push } = parsed.data;

    const allowed = await redis.incr(`rl:send:${deviceId}:${Math.floor(Date.now() / 10000)}`);
    if (allowed === 1) await redis.expire(`rl:send:${deviceId}:${Math.floor(Date.now() / 10000)}`, 11);
    if (allowed > 300) return reply({ ok: false, error: "rate limited" });

    const recipients = [...new Set(messages.map((m) => m.userId))];
    const devices = await activeDevices(recipients);
    // Device-list consistency (like Signal's 409/410): every active device must be covered exactly.
    const expected = devices.filter((d) => d.id !== deviceId);
    const provided = new Map(messages.map((m) => [m.deviceId, m]));
    const missing = expected.filter((d) => !provided.has(d.id)).map((d) => ({ userId: d.userId, deviceId: d.id }));
    const extra = messages.filter((m) => !expected.some((d) => d.id === m.deviceId)).map((m) => ({ userId: m.userId, deviceId: m.deviceId }));
    if (!ephemeral && (missing.length || extra.length)) return reply({ ok: false, error: "mismatched", missing, extra });
    const stale = expected
      .filter((d) => provided.has(d.id) && provided.get(d.id)!.registrationId !== d.registrationId)
      .map((d) => ({ userId: d.userId, deviceId: d.id }));
    if (!ephemeral && stale.length) return reply({ ok: false, error: "stale", stale });

    // Messages from users the recipient blocked are silently dropped (the sender isn't told).
    const blocked = await blockedBy(recipients.filter((r) => r !== userId), userId);
    const deliver = messages.filter((m) => !blocked.has(m.userId) && expected.some((d) => d.id === m.deviceId));
    const ts = Date.now();

    if (ephemeral) {
      for (const m of deliver) {
        io.to(rooms.device(m.deviceId)).emit("envelope", {
          id: `e${ts}`,
          type: m.type,
          content: m.content,
          ts,
          sealed,
          ephemeral: true,
          senderUserId: sealed ? null : userId,
          senderDeviceId: sealed ? null : deviceId,
        });
      }
      return reply({ ok: true, ts });
    }

    if (deliver.length) {
      const rows = await getDb()
        .insert(schema.envelope)
        .values(
          deliver.map((m) => ({
            recipientDeviceId: m.deviceId,
            type: m.type,
            content: Buffer.from(m.content, "base64"),
            sealed,
            senderUserId: sealed ? null : userId,
            senderDeviceId: sealed ? null : deviceId,
          })),
        )
        .returning({ id: schema.envelope.id, deviceId: schema.envelope.recipientDeviceId });
      rows.forEach((r, i) => {
        const m = deliver[i];
        io.to(rooms.device(r.deviceId)).emit("envelope", {
          id: String(r.id),
          type: m.type,
          content: m.content,
          ts,
          sealed,
          senderUserId: sealed ? null : userId,
          senderDeviceId: sealed ? null : deviceId,
        });
      });
      const otherUserDevices = rows.filter((r, i) => deliver[i].userId !== userId).map((r) => r.deviceId);
      if (push !== "silent" && otherUserDevices.length) {
        await enqueuePush({ kind: push === "reaction" ? "reaction" : push === "call" ? "call" : "message", deviceIds: otherUserDevices });
      }
    }
    reply({ ok: true, ts });
  });

  /** Pull queued envelopes (after reconnect). Client acks after durable processing. */
  on("pull", async (payload: unknown, cb: unknown) => {
    const after = Number((payload as { after?: number })?.after ?? 0) || 0;
    const rows = await getSql()<{ id: number; type: number; content: Buffer; sealed: boolean; sender_user_id: string | null; sender_device_id: string | null; created_at: Date }[]>`
      select id, type, content, sealed, sender_user_id, sender_device_id, created_at from envelope
      where recipient_device_id = ${deviceId} and id > ${after} order by id limit 200`;
    ack<unknown>(cb)({
      envelopes: rows.map((r) => ({
        id: String(r.id),
        type: r.type,
        content: r.content.toString("base64"),
        ts: new Date(r.created_at).getTime(),
        sealed: r.sealed,
        senderUserId: r.sender_user_id,
        senderDeviceId: r.sender_device_id,
      })),
      more: rows.length === 200,
    });
  });

  on("ack", async (payload: unknown) => {
    const ids = z.array(z.string().regex(/^\d+$/)).max(1000).safeParse(payload);
    if (!ids.success || !ids.data.length) return;
    await getDb()
      .delete(schema.envelope)
      .where(and(eq(schema.envelope.recipientDeviceId, deviceId), inArray(schema.envelope.id, ids.data.map(Number))));
  });

  /* ---------- groups & channels ---------- */

  const groupSendSchema = z.object({
    chatId: z.string().max(64),
    id: z.string().uuid(),
    ciphertext: z.string().max(3_000_000),
    kind: z.enum(["message", "event"]),
    /** coarse class used for permission checks only (sendMedia / sendPolls) */
    contentClass: z.enum(["text", "media", "poll", "other"]).default("text"),
    mentions: z.array(z.string().max(64)).max(50).default([]),
    deleteIds: z.array(z.string().max(64)).max(100).optional(),
    editOf: z.string().max(64).optional(),
    silent: z.boolean().optional(),
  });

  on("group:send", async (payload: unknown, cb: unknown) => {
    const reply = ack<{ ok: boolean; seq?: number; ts?: number; error?: string; retryAfter?: number }>(cb);
    if (!isActive()) return reply({ ok: false, error: "device not active" });
    const p = groupSendSchema.safeParse(payload);
    if (!p.success) return reply({ ok: false, error: "invalid payload" });
    const msg = p.data;
    const db = getDb();
    const [chat] = await db.select().from(schema.chat).where(eq(schema.chat.id, msg.chatId));
    const [member] = await db
      .select()
      .from(schema.chatMember)
      .where(and(eq(schema.chatMember.chatId, msg.chatId), eq(schema.chatMember.userId, userId)));
    if (!chat || !member) return reply({ ok: false, error: "not a member" });
    const r = rights(member);
    const isAdmin = member.role !== "member";
    const perms = { ...DEFAULT_MEMBER_PERMISSIONS, ...(chat.defaultPermissions as Record<string, boolean>) };
    const tag = senderTag(userId, chat.id);

    if (msg.kind === "message") {
      if (chat.type === "channel" && !r.postMessages) return reply({ ok: false, error: "only admins can post in channels" });
      if (!isAdmin) {
        if (!perms.sendMessages) return reply({ ok: false, error: "sending is restricted" });
        if (msg.contentClass === "media" && !perms.sendMedia) return reply({ ok: false, error: "media is restricted" });
        if (msg.contentClass === "poll" && !perms.sendPolls) return reply({ ok: false, error: "polls are restricted" });
        if (chat.slowModeSeconds > 0 && member.lastPostAt) {
          const wait = member.lastPostAt.getTime() + chat.slowModeSeconds * 1000 - Date.now();
          if (wait > 0) return reply({ ok: false, error: "slow mode", retryAfter: Math.ceil(wait / 1000) });
        }
      }
    }

    if (msg.deleteIds?.length) {
      const targets = await db
        .select({ id: schema.groupMessage.id, tag: schema.groupMessage.senderTag })
        .from(schema.groupMessage)
        .where(and(eq(schema.groupMessage.chatId, chat.id), inArray(schema.groupMessage.id, msg.deleteIds)));
      if (targets.some((t) => t.tag !== tag) && !r.deleteMessages) return reply({ ok: false, error: "cannot delete others' messages" });
      if (targets.length) {
        await db.delete(schema.groupMessage).where(inArray(schema.groupMessage.id, targets.map((t) => t.id)));
        await db.delete(schema.pinnedMessage).where(and(eq(schema.pinnedMessage.chatId, chat.id), inArray(schema.pinnedMessage.messageId, targets.map((t) => t.id))));
      }
    }
    if (msg.editOf) {
      const [orig] = await db.select().from(schema.groupMessage).where(and(eq(schema.groupMessage.id, msg.editOf), eq(schema.groupMessage.chatId, chat.id)));
      if (!orig || orig.senderTag !== tag) return reply({ ok: false, error: "can only edit own messages" });
      if (Date.now() - orig.createdAt.getTime() > EDIT_WINDOW_MS) return reply({ ok: false, error: "edit window expired" });
      await db.update(schema.groupMessage).set({ editedAt: new Date() }).where(eq(schema.groupMessage.id, orig.id));
    }

    const [{ seq }] = await getSql()<{ seq: number }[]>`update chat set last_seq = last_seq + 1, updated_at = now() where id = ${chat.id} returning last_seq::int as seq`;
    try {
      await db.insert(schema.groupMessage).values({
        id: msg.id,
        chatId: chat.id,
        seq,
        senderTag: tag,
        ciphertext: Buffer.from(msg.ciphertext, "base64"),
        kind: msg.kind,
        deleteIds: msg.deleteIds?.length ? msg.deleteIds : null,
      });
    } catch {
      return reply({ ok: false, error: "duplicate message id" });
    }
    if (msg.kind === "message") {
      await db
        .update(schema.chatMember)
        .set({ lastPostAt: new Date() })
        .where(and(eq(schema.chatMember.chatId, chat.id), eq(schema.chatMember.userId, userId)));
    }
    const ts = Date.now();
    io.to(rooms.chat(chat.id)).emit("group:message", {
      id: msg.id,
      chatId: chat.id,
      seq,
      ciphertext: msg.ciphertext,
      ts,
      kind: msg.kind,
      deleteIds: msg.deleteIds,
      editOf: msg.editOf,
      views: chat.type === "channel" ? 0 : undefined,
    });
    if (msg.kind === "message" && !msg.silent) {
      await enqueuePush({ kind: chat.type === "channel" ? "channel" : "group", chatId: chat.id, senderId: userId, mentions: msg.mentions });
    } else if (msg.mentions.length) {
      await enqueuePush({ kind: "mention", chatId: chat.id, senderId: userId, mentions: msg.mentions, reaction: true });
    }
    reply({ ok: true, seq, ts });
  });

  /** Ephemeral group signals (typing indicators) — encrypted with the sender key, never stored. */
  on("group:ephemeral", async (payload: unknown) => {
    const p = z.object({ chatId: z.string().max(64), ciphertext: z.string().max(20000) }).safeParse(payload);
    if (!p.success || !socket.rooms.has(rooms.chat(p.data.chatId))) return;
    socket.to(rooms.chat(p.data.chatId)).emit("group:ephemeral", { chatId: p.data.chatId, ciphertext: p.data.ciphertext });
  });

  /** Missed group messages since cursors (chatId → last seen seq). */
  on("group:sync", async (payload: unknown, cb: unknown) => {
    const p = z.record(z.string(), z.number()).safeParse(payload);
    if (!p.success) return ack<unknown>(cb)({ messages: [] });
    const db = getDb();
    const memberships = await db.select().from(schema.chatMember).where(eq(schema.chatMember.userId, userId));
    const out: unknown[] = [];
    const sql = getSql();
    for (const m of memberships) {
      const [chat] = await db.select({ type: schema.chat.type, lastSeq: schema.chat.lastSeq }).from(schema.chat).where(eq(schema.chat.id, m.chatId));
      const floor = chat.type === "channel" ? 0 : m.joinedSeq;
      const cursor = Math.max(p.data[m.chatId] ?? floor, floor);
      if (chat.lastSeq <= cursor) continue;
      const rows = await sql<{ id: string; seq: number; ciphertext: Buffer; created_at: Date; kind: string; view_count: number; edited_at: Date | null; delete_ids: string[] | null }[]>`
        select id, seq::int, ciphertext, created_at, kind, view_count, edited_at, delete_ids from group_message
        where chat_id = ${m.chatId} and seq > ${cursor} order by seq limit 500`;
      for (const r of rows) {
        out.push({
          id: r.id,
          chatId: m.chatId,
          seq: r.seq,
          ciphertext: r.ciphertext.toString("base64"),
          ts: new Date(r.created_at).getTime(),
          kind: r.kind,
          deleteIds: r.delete_ids ?? undefined,
          editedAt: r.edited_at ? new Date(r.edited_at).getTime() : null,
          views: chat.type === "channel" ? r.view_count : undefined,
        });
      }
    }
    ack<unknown>(cb)({ messages: out });
  });

  on("disconnect", async () => {
    await setOnline(userId, deviceId, false).catch((e) => console.error("[presence]", e));
  });

  // Async setup runs only after every handler is registered, so early client requests aren't lost.
  void (async () => {
    if (isActive()) await joinChats();
    await setOnline(userId, deviceId, true);
  })().catch((e) => console.error("[connect]", e));
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

http.listen(PORT, () => console.log(`[chat-ws] listening on :${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    io.close();
    process.exit(0);
  });
}
