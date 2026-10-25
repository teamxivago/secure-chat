import Redis from "ioredis";
import { getDb, getSql, schema, and, eq, inArray, isNotNull } from "@veil/database";
import { shouldNotify, type GlobalSettings, type ScopePref } from "./policy";
import { sendApns, sendFcm, sendWeb, type PushMessage, type SendOutcome } from "./transports";

/**
 * push-service: consumes jobs from Redis and delivers FCM / APNs / Web Push notifications.
 * Notification text never contains message content (the server doesn't have it):
 *  - 1:1 (sealed sender): "New message" — the server cannot know who sent it.
 *  - groups: "<Sender>: New message" in <Group>; mentions: "@user mentioned you in <Group>".
 */

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

interface Job {
  kind: "message" | "group" | "channel" | "mention" | "reaction" | "call" | "call_cancel" | "system";
  userIds?: string[];
  deviceIds?: string[];
  chatId?: string;
  senderId?: string;
  mentions?: string[];
  title?: string;
  body?: string;
  data?: Record<string, string>;
  callId?: string;
  video?: boolean;
  reaction?: boolean;
}

type DeviceRow = { id: string; userId: string; pushToken: string | null; pushPlatform: string | null; voipToken: string | null };

async function onlineDevices(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const flags = await redis.mget(ids.map((i) => `online:device:${i}`));
  return new Set(ids.filter((_, i) => flags[i]));
}

async function badgeFor(deviceIds: string[]): Promise<Map<string, number>> {
  if (!deviceIds.length) return new Map();
  const rows = await getSql()<{ d: string; n: number }[]>`
    select recipient_device_id as d, count(*)::int as n from envelope where recipient_device_id = any(${deviceIds}) group by 1`;
  return new Map(rows.map((r) => [r.d, r.n]));
}

async function deliver(devices: DeviceRow[], base: Omit<PushMessage, "token" | "platform">, opts: { includeOnline?: boolean } = {}) {
  const withTokens = devices.filter((d) => d.pushToken || (base.voip && d.voipToken));
  if (!withTokens.length) return;
  const online = opts.includeOnline ? new Set<string>() : await onlineDevices(withTokens.map((d) => d.id));
  const targets = withTokens.filter((d) => !online.has(d.id));
  if (!targets.length) return;
  const badges = await badgeFor(targets.map((d) => d.id));
  const fcm: { d: DeviceRow; m: PushMessage }[] = [];
  const results: Promise<[DeviceRow, SendOutcome, boolean]>[] = [];
  for (const d of targets) {
    const useVoip = !!base.voip && !!d.voipToken;
    const m: PushMessage = { ...base, voip: useVoip, token: useVoip ? d.voipToken! : d.pushToken!, platform: (d.pushPlatform as PushMessage["platform"]) ?? "fcm", badge: badges.get(d.id) ?? base.badge };
    if (useVoip || m.platform === "apns") results.push(sendApns(m).then((r) => [d, r, useVoip]));
    else if (m.platform === "web") results.push(sendWeb(m).then((r) => [d, r, false]));
    else fcm.push({ d, m });
  }
  if (fcm.length) {
    const r = await sendFcm(fcm.map((f) => f.m));
    r.forEach((o, i) => results.push(Promise.resolve([fcm[i].d, o, false])));
  }
  const db = getDb();
  for (const [d, outcome, voip] of await Promise.all(results)) {
    if (outcome === "invalid") {
      await db.update(schema.device).set(voip ? { voipToken: null } : { pushToken: null, pushPlatform: null }).where(eq(schema.device.id, d.id));
    }
  }
}

const deviceCols = { id: schema.device.id, userId: schema.device.userId, pushToken: schema.device.pushToken, pushPlatform: schema.device.pushPlatform, voipToken: schema.device.voipToken };

async function globals(userIds: string[]) {
  if (!userIds.length) return new Map<string, GlobalSettings | null>();
  const rows = await getDb().select({ id: schema.user.id, s: schema.user.notificationSettings }).from(schema.user).where(inArray(schema.user.id, userIds));
  return new Map(rows.map((r) => [r.id, r.s as GlobalSettings | null]));
}

async function handleDirect(job: Job) {
  const db = getDb();
  const devices = (await db
    .select(deviceCols)
    .from(schema.device)
    .where(and(inArray(schema.device.id, job.deviceIds ?? []), eq(schema.device.status, "active")))) as DeviceRow[];
  const g = await globals([...new Set(devices.map((d) => d.userId))]);
  const allowed = devices.filter((d) => shouldNotify({ kind: job.kind as "message", mentioned: false, global: g.get(d.userId) }));
  const isCall = job.kind === "call";
  await deliver(allowed, {
    title: "Veil",
    body: isCall ? "Incoming call" : job.kind === "reaction" ? "New reaction" : "New message",
    data: { type: job.kind },
    priority: "high",
    collapseKey: isCall ? "call" : "messages",
    voip: isCall,
    ttlSec: isCall ? 45 : 86400 * 7,
  });
}

async function handleChat(job: Job) {
  const db = getDb();
  const [chat] = await db.select().from(schema.chat).where(eq(schema.chat.id, job.chatId!));
  if (!chat) return;
  const [sender] = job.senderId ? await db.select({ name: schema.user.name, username: schema.user.username }).from(schema.user).where(eq(schema.user.id, job.senderId)) : [];
  const mentions = new Set(job.mentions ?? []);
  const typeScope = chat.type === "channel" ? "channels" : "groups";
  const sql = getSql();
  let after = "";
  // Page through members so very large groups don't load at once.
  for (;;) {
    const members = await sql<{ user_id: string; mode: string | null; muted_until: Date | string | null; tmode: string | null; tmuted: Date | string | null; settings: GlobalSettings | null }[]>`
      select m.user_id, p.mode, p.muted_until, t.mode as tmode, t.muted_until as tmuted, u.notification_settings as settings
      from chat_member m
      join "user" u on u.id = m.user_id
      left join notification_preference p on p.user_id = m.user_id and p.scope = ${chat.id}
      left join notification_preference t on t.user_id = m.user_id and t.scope = ${typeScope}
      where m.chat_id = ${chat.id} and m.user_id > ${after} ${job.senderId ? sql`and m.user_id <> ${job.senderId}` : sql``}
      order by m.user_id limit 5000`;
    if (!members.length) break;
    after = members[members.length - 1].user_id;
    const recipients = members.filter((m) => {
      const mentioned = mentions.has(m.user_id);
      if (job.kind === "mention" && !mentioned) return false;
      const pref = (mode: string | null, mu: Date | string | null): ScopePref | null => (mode ? { mode: mode as ScopePref["mode"], mutedUntil: mu ? new Date(mu).getTime() : null } : null);
      return shouldNotify({
        kind: job.kind === "mention" ? "mention" : (chat.type as "group" | "channel"),
        mentioned,
        chatPref: pref(m.mode, m.muted_until),
        typeDefault: pref(m.tmode, m.tmuted),
        global: m.settings,
      });
    });
    if (recipients.length) {
      const devices = (await db
        .select(deviceCols)
        .from(schema.device)
        .where(and(inArray(schema.device.userId, recipients.map((r) => r.user_id)), eq(schema.device.status, "active"), isNotNull(schema.device.pushToken)))) as DeviceRow[];
      const byMention = devices.filter((d) => mentions.has(d.userId));
      const rest = devices.filter((d) => !mentions.has(d.userId));
      const senderLabel = chat.type === "channel" && !chat.signMessages ? null : sender?.name;
      if (byMention.length) {
        await deliver(byMention, {
          title: chat.title,
          body: job.reaction ? `${sender?.name ?? "Someone"} reacted to your message` : `@${sender?.username ?? sender?.name ?? "someone"} mentioned you in ${chat.title}`,
          data: { type: "mention", chatId: chat.id },
          priority: "high",
          collapseKey: chat.id,
        });
      }
      if (rest.length && job.kind !== "mention") {
        await deliver(rest, {
          title: chat.title,
          body: senderLabel ? `${senderLabel}: New message` : chat.type === "channel" ? "New post" : "New message",
          data: { type: chat.type, chatId: chat.id },
          priority: chat.type === "channel" ? "normal" : "high",
          collapseKey: chat.id,
        });
      }
    }
    if (members.length < 5000) break;
  }
}

async function handleUsers(job: Job) {
  const db = getDb();
  const devices = (await db
    .select(deviceCols)
    .from(schema.device)
    .where(and(inArray(schema.device.userId, job.userIds ?? []), eq(schema.device.status, "active")))) as DeviceRow[];
  if (job.kind === "call") {
    await deliver(devices, { title: job.title ?? "Incoming call", body: job.body ?? (job.video ? "Video call" : "Voice call"), data: { type: "call", callId: job.callId ?? "", ...(job.data ?? {}) }, priority: "high", voip: true, collapseKey: `call-${job.callId}`, ttlSec: 45 });
    return;
  }
  if (job.kind === "call_cancel") {
    await deliver(devices, { data: { type: "call_cancel", callId: job.callId ?? "" }, priority: "high", collapseKey: `call-${job.callId}`, ttlSec: 45 }, { includeOnline: true });
    return;
  }
  const g = await globals(job.userIds ?? []);
  await deliver(
    devices.filter((d) => shouldNotify({ kind: "system", mentioned: false, global: g.get(d.userId) })),
    { title: job.title ?? "Veil", body: job.body ?? "", data: { type: "system", ...(job.data ?? {}) }, priority: "normal" },
  );
}

async function handle(job: Job) {
  if (job.deviceIds?.length && ["message", "reaction", "call"].includes(job.kind)) return handleDirect(job);
  if (job.chatId && ["group", "channel", "mention"].includes(job.kind)) return handleChat(job);
  if (job.userIds?.length) return handleUsers(job);
}

async function loop() {
  const blocking = redis.duplicate();
  console.log("[push-service] waiting for jobs");
  for (;;) {
    try {
      const r = await blocking.brpop("push:queue", 5);
      if (!r) continue;
      await handle(JSON.parse(r[1]) as Job).catch((e) => console.error("[push] job failed", e));
    } catch (e) {
      console.error("[push] queue error", e);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

void loop();
