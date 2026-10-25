import "server-only";
import Redis from "ioredis";
import { Emitter } from "@socket.io/redis-emitter";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __veilRedis: Redis | undefined;
  // eslint-disable-next-line no-var
  var __veilEmitter: Emitter | undefined;
}

export function redis(): Redis {
  if (!globalThis.__veilRedis) globalThis.__veilRedis = new Redis(env.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  return globalThis.__veilRedis;
}

/** Emits to Socket.IO rooms on the chat-ws cluster via the Redis adapter channel. */
export function emitter(): Emitter {
  if (!globalThis.__veilEmitter) globalThis.__veilEmitter = new Emitter(redis());
  return globalThis.__veilEmitter;
}

export const rooms = {
  user: (id: string) => `user:${id}`,
  device: (id: string) => `device:${id}`,
  chat: (id: string) => `chat:${id}`,
};

/** Fixed-window rate limiter. Returns true when the request is allowed. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, windowSec + 1);
  return n <= limit;
}

export interface PushJob {
  kind: "message" | "group" | "mention" | "reaction" | "call" | "call_cancel" | "system" | "channel";
  userIds?: string[];
  deviceIds?: string[];
  chatId?: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
  excludeDeviceIds?: string[];
}

export async function enqueuePush(job: PushJob) {
  await redis().lpush("push:queue", JSON.stringify(job));
}
