import { io, type Socket } from "socket.io-client";
import { bus } from "./bus";
import { ctx } from "./context";
import { trace } from "../lib/trace";

/**
 * Socket.IO connection to chat-ws with an ordered processing queue: envelopes are handled
 * strictly in arrival order (ratchet state depends on it) and acknowledged only after the
 * result is durably stored.
 */

let socket: Socket | null = null;
type ConnState = "connecting" | "online" | "offline" | "syncing";
let connState: ConnState = "connecting";
export const connectionState = () => connState;
function setConn(state: ConnState) {
  connState = state;
  bus.emit("connection", { state });
}
let queue: Promise<unknown> = Promise.resolve();
const handlers: Record<string, (data: unknown) => unknown> = {};
let onConnectHook: (() => Promise<void>) | null = null;

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const run = () => {
    const waited = Date.now() - queuedAt;
    if (waited > 50) trace("queue:waited", waited);
    return fn();
  };
  const p = queue.then(run, run);
  queue = p.catch((e) => console.error("[queue]", e));
  return p;
}

export function on(event: string, fn: (data: unknown) => unknown, ordered = true) {
  handlers[event] = ordered
    ? (d) => {
        if (event === "envelope") trace("socket:envelope");
        return enqueue(async () => fn(d));
      }
    : fn;
  socket?.off(event);
  socket?.on(event, handlers[event]);
}

export function setOnConnect(fn: () => Promise<void>) {
  onConnectHook = fn;
}

export function connect() {
  if (socket || !ctx.account?.token || !ctx.config) return;
  setConn("connecting");
  socket = io(ctx.config.chatWsUrl, {
    auth: (cb) => cb({ token: ctx.account?.token }),
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 8000,
    timeout: 10000,
  });
  for (const [ev, h] of Object.entries(handlers)) socket.on(ev, h);
  socket.on("connect", () => {
    setConn("syncing");
    enqueue(async () => {
      try {
        await onConnectHook?.();
      } finally {
        setConn(socket?.connected ? "online" : "offline");
      }
    });
  });
  socket.on("disconnect", () => setConn("offline"));
  socket.on("connect_error", (e) => {
    setConn("offline");
    if (e.message === "unauthorized") console.warn("[ws] unauthorized");
  });
}

export function disconnect() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

export const connected = () => !!socket?.connected;

export function emit(event: string, payload?: unknown) {
  socket?.emit(event, payload);
}

export function request<T>(event: string, payload: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("offline"));
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    socket.emit(event, payload, (r: T) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}
