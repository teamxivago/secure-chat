import { NextResponse } from "next/server";
import { env } from "@/lib/server/env";
import { redis } from "@/lib/server/redis";

/** Test-only helper (DEV_EXPOSE_OTP=1 and NODE_ENV!=production). Returns 404 otherwise. */
export async function GET(req: Request) {
  if (!env.devOtpEnabled) return new NextResponse(null, { status: 404 });
  const to = new URL(req.url).searchParams.get("to") ?? "";
  return NextResponse.json({ code: await redis().get(`devotp:${to.toLowerCase()}`) });
}
