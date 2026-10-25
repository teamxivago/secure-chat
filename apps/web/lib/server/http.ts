import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z, type ZodType } from "zod";
import { verifySessionToken, type AuthedDevice } from "@veil/database";
import { rateLimit } from "./redis";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const json = (data: unknown, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

function tokenFrom(req: Request): string | null {
  const authz = req.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) return authz.slice(7).trim();
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return m ? m[1] : null;
}

export interface Ctx extends AuthedDevice {
  ip: string;
}

export async function authenticate(req: Request, opts: { requireActiveDevice?: boolean } = {}): Promise<Ctx> {
  const a = await verifySessionToken(tokenFrom(req));
  if (!a) throw new HttpError(401, "unauthorized");
  if (opts.requireActiveDevice && (a.deviceStatus !== "active" || !a.deviceId)) {
    throw new HttpError(403, "device not active");
  }
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0";
  return { ...a, ip };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, "validation failed", { issues: z.treeifyError(r.error) });
  return r.data;
}

export async function limit(key: string, max: number, windowSec: number) {
  if (!(await rateLimit(key, max, windowSec))) throw new HttpError(429, "too many requests");
}

type Handler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

/** Wraps a route handler with uniform error handling. */
export function route<P = Record<string, string>>(fn: Handler<P>): Handler<P> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error("[api]", req.method, req.nextUrl.pathname, e);
      return json({ error: "internal error" }, 500);
    }
  };
}
